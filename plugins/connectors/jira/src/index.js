import {
  assertPluginManifest,
  assertIncrementalLookbackSeconds,
  createRawEvidenceRecord,
  sha256,
  sourceTimestampMillis,
} from "@tkl/contracts";
import { isHttpUrl, isProductionSafeUrl, normalizeBaseUrl } from "./http.js";
import { DEFAULT_JIRA_BASE_URL } from "./jira-http-client.js";

export { createJiraHttpClient, DEFAULT_JIRA_BASE_URL, JiraHttpError } from "./jira-http-client.js";

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export const jiraManifest = assertPluginManifest({
  id: "connector.jira",
  version: "0.1.0",
  contractVersion: "0.1.0",
  capabilities: ["issue-read", "issue-search", "comment-read", "incremental-sync"],
  requiredPermissions: ["jira.issue.read"],
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const delayWithSignal = (milliseconds, signal) => {
  if (!signal) return delay(milliseconds);
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

/**
 * Returns the absolute record offset a search cursor represents, or
 * `undefined` when the cursor is a legacy page index whose offset cannot be
 * known here (the connector does not own the client's page size).
 *
 * `0` is deliberately treated as offset `0` in both shapes: page 0 and
 * offset 0 are the same position, so a run that has not paged yet compares
 * correctly against either cursor shape.
 */
function cursorOffset(cursor) {
  if (cursor === undefined || cursor === null || cursor === 0) return 0;
  if (typeof cursor === "object" && Number.isSafeInteger(cursor.startAt) && cursor.startAt >= 0) {
    return cursor.startAt;
  }
  return undefined;
}

/**
 * Decides whether the replay loop has reached (or passed) the checkpointed
 * search page, which is when comment-page resume stops applying.
 *
 * Cursors may be either the current `{ startAt }` absolute-offset shape or a
 * legacy numeric page index, and a resumed checkpoint can carry a different
 * shape than the live client emits. Offsets are compared when both sides
 * expose one; otherwise the connector falls back to counting replayed pages.
 * When the two shapes cannot be compared at all, this returns `true` (stop
 * applying comment resume), which only ever causes an issue's comments to be
 * re-collected from the start -- idempotent extra work, never a skipped
 * record.
 */
function hasReachedCheckpointPage(checkpointCursor, currentCursor, pageIndex) {
  const checkpointStartAt = cursorOffset(checkpointCursor);
  const currentStartAt = cursorOffset(currentCursor);
  if (checkpointStartAt !== undefined && currentStartAt !== undefined) {
    return currentStartAt >= checkpointStartAt;
  }
  if (checkpointStartAt === undefined && typeof checkpointCursor === "number") {
    return pageIndex >= checkpointCursor;
  }
  return true;
}

// A no-op default so injecting a logger is always optional and never
// changes behavior for existing callers/tests.
const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class JiraConnector {
  constructor({
    client,
    tenantId,
    productId,
    credentialRef,
    issueKey,
    jql,
    incrementalLookbackSeconds,
    baseUrl,
    allowInsecureLoopback = false,
    maxRetries = 2,
    now = () => new Date().toISOString(),
    logger = NOOP_LOGGER,
  }) {
    if (!client || typeof client.fetchIssue !== "function") throw new TypeError("A Jira client with fetchIssue is required");
    this.client = client;
    this.tenantId = tenantId;
    this.productId = productId;
    this.credentialRef = credentialRef;
    this.logger = logger;
    this.issueKey = issueKey;
    this.jql = typeof jql === "string" && jql.trim().length > 0 ? jql.trim() : undefined;
    // A deterministic fingerprint of the configured JQL, stamped onto every
    // search checkpoint this connector emits so a resume can detect (and
    // reject) a configuration change -- see `collect`/`collectSearch`.
    this.jqlFingerprint = this.jql ? sha256(this.jql) : undefined;
    this.incrementalLookbackSeconds =
      assertIncrementalLookbackSeconds(incrementalLookbackSeconds);
    // An explicitly configured connector-level `baseUrl` is validated with
    // the same HTTPS/loopback safety rules as the HTTP client (it is used
    // verbatim to build evidence `sourceUrl` links, so a plaintext or
    // malformed override must never be accepted). When absent, the
    // connector prefers the HTTP client's own already-validated `baseUrl`
    // metadata (immutable, safe to trust without re-validation) and only
    // falls back to the hard-coded default for legacy injected clients
    // that expose neither.
    const explicitBaseUrl = normalizeBaseUrl(baseUrl);
    if (explicitBaseUrl) {
      if (!isHttpUrl(explicitBaseUrl)) throw new TypeError("baseUrl must be a valid HTTP(S) URL");
      if (!isProductionSafeUrl(explicitBaseUrl, { allowInsecureLoopback })) {
        throw new TypeError(
          "baseUrl must use HTTPS in production; set allowInsecureLoopback: true only for local "
          + "loopback (localhost/127.0.0.1/[::1]) development or test HTTP endpoints",
        );
      }
    }
    this.baseUrl = explicitBaseUrl || normalizeBaseUrl(client?.baseUrl) || normalizeBaseUrl(DEFAULT_JIRA_BASE_URL);
    this.maxRetries = maxRetries;
    this.now = now;
    this.metrics = { records: 0, retries: 0, failures: 0, lastSyncAt: null };
  }

  async validateConfiguration() {
    const errors = [];
    if (!this.tenantId) errors.push("tenantId is required");
    if (!this.productId) errors.push("productId is required");
    if (!this.credentialRef || typeof this.credentialRef !== "string") errors.push("credentialRef is required");
    // A fixed issueKey may also come from a legacy injected client (see
    // collectIssue), so validation must not reject that configuration.
    if (!this.issueKey && !this.jql && !this.client?.issueKey) errors.push("Either issueKey or jql is required");
    return { valid: errors.length === 0, errors };
  }

  /**
   * Emits a sanitized, structured event to the injected logger (a no-op by
   * default). Never includes the resolved credential value, record
   * payloads, or a raw error/message -- only identifiers, counts, and the
   * same status/Retry-After metadata `callWithRetry` already treats as
   * safe to surface. A throwing logger must never break a sync, so this is
   * always best-effort (mirroring the DurabilityWarning pattern used
   * elsewhere in this codebase for non-fatal, caller-observable signals).
   */
  logEvent(eventType, fields = {}) {
    try {
      this.logger.info?.({
        eventType,
        pluginId: jiraManifest.id,
        tenantId: this.tenantId,
        productId: this.productId,
        ...fields,
      });
    } catch {
      // Swallow: a broken logging sink must never turn a working sync into a failure.
    }
  }

  async callWithRetry(operation, signal) {
    let attempt = 0;
    while (true) {
      signal?.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        signal?.throwIfAborted();
        const status = error?.status ?? error?.statusCode;
        const retryAfter = Number(error?.retryAfter ?? error?.headers?.["retry-after"] ?? error?.headers?.["Retry-After"]);
        if (attempt >= this.maxRetries || (status !== undefined && !TRANSIENT_STATUSES.has(status))) {
          this.metrics.failures += 1;
          this.logEvent("connector.failure", { status: status ?? null, attempt, lastCheckpoint: this.metrics.lastCheckpoint ?? null });
          throw error;
        }
        attempt += 1;
        this.metrics.retries += 1;
        this.logEvent("connector.retry", { status: status ?? null, attempt, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null });
        const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 10 * 2 ** (attempt - 1);
        await delayWithSignal(Math.min(waitMs, 30_000), signal);
      }
    }
  }

  /**
   * Collects Jira evidence starting from an optional checkpoint. When a
   * fixed `issueKey` is configured (or resumed from a checkpoint), the
   * connector preserves the legacy single-issue behavior: fetch that one
   * issue and its paginated comments. Otherwise, when a `jql` allowlisted
   * query and a client with `searchIssues` are configured, the connector
   * paginates the search results and collects comments for every matched
   * issue.
   */
  async *collect(checkpoint = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    this.logEvent("connector.sync.start", { resumedFromCheckpoint: Object.keys(checkpoint).length > 0 });
    this.initializeIncrementalState(checkpoint);

    // `mode` is the authoritative resume signal persisted by this connector
    // version: `collectSearch` stamps every checkpoint it emits (including
    // the ones produced mid-comments, deep inside `collectComments`) with
    // `mode: "search"`. Checkpoints saved before `mode` existed (legacy
    // single-issue checkpoints, which only ever carry `issueKey`/`phase`/
    // `commentPage`) omit it entirely, so resume falls back to the original
    // issueKey-presence heuristic to preserve their exact behavior. Without
    // an explicit mode, a JQL search checkpoint captured mid-comments (which
    // necessarily carries the in-flight `issueKey`) would otherwise be
    // misread as a legacy single-issue checkpoint and incorrectly resumed
    // through `collectIssue` instead of `collectSearch`. Any other explicit
    // `mode` value is not a recognized resume signal -- accepting it would
    // let an untrusted/corrupt checkpoint silently pick whichever collection
    // route it wants, so it must be rejected rather than guessed at.
    if (checkpoint.mode !== undefined && checkpoint.mode !== "search" && checkpoint.mode !== "issue") {
      throw new TypeError(`Unknown checkpoint mode "${checkpoint.mode}"`);
    }
    const canSearch = Boolean(this.jql) && typeof this.client.searchIssues === "function";
    const configuredIssueKey = this.issueKey ?? this.client.issueKey;
    // A checkpoint's `mode` must be bound to what this connector instance is
    // actually configured/scoped to collect: a JQL-only connector (no fixed
    // issueKey configured or falling back from the client) has no
    // single-issue scope to resume into, and an issue-only connector (no
    // jql/searchIssues capability configured) has no search scope to resume
    // into. Accepting either mismatch would let a stale or cross-connector
    // checkpoint silently redirect this connector into a collection path it
    // was never configured for.
    if (checkpoint.mode === "issue" && !configuredIssueKey) {
      throw new TypeError(
        'Checkpoint mode "issue" is not valid for this connector: no issueKey is configured (JQL-only connector)',
      );
    }
    if (checkpoint.mode === "search" && !canSearch) {
      throw new TypeError(
        'Checkpoint mode "search" is not valid for this connector: no jql/searchIssues is configured (issue-only connector)',
      );
    }
    const usesSearch = checkpoint.mode
      ? checkpoint.mode === "search"
      : !(checkpoint.issueKey ?? this.issueKey) && canSearch;

    if (usesSearch) {
      // A deterministic fingerprint of the configured JQL is stamped onto
      // every search checkpoint (see `collectSearch`). A resumed checkpoint
      // carrying a fingerprint that does not match the JQL this connector
      // is currently configured with means the JQL changed since the
      // checkpoint was saved -- resuming page/comment cursors against a
      // *different* query would silently skip or duplicate issues, so it
      // must be rejected rather than resumed. Checkpoints saved before this
      // field existed omit it and are still resumed (no fingerprint to
      // compare against).
      if (checkpoint.jqlFingerprint !== undefined && checkpoint.jqlFingerprint !== this.jqlFingerprint) {
        throw new TypeError(
          "Checkpoint JQL fingerprint does not match the configured JQL; the connector's JQL "
          + "changed since this checkpoint was saved",
        );
      }
      // A `mode: "search"` checkpoint must always be resumed through
      // `collectSearch`, never reinterpreted as a single-issue checkpoint,
      // even if it happens to carry an `issueKey` (search checkpoints
      // legitimately carry one for in-flight comment-page resume).
      yield* this.collectSearch(checkpoint, signal);
    } else {
      // In single-issue mode, a checkpoint's `issueKey` is only ever a
      // resume detail for the connector's own configured/fallback issue; it
      // must never be able to widen or redirect scope to a different issue
      // than the one this connector instance was configured to collect.
      if (
        checkpoint.issueKey !== undefined
        && configuredIssueKey !== undefined
        && checkpoint.issueKey !== configuredIssueKey
      ) {
        throw new TypeError(
          `Checkpoint issueKey "${checkpoint.issueKey}" does not match the configured issueKey "${configuredIssueKey}"`,
        );
      }
      yield* this.collectIssue(checkpoint, signal);
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

  async *collectIssue(checkpoint, signal) {
    const issueKey = checkpoint.issueKey ?? this.issueKey ?? this.client.issueKey;
    if (!issueKey) throw new TypeError("A Jira issue key is required");
    const issue = await this.callWithRetry(
      () => this.jql && typeof this.client.fetchIssueWithinJql === "function"
        ? callClient(this.client, "fetchIssueWithinJql", [issueKey, this.jql], signal)
        : callClient(this.client, "fetchIssue", [issueKey], signal),
      signal,
    );
    if (!issue) {
      const error = new Error("Jira issue was not found in the configured query scope.");
      error.status = 404;
      throw error;
    }
    // Native production Jira issues nest the timestamp under `fields.updated`;
    // the flat `updated`/`version` fields are compatibility fallbacks for
    // legacy fixtures/injected clients.
    const issueVersion = issue.fields?.updated ?? issue.updated ?? issue.version ?? "unknown";
    if (checkpoint.phase !== "comments" && this.shouldEmitSourceTimestamp(
      issue.fields?.updated ?? issue.updated,
    )) {
      yield this.record("issue", issueKey, issueVersion, issue);
    }
    this.metrics.lastCheckpoint = this.withSourceWatermark({ phase: "issue", issueKey });
    yield* this.collectComments(
      issueKey,
      issueVersion,
      checkpoint.phase === "comments" ? (checkpoint.commentPage ?? 0) : 0,
      {},
      signal,
    );
  }

  /**
   * Collects search results and their comments, resuming from an optional
   * in-flight checkpoint. Search result order is not guaranteed to be
   * stable across runs (issues can shift position -- including *backward*,
   * ahead of where a previous run left off, for example when a JQL sorts by
   * "most recently updated" and an older issue is touched again -- be
   * added, or be removed between the checkpointed run and this one), so
   * resume always restarts from page 0 and idempotently replays every page
   * up to and including the checkpointed page, rather than trusting that
   * page to mean "everything before it is already fully collected": that
   * assumption is exactly what would let a reordered issue move behind the
   * resume cursor and never be collected at all. This connector's
   * idempotency key de-duplicates any records re-emitted for issues that,
   * in fact, were already fully collected in the checkpointed run.
   * Comment-page resume (`commentPage`) is preserved only for the specific
   * issue matching the checkpoint's `issueKey`, wherever it now appears
   * within the replayed range (or not at all, if it shifted beyond the
   * checkpointed page or was removed); every other issue -- on any
   * replayed page, or any page beyond the checkpointed one -- has its
   * comments collected from the start.
   */
  async *collectSearch(checkpoint, signal) {
    const isSearchCheckpoint = checkpoint.mode === "search";
    const checkpointCursor = isSearchCheckpoint ? (checkpoint.page ?? 0) : 0;
    let resumeIssueKey = isSearchCheckpoint ? checkpoint.issueKey : undefined;
    const resumeCommentPage = checkpoint.commentPage ?? 0;

    // `cursor` is whatever opaque page cursor the client hands back --
    // `{ startAt }` for the HTTP client (an absolute record offset that is
    // immune to server-side `maxResults` caps) or a plain page index for a
    // legacy/injected client. `pageIndex` is only a replay counter for
    // checkpoint comparison and is never sent to Jira.
    let cursor = 0;
    let pageIndex = 0;
    while (true) {
      const result = await this.callWithRetry(
        () => callClient(this.client, "searchIssues", [this.jql, cursor], signal),
        signal,
      );
      const issues = Array.isArray(result) ? result : (result?.items ?? []);
      for (const issue of issues) {
        const issueKey = issue.key ?? String(issue.id);
        const issueVersion = issue.fields?.updated ?? issue.updated ?? issue.version ?? "unknown";
        if (this.shouldEmitSourceTimestamp(issue.fields?.updated ?? issue.updated)) {
          yield this.record("issue", issueKey, issueVersion, issue);
        }
        const isResumedIssue = resumeIssueKey !== undefined && issueKey === resumeIssueKey;
        this.metrics.lastCheckpoint = this.withSourceWatermark({
          mode: "search", phase: "issues", page: cursor, issueKey, jqlFingerprint: this.jqlFingerprint,
        });
        yield* this.collectComments(
          issueKey,
          issueVersion,
          isResumedIssue ? resumeCommentPage : 0,
          { mode: "search", page: cursor, jqlFingerprint: this.jqlFingerprint },
          signal,
        );
      }
      // Comment-page resume only ever applies within the replayed range (up
      // through the checkpointed page); once that page has been fully
      // reprocessed, every subsequent page starts every issue's comments
      // from page 0, regardless of key.
      if (hasReachedCheckpointPage(checkpointCursor, cursor, pageIndex)) resumeIssueKey = undefined;
      if (Array.isArray(result) || !result?.nextPage) break;
      cursor = result.nextPage;
      pageIndex += 1;
    }
  }

  async *collectComments(issueKey, issueVersion, startPage, checkpointExtras = {}, signal) {
    if (typeof this.client.fetchComments !== "function") return;
    // `page` is an opaque cursor (`{ startAt }` from the HTTP client, or a
    // legacy numeric page index) and is passed through to the client as-is.
    let page = startPage;
    while (true) {
      const result = await this.callWithRetry(
        () => callClient(this.client, "fetchComments", [issueKey, page], signal),
        signal,
      );
      const comments = Array.isArray(result) ? result : (result?.items ?? []);
      for (const comment of comments) {
        const commentId = String(comment.id ?? sha256(comment).slice(0, 16));
        const sourceTimestamp = comment.updated ?? comment.created;
        if (this.shouldEmitSourceTimestamp(sourceTimestamp)) {
          yield this.record(
            "comment",
            `${issueKey}:${commentId}`,
            sourceTimestamp ?? issueVersion,
            comment,
          );
        }
      }
      this.metrics.lastCheckpoint = this.withSourceWatermark({
        ...checkpointExtras,
        phase: "comments",
        issueKey,
        commentPage: result?.nextPage ?? page,
      });
      if (Array.isArray(result) || !result?.nextPage) break;
      page = result.nextPage;
    }
  }

  record(contentType, sourceId, sourceVersion, payload) {
    this.metrics.records += 1;
    return createRawEvidenceRecord({
      tenantId: this.tenantId,
      productId: this.productId,
      source: "jira",
      sourceId,
      sourceVersion: String(sourceVersion),
      sourceUrl: `${this.baseUrl}/browse/${sourceId.split(":")[0]}`,
      observedAt: this.now(),
      contentType: `jira.${contentType}`,
      payload,
      classification: "internal",
      idempotencyKey: sha256(`jira:${sourceId}:${sourceVersion}:${sha256(payload)}`),
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
    return {
      pluginId: jiraManifest.id,
      status: this.metrics.failures === 0 ? "healthy" : "degraded",
      credentialRef: this.credentialRef,
      ...this.metrics,
    };
  }
}
