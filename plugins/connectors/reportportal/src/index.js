import {
  assertPluginManifest,
  assertIncrementalLookbackSeconds,
  createRawEvidenceRecord,
  sha256,
  sourceTimestampMillis,
} from "@tkl/contracts";
import { isHttpUrl, isProductionSafeUrl, normalizeBaseUrl } from "./http.js";

export {
  createReportPortalHttpClient,
  ReportPortalHttpError,
  nextPaginationCursor,
  resolvePageIndex,
} from "./reportportal-http-client.js";

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

export const reportportalManifest = assertPluginManifest({
  id: "connector.reportportal",
  version: "0.1.0",
  contractVersion: "0.1.0",
  capabilities: ["launch-read", "test-item-read", "incremental-sync"],
  requiredPermissions: ["reportportal.launch.read"],
});

const asPage = (response) => ({
  items: Array.isArray(response) ? response : (response?.items ?? []),
  nextPage: Array.isArray(response) ? undefined : response?.nextPage,
});

function launchId(launch) {
  if (launch?.id === undefined || launch.id === null || launch.id === "") {
    throw new TypeError("ReportPortal launch ID is required");
  }
  return String(launch.id);
}

function testItemId(item) {
  if (item?.id === undefined || item.id === null || item.id === "") {
    throw new TypeError("ReportPortal test item ID is required");
  }
  return String(item.id);
}

function launchVersion(launch) {
  return String(launch.lastModified ?? launch.endTime ?? launch.startTime ?? launch.id);
}

function testItemVersion(item) {
  return String(item.lastModified ?? item.endTime ?? item.startTime ?? item.id);
}

function launchTimestamp(launch) {
  return launch.lastModified ?? launch.endTime ?? launch.startTime;
}

function testItemTimestamp(item) {
  return item.lastModified ?? item.endTime ?? item.startTime;
}

function sanitizeLogMessage(value) {
  return String(value ?? "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(
      /\b(password|passwd|pwd|token|secret|otp|authorization)\b\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 1_000);
}

function sanitizedLogs(logs) {
  if (!Array.isArray(logs)) return [];
  return logs.slice(0, 50).flatMap((log) => {
    if (!log || typeof log !== "object") return [];
    const message = sanitizeLogMessage(log.message);
    if (!message) return [];
    return [{
      message,
      ...(typeof log.level === "string" ? { level: log.level } : {}),
      ...(typeof log.logTime === "number" || typeof log.logTime === "string"
        ? { logTime: log.logTime }
        : {}),
    }];
  });
}

// A no-op default so injecting a logger is always optional and never
// changes behavior for existing callers/tests.
const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class ReportPortalConnector {
  constructor({
    client,
    tenantId,
    productId,
    credentialRef,
    project,
    incrementalLookbackSeconds,
    baseUrl,
    allowInsecureLoopback = false,
    allowInsecureHost = false,
    maxRetries = 2,
    now = () => new Date().toISOString(),
    logger = NOOP_LOGGER,
  }) {
    if (!client || typeof client.fetchLaunches !== "function") {
      throw new TypeError("A ReportPortal client with fetchLaunches is required");
    }
    this.client = client;
    this.tenantId = typeof tenantId === "string" ? tenantId.trim() : tenantId;
    this.productId = typeof productId === "string" ? productId.trim() : productId;
    this.credentialRef = typeof credentialRef === "string" ? credentialRef.trim() : credentialRef;
    this.logger = logger;
    this.project = typeof project === "string" ? project.trim() : (client?.project ?? "");
    this.incrementalLookbackSeconds =
      assertIncrementalLookbackSeconds(incrementalLookbackSeconds);
    // An explicitly configured connector-level `baseUrl` is preferred (it is
    // used verbatim to build evidence `sourceUrl` links); when absent, the
    // connector falls back to the HTTP client's own already-validated
    // `baseUrl` metadata, so a plaintext or malformed override is never
    // silently substituted with a safe-looking value.
    this.baseUrl = normalizeBaseUrl(baseUrl) || normalizeBaseUrl(client?.baseUrl) || "";
    this.allowInsecureLoopback = allowInsecureLoopback === true;
    this.allowInsecureHost = allowInsecureHost === true;
    this.maxRetries = maxRetries;
    this.now = now;
    this.metrics = { records: 0, retries: 0, failures: 0, lastSyncAt: null, lastCheckpoint: null };
  }

  async validateConfiguration() {
    const errors = [];
    if (typeof this.tenantId !== "string" || this.tenantId.trim() === "") errors.push("tenantId is required");
    if (typeof this.productId !== "string" || this.productId.trim() === "") errors.push("productId is required");
    if (typeof this.credentialRef !== "string" || this.credentialRef.trim() === "") errors.push("credentialRef is required");
    if (typeof this.project !== "string" || this.project.trim() === "") errors.push("project is required");
    if (!isHttpUrl(this.baseUrl)) {
      errors.push("baseUrl must be a valid HTTP(S) URL");
    } else if (!isProductionSafeUrl(this.baseUrl, {
      allowInsecureLoopback: this.allowInsecureLoopback,
      allowInsecureHost: this.allowInsecureHost,
    })) {
      errors.push(
        "baseUrl must use HTTPS unless this exact internal host or a local loopback "
        + "development endpoint was explicitly approved",
      );
    }
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
        pluginId: reportportalManifest.id,
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

  /**
   * Collects launches and their test items, resuming from an optional
   * checkpoint. `health().lastCheckpoint` is `{ phase: "complete" }` after
   * a full sync finishes; that exact shape is itself a valid, resumable
   * checkpoint that starts a fresh full sync. Launches and test items are
   * safe to replay in full on resume -- their idempotency keys deduplicate
   * anything already collected in a prior run.
   */
  async *collect(checkpoint = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    this.logEvent("connector.sync.start", { resumedFromCheckpoint: Object.keys(checkpoint).length > 0 });
    this.initializeIncrementalState(checkpoint);

    // Lookback filtering is safe only when every launch/page is revisited;
    // retain watermark state but discard positional resume fields.
    const resolvedCheckpoint = this.incrementalLookbackSeconds !== undefined
      ? this.withSourceWatermark({})
      : checkpoint.phase === "complete"
        ? this.withSourceWatermark({})
        : checkpoint;
    const phase = resolvedCheckpoint.phase ?? "launches";
    if (!["launches", "items"].includes(phase)) {
      throw new TypeError("ReportPortal checkpoint phase is invalid");
    }
    const phaseOrder = ["launches", "items"];
    const currentPhase = phaseOrder.indexOf(phase);

    const launches = await this.fetchResources(
      "fetchLaunches",
      resolvedCheckpoint.launchPage ?? 0,
      signal,
    );
    if (currentPhase === 0) {
      for (const launch of launches) {
        if (this.shouldEmitSourceTimestamp(launchTimestamp(launch))) {
          yield this.record("launch", launchId(launch), launchVersion(launch), launch);
        }
      }
    }
    if (currentPhase <= 1 && typeof this.client.fetchTestItems === "function") {
      yield* this.collectItems(launches, resolvedCheckpoint, phase, signal);
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
        () => callClient(this.client, fetchName, [page], signal),
        signal,
      );
      const { items, nextPage } = asPage(response);
      resources.push(...items);
      if (nextPage === undefined || nextPage === null) break;
      page = nextPage;
    }
    return resources;
  }

  async *collectItems(launches, checkpoint, phase, signal) {
    const startLaunchId = phase === "items" ? String(checkpoint.launchId) : null;
    let startFound = !startLaunchId;
    for await (const launch of launches) {
      const id = launchId(launch);
      if (!startFound) {
        if (id !== startLaunchId) continue;
        startFound = true;
      }
      let page = id === startLaunchId ? (checkpoint.itemPage ?? 0) : 0;
      while (true) {
        const response = await this.callWithRetry(
          () => callClient(this.client, "fetchTestItems", [id, page], signal),
          signal,
        );
        const { items, nextPage } = asPage(response);
        for (const item of items) {
          if (this.shouldEmitSourceTimestamp(testItemTimestamp(item))) {
            yield this.record("test_item", testItemId(item), testItemVersion(item), item);
          }
        }
        this.metrics.lastCheckpoint = this.withSourceWatermark({
          phase: "items",
          launchId: id,
          itemPage: nextPage ?? page,
        });
        if (nextPage === undefined || nextPage === null) break;
        page = nextPage;
      }
    }
    if (!startFound) throw new TypeError(`Checkpoint launch "${startLaunchId}" was not found`);
  }

  async *collectTestItemsByIdentity(identity, { signal } = {}) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    if (typeof this.client.fetchTestItemsByIdentity !== "function") {
      throw new TypeError("The ReportPortal client does not support identity lookup");
    }
    const items = await this.callWithRetry(
      () => callClient(this.client, "fetchTestItemsByIdentity", [identity], signal),
      signal,
    );
    for (const item of items) {
      const logs = typeof this.client.fetchLogs === "function"
        ? sanitizedLogs(await this.callWithRetry(
            () => callClient(this.client, "fetchLogs", [testItemId(item)], signal),
            signal,
          ))
        : [];
      const payload = logs.length > 0 ? { ...item, logs } : item;
      const version = logs.length > 0
        ? `${testItemVersion(item)}:${sha256(logs)}`
        : testItemVersion(item);
      yield this.record("test_item", testItemId(item), version, payload);
    }
  }

  record(type, sourceId, sourceVersion, payload) {
    this.metrics.records += 1;
    const sourceUrl = type === "test_item"
      ? `${this.baseUrl}/ui/#${this.project}/launches/all/${payload.launchId ?? ""}?log.item=${sourceId}`
      : `${this.baseUrl}/ui/#${this.project}/launches/all/${sourceId}`;
    return createRawEvidenceRecord({
      tenantId: this.tenantId,
      productId: this.productId,
      source: "reportportal",
      sourceId,
      sourceVersion,
      sourceUrl,
      observedAt: this.now(),
      contentType: `reportportal.${type}`,
      payload,
      classification: "internal",
      idempotencyKey: sha256(`reportportal:${this.project}:${type}:${sourceId}:${sourceVersion}:${sha256(payload)}`),
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
      pluginId: reportportalManifest.id,
      status: this.metrics.failures === 0 ? "healthy" : "degraded",
      credentialRef: this.credentialRef,
      ...this.metrics,
    };
  }
}
