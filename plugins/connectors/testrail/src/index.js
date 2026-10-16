import {
  assertPluginManifest,
  assertIncrementalLookbackSeconds,
  createRawEvidenceRecord,
  sha256,
  sourceTimestampMillis,
} from "@tkl/contracts";
import { isHttpUrl, isProductionSafeUrl, normalizeBaseUrl } from "./http.js";

export { createTestRailHttpClient, TestRailHttpError } from "./testrail-http-client.js";

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
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
const normalizePositiveIntegerId = (value) => {
  const text = typeof value === "number" || typeof value === "string"
    ? String(value).trim()
    : "";
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) return null;
  return BigInt(text).toString();
};

export const testrailManifest = assertPluginManifest({
  id: "connector.testrail",
  version: "0.1.0",
  contractVersion: "0.1.0",
  capabilities: ["suites", "cases", "runs", "results", "incremental-sync"],
  requiredPermissions: ["testrail.project.read"],
});

const asPage = (response) => ({
  items: Array.isArray(response) ? response : (response?.items ?? []),
  nextPage: Array.isArray(response) ? undefined : response?.nextPage,
});

const timestampOf = (item) => (
  item.updated_on
  ?? item.updatedAt
  ?? item.updated_at
  ?? item.created_on
  ?? item.createdAt
);

const versionOf = (item) => String(
  timestampOf(item)
  ?? item.version
  ?? sha256(item),
);

const itemId = (item) => {
  if (item?.id === undefined || item.id === null || item.id === "") {
    throw new TypeError("TestRail resource ID is required");
  }
  return String(item.id);
};

// A no-op default so injecting a logger is always optional and never
// changes behavior for existing callers/tests.
const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class TestRailConnector {
  constructor({
    client,
    tenantId,
    productId,
    projectId,
    suiteScope,
    suiteIds,
    incrementalLookbackSeconds,
    baseUrl,
    allowInsecureLoopback = false,
    credentialRef,
    maxRetries = 2,
    now = () => new Date().toISOString(),
    logger = NOOP_LOGGER,
  }) {
    if (!client || typeof client !== "object") throw new TypeError("A TestRail client is required");
    this.client = client;
    this.tenantId = typeof tenantId === "string" ? tenantId.trim() : tenantId;
    this.productId = typeof productId === "string" ? productId.trim() : productId;
    this.logger = logger;
    this.projectId = normalizePositiveIntegerId(projectId);
    this.suiteScope = suiteScope ?? (Array.isArray(suiteIds) ? "selected" : "all");
    const normalizedSuiteIds = Array.isArray(suiteIds)
      ? suiteIds.map(normalizePositiveIntegerId)
      : [];
    this.hasValidSuiteIds = normalizedSuiteIds.every((id) => id !== null);
    this.suiteIds = this.hasValidSuiteIds
      ? [...new Set(normalizedSuiteIds)]
      : [];
    this.incrementalLookbackSeconds =
      assertIncrementalLookbackSeconds(incrementalLookbackSeconds);
    // An explicitly configured connector-level `baseUrl` is preferred (it is
    // used verbatim to build evidence `sourceUrl` links); when absent, the
    // connector falls back to the HTTP client's own already-validated
    // `baseUrl` metadata (validated for HTTPS/loopback safety at client
    // construction time), so a plaintext or malformed override is never
    // silently substituted with a safe-looking value. Both the explicit and
    // fallback value are re-checked in `validateConfiguration` below with
    // the same HTTPS/loopback safety rule as the HTTP client, since this
    // baseUrl is independently used to build evidence links regardless of
    // where it came from.
    this.baseUrl = normalizeBaseUrl(baseUrl) || normalizeBaseUrl(client?.baseUrl) || "";
    this.allowInsecureLoopback = allowInsecureLoopback === true;
    this.credentialRef = typeof credentialRef === "string" ? credentialRef.trim() : credentialRef;
    this.maxRetries = maxRetries;
    this.now = now;
    this.metrics = {
      records: 0,
      retries: 0,
      failures: 0,
      lastSyncAt: null,
      lastCheckpoint: null,
    };
  }

  async validateConfiguration() {
    const errors = [];
    if (typeof this.tenantId !== "string" || this.tenantId.trim() === "") errors.push("tenantId is required");
    if (typeof this.productId !== "string" || this.productId.trim() === "") errors.push("productId is required");
    if (this.projectId === null) errors.push("projectId must be a positive integer");
    if (!["all", "selected"].includes(this.suiteScope)) {
      errors.push('suiteScope must be either "all" or "selected"');
    } else if (
      this.suiteScope === "selected"
      && (!this.hasValidSuiteIds || this.suiteIds.length === 0)
    ) {
      errors.push("selected suite scope requires at least one valid suite ID");
    }
    if (!isHttpUrl(this.baseUrl)) {
      errors.push("baseUrl must be a valid HTTP(S) URL");
    } else if (!isProductionSafeUrl(this.baseUrl, { allowInsecureLoopback: this.allowInsecureLoopback })) {
      errors.push(
        "baseUrl must use HTTPS in production; set allowInsecureLoopback: true only for local "
        + "loopback (localhost/127.0.0.1/[::1]) development or test HTTP endpoints",
      );
    }
    if (typeof this.credentialRef !== "string" || this.credentialRef.trim() === "") errors.push("credentialRef is required");
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
        pluginId: testrailManifest.id,
        tenantId: this.tenantId,
        productId: this.productId,
        ...fields,
      });
    } catch {
      // Swallow: a broken logging sink must never turn a working sync into a failure.
    }
  }

  async callWithRetry(operation, signal) {
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        signal?.throwIfAborted();
        const status = error?.status ?? error?.statusCode;
        const retryAfter = Number(error?.retryAfter ?? error?.headers?.["retry-after"] ?? error?.headers?.["Retry-After"]);
        // Recognized network/timeout failures from the HTTP client (for
        // example connection resets or aborted requests) surface without a
        // status code and must still be retried within bounds; only a
        // *known*, non-transient status (ordinary 4xx) should bail out
        // immediately without retrying.
        if (attempt >= this.maxRetries || (status !== undefined && !TRANSIENT_STATUSES.has(status))) {
          this.metrics.failures += 1;
          this.logEvent("connector.failure", { status: status ?? null, attempt, lastCheckpoint: this.metrics.lastCheckpoint ?? null });
          throw error;
        }
        this.metrics.retries += 1;
        this.logEvent("connector.retry", { status: status ?? null, attempt, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null });
        const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 10 * 2 ** attempt;
        await delayWithSignal(Math.min(waitMs, 30_000), signal);
      }
    }
  }

  async *collect(checkpoint = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    this.logEvent("connector.sync.start", { resumedFromCheckpoint: Object.keys(checkpoint).length > 0 });
    this.initializeIncrementalState(checkpoint);

    // This connector's own `health().lastCheckpoint` at the end of a full
    // sync is `{ phase: "complete" }` (see below). That exact shape must be
    // resumable -- feeding it back into `collect` starts a fresh full sync
    // (equivalent to an empty/omitted checkpoint) rather than being
    // rejected as an "invalid phase". Any other fields alongside
    // `phase: "complete"` are disregarded rather than trusted as stale
    // positional cursors from a prior, unrelated run.
    // Lookback filtering is safe only when every configured scope/page is
    // revisited; retain watermark state but discard positional resume fields.
    const resolvedCheckpoint = this.incrementalLookbackSeconds !== undefined
      ? this.withSourceWatermark({})
      : checkpoint.phase === "complete"
        ? this.withSourceWatermark({})
        : checkpoint;
    const phase = resolvedCheckpoint.phase ?? "suites";
    if (!["suites", "cases", "runs", "results"].includes(phase)) {
      throw new TypeError("TestRail checkpoint phase is invalid");
    }

    const phaseOrder = ["suites", "cases", "runs", "results"];
    const currentPhase = phaseOrder.indexOf(phase);
    const allowedSuiteIds = this.suiteScope === "selected"
      ? new Set(this.suiteIds.map(String))
      : null;
    const suites = (await this.fetchResources("fetchSuites", resolvedCheckpoint.suitePage ?? 0, signal))
      .filter((suite) => !allowedSuiteIds || allowedSuiteIds.has(itemId(suite)));
    if (currentPhase === 0) {
      for (const suite of suites) {
        if (this.shouldEmitSourceTimestamp(timestampOf(suite))) {
          yield this.record("suite", itemId(suite), versionOf(suite), suite, "suites/view");
        }
      }
    }
    if (currentPhase <= 1 && typeof this.client.fetchCases === "function") {
      yield* this.collectCases(suites, resolvedCheckpoint, phase, signal);
    }

    const runs = (await this.fetchResources("fetchRuns", resolvedCheckpoint.runPage ?? 0, signal))
      .filter((run) =>
        !allowedSuiteIds
        || run.suite_id === undefined
        || run.suite_id === null
        || allowedSuiteIds.has(String(run.suite_id))
      );
    if (currentPhase <= 2) {
      for (const run of runs) {
        if (this.shouldEmitSourceTimestamp(timestampOf(run))) {
          yield this.record("run", itemId(run), versionOf(run), run, "runs/view");
        }
      }
    }
    if (currentPhase <= 3 && typeof this.client.fetchResults === "function") {
      yield* this.collectResults(runs, resolvedCheckpoint, phase, signal);
    }

    this.metrics.lastCheckpoint = this.withSourceWatermark({ phase: "complete" }, true);
    this.metrics.lastSyncAt = this.now();
    this.logEvent("connector.sync.complete", {
      records: this.metrics.records,
      retries: this.metrics.retries,
      failures: this.metrics.failures,
      lastCheckpoint: this.metrics.lastCheckpoint,
    });
  }

  async fetchResources(fetchName, initialPage, signal) {
    if (typeof this.client[fetchName] !== "function") return [];
    const resources = [];
    let page = initialPage;
    while (true) {
      const response = await this.callWithRetry(
        () => callClient(this.client, fetchName, [this.projectId, page], signal),
        signal,
      );
      const { items, nextPage } = asPage(response);
      resources.push(...items);
      if (nextPage === undefined || nextPage === null) break;
      page = nextPage;
    }
    return resources;
  }

  async *collectCases(suites, checkpoint, phase, signal) {
    const startSuiteId = phase === "cases" ? String(checkpoint.suiteId) : null;
    let startFound = !startSuiteId;
    for await (const suite of suites) {
      const suiteId = itemId(suite);
      if (!startFound) {
        if (suiteId !== startSuiteId) continue;
        startFound = true;
      }
      let page = suiteId === startSuiteId ? (checkpoint.casePage ?? 0) : 0;
      while (true) {
        const response = await this.callWithRetry(
          () => callClient(this.client, "fetchCases", [this.projectId, suiteId, page], signal),
          signal,
        );
        const { items, nextPage } = asPage(response);
        for (const item of items) {
          if (this.shouldEmitSourceTimestamp(timestampOf(item))) {
            yield this.record("case", itemId(item), versionOf(item), item, "cases/view");
          }
        }
        this.metrics.lastCheckpoint = this.withSourceWatermark({
          phase: "cases",
          suiteId,
          casePage: nextPage ?? page,
        });
        if (nextPage === undefined || nextPage === null) break;
        page = nextPage;
      }
    }
    if (!startFound) throw new TypeError(`Checkpoint suite "${startSuiteId}" was not found`);
  }

  async *collectResults(runs, checkpoint, phase, signal) {
    const startRunId = phase === "results" ? String(checkpoint.runId) : null;
    let startFound = !startRunId;
    for await (const run of runs) {
      const runId = itemId(run);
      if (!startFound) {
        if (runId !== startRunId) continue;
        startFound = true;
      }
      let page = runId === startRunId ? (checkpoint.resultPage ?? 0) : 0;
      while (true) {
        const response = await this.callWithRetry(
          () => callClient(this.client, "fetchResults", [runId, page], signal),
          signal,
        );
        const { items, nextPage } = asPage(response);
        for (const item of items) {
          if (this.shouldEmitSourceTimestamp(timestampOf(item))) {
            yield this.record("result", itemId(item), versionOf(item), item, "results/view");
          }
        }
        this.metrics.lastCheckpoint = this.withSourceWatermark({
          phase: "results",
          runId,
          resultPage: nextPage ?? page,
        });
        if (nextPage === undefined || nextPage === null) break;
        page = nextPage;
      }
    }
    if (!startFound) throw new TypeError(`Checkpoint run "${startRunId}" was not found`);
  }

  async *collectCasesByReference(
    reference,
    { signal, maxRecords = 100, maxSuites = 20, budgetState } = {}
  ) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    if (typeof reference !== "string" || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(reference)) {
      throw new TypeError("reference must be a valid issue key");
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new TypeError("maxRecords must be a positive integer");
    }
    if (!Number.isSafeInteger(maxSuites) || maxSuites < 1) {
      throw new TypeError("maxSuites must be a positive integer");
    }
    if (typeof this.client.fetchCasesByReference !== "function") return;
    const allSuiteIds = this.suiteScope === "selected"
      ? this.suiteIds.map(String)
      : (await this.fetchResources("fetchSuites", 0, signal)).map(itemId);
    const suiteIds = allSuiteIds.slice(0, maxSuites);
    if (budgetState && allSuiteIds.length > suiteIds.length) budgetState.truncated = true;
    const exactReference = new RegExp(
      `(^|[^A-Z0-9_])${reference.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Z0-9_])`,
      "i"
    );
    let emitted = 0;
    for (const [suiteIndex, suiteId] of suiteIds.entries()) {
      let page = 0;
      let hasMorePages = false;
      while (emitted < maxRecords) {
        const response = await this.callWithRetry(
          () => callClient(
            this.client,
            "fetchCasesByReference",
            [this.projectId, suiteId, reference.toUpperCase(), page],
            signal,
          ),
          signal,
        );
        const { items, nextPage } = asPage(response);
        for (const item of items) {
          const references = Array.isArray(item.refs) ? item.refs.join(",") : String(item.refs ?? "");
          if (!exactReference.test(references)) continue;
          if (emitted >= maxRecords) {
            if (budgetState) budgetState.truncated = true;
            return;
          }
          emitted += 1;
          yield this.record("case", itemId(item), versionOf(item), item, "cases/view");
        }
        hasMorePages = nextPage !== undefined && nextPage !== null;
        if (!hasMorePages) break;
        page = nextPage;
      }
      if (emitted >= maxRecords) {
        if (budgetState && (hasMorePages || suiteIndex < suiteIds.length - 1)) {
          budgetState.truncated = true;
        }
        return;
      }
    }
  }

  async *collectCase(caseId, { signal } = {}) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    const normalizedCaseId = normalizePositiveIntegerId(caseId);
    if (normalizedCaseId === null) {
      throw new TypeError("caseId must be a positive integer");
    }
    if (typeof this.client.fetchCase !== "function") return;
    const item = await this.callWithRetry(
      () => callClient(this.client, "fetchCase", [normalizedCaseId], signal),
      signal,
    );
    if (itemId(item) !== normalizedCaseId) {
      throw new TypeError("TestRail returned a case that does not match the requested ID");
    }
    yield this.record("case", normalizedCaseId, versionOf(item), item, "cases/view");
  }

  async *collectCasesInSection(
    suiteId,
    sectionId,
    { signal, maxRecords = 100, budgetState } = {},
  ) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    const normalizedSuiteId = normalizePositiveIntegerId(suiteId);
    const normalizedSectionId = normalizePositiveIntegerId(sectionId);
    if (normalizedSuiteId === null || normalizedSectionId === null) {
      throw new TypeError("suiteId and sectionId must be positive integers");
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new TypeError("maxRecords must be a positive integer");
    }
    if (typeof this.client.fetchCasesInSection !== "function") return;
    let page = 0;
    let emitted = 0;
    while (emitted < maxRecords) {
      const response = await this.callWithRetry(
        () => callClient(
          this.client,
          "fetchCasesInSection",
          [this.projectId, normalizedSuiteId, normalizedSectionId, page],
          signal,
        ),
        signal,
      );
      const { items, nextPage } = asPage(response);
      for (const item of items) {
        if (emitted >= maxRecords) {
          if (budgetState) budgetState.truncated = true;
          return;
        }
        yield this.record("case", itemId(item), versionOf(item), item, "cases/view");
        emitted += 1;
      }
      if (nextPage === undefined || nextPage === null) return;
      page = nextPage;
    }
    if (budgetState) budgetState.truncated = true;
  }

  async *collectCaseNeighborhood(caseId, { signal, maxRecords = 100, budgetState } = {}) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    const normalizedCaseId = normalizePositiveIntegerId(caseId);
    if (normalizedCaseId === null) {
      throw new TypeError("caseId must be a positive integer");
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new TypeError("maxRecords must be a positive integer");
    }
    if (typeof this.client.fetchCase !== "function") return;
    const anchor = await this.callWithRetry(
      () => callClient(this.client, "fetchCase", [normalizedCaseId], signal),
      signal,
    );
    if (itemId(anchor) !== normalizedCaseId) {
      throw new TypeError("TestRail returned a case that does not match the requested ID");
    }
    const suiteId = normalizePositiveIntegerId(anchor.suite_id);
    const sectionId = normalizePositiveIntegerId(anchor.section_id);
    if (suiteId === null) {
      yield this.record("case", normalizedCaseId, versionOf(anchor), anchor, "cases/view");
      return;
    }
    yield this.record("case", normalizedCaseId, versionOf(anchor), anchor, "cases/view");
    let emitted = 1;
    if (emitted >= maxRecords) {
      if (budgetState) budgetState.truncated = true;
      return;
    }
    const method = sectionId !== null && typeof this.client.fetchCasesInSection === "function"
      ? "fetchCasesInSection"
      : "fetchCases";
    let page = 0;
    while (emitted < maxRecords) {
      const args = method === "fetchCasesInSection"
        ? [this.projectId, suiteId, sectionId, page]
        : [this.projectId, suiteId, page];
      const response = await this.callWithRetry(
        () => callClient(this.client, method, args, signal),
        signal,
      );
      const { items, nextPage } = asPage(response);
      for (const item of items) {
        if (itemId(item) === normalizedCaseId) continue;
        if (emitted >= maxRecords) {
          if (budgetState) budgetState.truncated = true;
          return;
        }
        yield this.record("case", itemId(item), versionOf(item), item, "cases/view");
        emitted += 1;
      }
      if (nextPage === undefined || nextPage === null) return;
      page = nextPage;
    }
    if (budgetState) budgetState.truncated = true;
  }

  record(type, sourceId, sourceVersion, payload, path) {
    this.metrics.records += 1;
    return createRawEvidenceRecord({
      tenantId: this.tenantId,
      productId: this.productId,
      source: "testrail",
      sourceId,
      sourceVersion,
      sourceUrl: `${this.baseUrl.replace(/\/$/, "")}/index.php?/${path}/${sourceId}`,
      observedAt: this.now(),
      contentType: `testrail.${type}`,
      payload,
      classification: "internal",
      idempotencyKey: sha256(`testrail:${this.projectId}:${type}:${sourceId}:${sourceVersion}:${sha256(payload)}`),
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
      pluginId: testrailManifest.id,
      status: this.metrics.failures === 0 ? "healthy" : "degraded",
      credentialRef: this.credentialRef,
      ...this.metrics,
    };
  }
}
