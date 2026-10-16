import {
  assertIncrementalLookbackSeconds,
  createRawEvidenceRecord,
  assertPluginManifest,
  sha256,
  sourceTimestampMillis,
} from "@tkl/contracts";
import { isHttpUrl, isProductionSafeUrl, normalizeBaseUrl } from "./http.js";
import { DEFAULT_GITHUB_WEB_URL } from "./github-http-client.js";

export { createGitHubHttpClient, DEFAULT_GITHUB_API_URL, DEFAULT_GITHUB_WEB_URL, GitHubHttpError } from "./github-http-client.js";

export const githubManifest = assertPluginManifest({
  id: "connector.github",
  version: "0.1.0",
  contractVersion: "0.1.0",
  capabilities: ["pull-request-read", "changed-files-read", "test-read", "incremental-sync"],
  requiredPermissions: ["github.repository.read"],
});

const transient = new Set([408, 425, 429, 500, 502, 503, 504]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitWithSignal = (milliseconds, signal) => {
  if (!signal) return wait(milliseconds);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};
const callClient = (client, method, args, signal) => signal
  ? client[method](...args, { signal })
  : client[method](...args);
// A no-op default so injecting a logger is always optional and never
// changes behavior for existing callers/tests.
const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class GitHubConnector {
  constructor({
    client,
    tenantId,
    productId,
    credentialRef,
    repository,
    incrementalLookbackSeconds,
    webBaseUrl,
    allowInsecureLoopback = false,
    maxRetries = 2,
    now = () => new Date().toISOString(),
    logger = NOOP_LOGGER,
  }) {
    if (!client || typeof client.fetchPullRequests !== "function") throw new TypeError("GitHub client with fetchPullRequests is required");
    this.client = client;
    this.tenantId = tenantId;
    this.productId = productId;
    this.credentialRef = credentialRef;
    this.logger = logger;
    this.repository = repository;
    this.incrementalLookbackSeconds =
      assertIncrementalLookbackSeconds(incrementalLookbackSeconds);
    // Evidence `sourceUrl` links use an explicitly configured, validated
    // web host: an explicit connector-level `webBaseUrl` takes priority --
    // and, because it is used verbatim to build evidence links, it is
    // validated with the same HTTPS/loopback safety rules as the HTTP
    // client rather than trusted as-is -- then the HTTP client's own
    // already-validated `webBaseUrl` metadata (immutable, safe to trust
    // without re-validation; relevant for GitHub Enterprise Server, whose
    // web UI host differs from its API host), and finally the github.com
    // default for backward compatibility with existing configuration that
    // sets neither.
    const explicitWebBaseUrl = normalizeBaseUrl(webBaseUrl);
    if (explicitWebBaseUrl) {
      if (!isHttpUrl(explicitWebBaseUrl)) throw new TypeError("webBaseUrl must be a valid HTTP(S) URL");
      if (!isProductionSafeUrl(explicitWebBaseUrl, { allowInsecureLoopback })) {
        throw new TypeError(
          "webBaseUrl must use HTTPS in production; set allowInsecureLoopback: true only for local "
          + "loopback (localhost/127.0.0.1/[::1]) development or test HTTP endpoints",
        );
      }
    }
    this.webBaseUrl = explicitWebBaseUrl || normalizeBaseUrl(client?.webBaseUrl) || DEFAULT_GITHUB_WEB_URL;
    this.maxRetries = maxRetries;
    this.now = now;
    this.metrics = { records: 0, retries: 0, failures: 0, lastSyncAt: null };
  }


  async validateConfiguration() {
    const errors = [];
    if (!this.tenantId) errors.push("tenantId is required");
    if (!this.productId) errors.push("productId is required");
    if (!this.repository) errors.push("repository is required");
    if (!this.credentialRef) errors.push("credentialRef is required");
    return { valid: errors.length === 0, errors };
  }

  /**
   * Emits a sanitized, structured event to the injected logger (a no-op by
   * default). Never includes the resolved credential value, record
   * payloads, or a raw error/message -- only identifiers, counts, and the
   * same status/Retry-After metadata already treated as safe to surface.
   * A throwing logger must never break a sync, so this is always
   * best-effort.
   */
  logEvent(eventType, fields = {}) {
    try {
      this.logger.info?.({
        eventType,
        pluginId: githubManifest.id,
        tenantId: this.tenantId,
        productId: this.productId,
        ...fields,
      });
    } catch {
      // Swallow: a broken logging sink must never turn a working sync into a failure.
    }
  }

  async call(operation, signal) {
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      try { return await operation(); } catch (error) {
        signal?.throwIfAborted();
        const retryAfter = Number(error?.retryAfter ?? error?.headers?.["retry-after"] ?? error?.headers?.["Retry-After"]);
        if (attempt >= this.maxRetries || (error.status !== undefined && !transient.has(error.status))) {
          this.metrics.failures += 1;
          this.logEvent("connector.failure", { status: error.status ?? null, attempt, lastCheckpoint: this.metrics.lastCheckpoint ?? null });
          throw error;
        }
        this.metrics.retries += 1;
        this.logEvent("connector.retry", { status: error.status ?? null, attempt, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null });
        const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 10 * 2 ** attempt;
        await waitWithSignal(Math.min(waitMs, 30_000), signal);
      }
    }
  }

  async *collect(checkpoint = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    this.logEvent("connector.sync.start", { resumedFromCheckpoint: Object.keys(checkpoint).length > 0 });
    this.initializeIncrementalState(checkpoint);
    // Pull requests are ordered by most recently updated. Restart from the
    // first page on every resume so an updated PR cannot move ahead of a
    // persisted cursor and be skipped permanently. Replayed records remain
    // safe because their idempotency keys are deterministic.
    let page = 0;
    while (true) {
      const result = await this.call(
        () => callClient(this.client, "fetchPullRequests", [this.repository, page], signal),
        signal,
      );
      const items = Array.isArray(result) ? result : (result.items ?? []);
      let pageEntirelyOlder =
        this.incrementalCutoffMillis !== null && items.length > 0;
      for (const pullRequest of items) {
        const number = String(pullRequest.number);
        // GitHub's production REST API returns `updated_at` (snake_case);
        // `updatedAt` is kept only as a compatibility fallback for
        // injected/legacy test clients that use a camelCase shape.
        const pullRequestVersion = pullRequest.updated_at ?? pullRequest.updatedAt ?? "unknown";
        const sourceTimestamp = pullRequest.updated_at ?? pullRequest.updatedAt;
        const timestamp = sourceTimestampMillis(sourceTimestamp);
        if (timestamp === null || timestamp >= this.incrementalCutoffMillis) {
          pageEntirelyOlder = false;
        }
        const shouldEmit = this.shouldEmitSourceTimestamp(sourceTimestamp);
        if (shouldEmit) {
          yield this.record("pull_request", `${this.repository}#${number}`, pullRequestVersion, pullRequest);
        }
        this.metrics.lastCheckpoint = this.withSourceWatermark({
          phase: "pull_requests",
          page,
          pullRequest: number,
        });
        if (shouldEmit && typeof this.client.fetchChangedFiles === "function") {
          // Changed-file lists can also shift while a PR is updated. Replay
          // them from the beginning and let the evidence store deduplicate.
          let filePage = 0;
          while (true) {
            const fileResult = await this.call(
              () => callClient(
                this.client,
                "fetchChangedFiles",
                [this.repository, number, filePage],
                signal,
              ),
              signal,
            );
            const files = Array.isArray(fileResult) ? fileResult : (fileResult.items ?? []);
            for (const file of files) {
              yield this.record("changed_file", `${this.repository}#${number}:${file.filename}`, pullRequestVersion, file);
            }
            this.metrics.lastCheckpoint = this.withSourceWatermark({
              phase: "changed_files",
              page,
              pullRequest: number,
              filePage: fileResult?.nextPage ?? filePage,
            });
            if (Array.isArray(fileResult) || !fileResult?.nextPage) break;
            filePage = fileResult.nextPage;
          }
        }
      }
      if (pageEntirelyOlder) break;
      if (Array.isArray(result) || !result.nextPage) break;
      page = result.nextPage;
    }
    if (this.metrics.lastCheckpoint) {
      this.metrics.lastCheckpoint = this.withSourceWatermark(this.metrics.lastCheckpoint, true);
    }
    this.metrics.lastSyncAt = this.now();
    this.logEvent("connector.sync.complete", {
      records: this.metrics.records,
      retries: this.metrics.retries,
      failures: this.metrics.failures,
      lastCheckpoint: this.metrics.lastCheckpoint ?? null,
    });
  }

  async *collectPullRequestsByIssue(
    issueKey,
    { signal, maxPullRequests = 10, maxChangedFiles = 50, budgetState } = {}
  ) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    if (typeof issueKey !== "string" || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey)) {
      throw new TypeError("issueKey must be a valid Jira issue key");
    }
    if (!Number.isSafeInteger(maxPullRequests) || maxPullRequests < 1) {
      throw new TypeError("maxPullRequests must be a positive integer");
    }
    if (!Number.isSafeInteger(maxChangedFiles) || maxChangedFiles < 0) {
      throw new TypeError("maxChangedFiles must be a non-negative integer");
    }
    if (typeof this.client.searchPullRequestsByIssue !== "function") return;
    const normalizedKey = issueKey.toUpperCase();
    const exactReference = new RegExp(
      `(^|[^A-Z0-9_])${normalizedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Z0-9_])`,
      "i"
    );
    let page = 0;
    let pullRequests = 0;
    let changedFiles = 0;
    while (pullRequests < maxPullRequests) {
      const result = await this.call(
        () => callClient(
          this.client,
          "searchPullRequestsByIssue",
          [this.repository, normalizedKey, page],
          signal,
        ),
        signal,
      );
      const items = Array.isArray(result) ? result : (result.items ?? []);
      if (result?.incompleteResults && budgetState) budgetState.truncated = true;
      for (const pullRequest of items) {
        if (pullRequests >= maxPullRequests) {
          if (budgetState) budgetState.truncated = true;
          return;
        }
        if (!pullRequest?.pull_request) continue;
        const searchableText = `${pullRequest.title ?? ""}\n${pullRequest.body ?? ""}`;
        if (!exactReference.test(searchableText)) continue;
        const referencedIssues = [
          ...new Set(
            [...searchableText.matchAll(/\b[A-Za-z][A-Za-z0-9_]*-\d+\b/g)]
              .map((match) => match[0].toUpperCase())
          )
        ];
        pullRequests += 1;
        const number = String(pullRequest.number);
        const version = pullRequest.updated_at ?? pullRequest.updatedAt ?? "unknown";
        yield this.record(
          "pull_request",
          `${this.repository}#${number}`,
          version,
          { ...pullRequest, referencedIssues }
        );
        let filePage = 0;
        while (
          changedFiles < maxChangedFiles
          && typeof this.client.fetchChangedFiles === "function"
        ) {
          const fileResult = await this.call(
            () => callClient(
              this.client,
              "fetchChangedFiles",
              [this.repository, number, filePage],
              signal,
            ),
            signal,
          );
          const files = Array.isArray(fileResult) ? fileResult : (fileResult.items ?? []);
          for (const file of files) {
            if (changedFiles >= maxChangedFiles) break;
            changedFiles += 1;
            yield this.record(
              "changed_file",
              `${this.repository}#${number}:${file.filename}`,
              version,
              file
            );
          }
          if (files.length > 0 && changedFiles >= maxChangedFiles && budgetState) {
            budgetState.truncated = true;
          }
          if (Array.isArray(fileResult) || !fileResult?.nextPage) break;
          filePage = fileResult.nextPage;
        }
      }
      if (pullRequests >= maxPullRequests && result?.nextPage && budgetState) {
        budgetState.truncated = true;
      }
      if (Array.isArray(result) || !result?.nextPage) break;
      page = result.nextPage;
    }
  }

  record(type, sourceId, sourceVersion, payload) {
    this.metrics.records += 1;
    // `sourceId` is `{repository}#{number}` for a pull_request record, or
    // `{repository}#{number}:{filename}` for a changed_file record; the pull
    // request number is always the text before any `:` in that second
    // segment. Evidence sourceUrl always links to the human-browsable pull
    // request itself -- `/pull/{number}` for the PR record, and
    // `/pull/{number}/files` (GitHub's changed-files tab) for each of its
    // changed-file records -- never just the bare repository.
    const [repository, numberAndRest] = sourceId.split("#");
    const number = numberAndRest.split(":")[0];
    const sourceUrl = type === "changed_file"
      ? `${this.webBaseUrl}/${repository}/pull/${number}/files`
      : `${this.webBaseUrl}/${repository}/pull/${number}`;
    return createRawEvidenceRecord({
      tenantId: this.tenantId, productId: this.productId, source: "github", sourceId,
      sourceVersion: String(sourceVersion), sourceUrl,
      observedAt: this.now(), contentType: `github.${type}`, payload, classification: "internal",
      idempotencyKey: sha256(`github:${sourceId}:${sourceVersion}:${sha256(payload)}`),
    });
  }

  initializeIncrementalState(checkpoint) {
    const watermark = sourceTimestampMillis(checkpoint?.sourceWatermark);
    const candidate = sourceTimestampMillis(checkpoint?.candidateSourceWatermark);
    this.trackSourceWatermark =
      this.incrementalLookbackSeconds !== undefined
      || watermark !== null
      || candidate !== null;
    this.committedSourceWatermarkMillis = watermark;
    this.sourceWatermarkMillis = candidate === null
      ? watermark
      : Math.max(candidate, watermark ?? candidate);
    this.incrementalCutoffMillis =
      this.incrementalLookbackSeconds === undefined || watermark === null
        ? null
        : watermark - this.incrementalLookbackSeconds * 1_000;
  }

  shouldEmitSourceTimestamp(value) {
    if (!this.trackSourceWatermark) return true;
    const timestamp = sourceTimestampMillis(value);
    if (timestamp === null) return true;
    if (this.sourceWatermarkMillis === null || timestamp > this.sourceWatermarkMillis) {
      this.sourceWatermarkMillis = timestamp;
    }
    return this.incrementalCutoffMillis === null || timestamp >= this.incrementalCutoffMillis;
  }

  withSourceWatermark(checkpoint, complete = false) {
    if (!this.trackSourceWatermark || this.sourceWatermarkMillis === null) return checkpoint;
    if (complete) {
      const { candidateSourceWatermark: _ignored, ...completedCheckpoint } = checkpoint;
      return {
        ...completedCheckpoint,
        sourceWatermark: new Date(this.sourceWatermarkMillis).toISOString(),
      };
    }
    return {
      ...checkpoint,
      ...(this.committedSourceWatermarkMillis === null
        ? {}
        : { sourceWatermark: new Date(this.committedSourceWatermarkMillis).toISOString() }),
      candidateSourceWatermark: new Date(this.sourceWatermarkMillis).toISOString(),
    };
  }

  async health() {
    return { pluginId: githubManifest.id, status: this.metrics.failures ? "degraded" : "healthy", credentialRef: this.credentialRef, ...this.metrics };
  }
}
