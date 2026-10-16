import {
  assertPluginManifest,
  assertIncrementalLookbackSeconds,
  createRawEvidenceRecord,
  sha256,
  sourceTimestampMillis,
} from "@tkl/contracts";
import { isHttpUrl, isProductionSafeUrl, normalizeBaseUrl } from "./http.js";

export {
  createConfluenceHttpClient,
  ConfluenceHttpError,
  nextPaginationCursor,
  resolvePaginationStart,
} from "./confluence-http-client.js";

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

export const confluenceManifest = assertPluginManifest({
  id: "connector.confluence",
  version: "0.1.0",
  contractVersion: "0.1.0",
  capabilities: ["page-read", "incremental-sync"],
  requiredPermissions: ["confluence.page.read"],
});

function normalizeSpaceKeys(values) {
  const normalized = (Array.isArray(values) ? values : [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  return [...new Set(normalized)];
}

function normalizeRootPageRefs(values) {
  const normalized = (Array.isArray(values) ? values : [])
    .map((value) => {
      const match = /^(\d+):([^:]+)$/.exec(typeof value === "string" ? value.trim() : "");
      if (!match || BigInt(match[1]) <= 0n) return null;
      return { pageId: BigInt(match[1]).toString(), spaceKey: match[2].trim() };
    });
  return normalized.length > 0 && normalized.every(Boolean)
    ? normalized
    : [];
}

function pageVersion(page) {
  return page?.version?.number !== undefined
    ? String(page.version.number)
    : String(page?.version?.when ?? page?.id ?? "unknown");
}

function pageId(page) {
  if (page?.id === undefined || page.id === null || page.id === "") {
    throw new TypeError("Confluence page ID is required");
  }
  return String(page.id);
}

// A no-op default so injecting a logger is always optional and never
// changes behavior for existing callers/tests.
const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class ConfluenceConnector {
  constructor({
    client,
    tenantId,
    productId,
    credentialRef,
    spaceKeys,
    contentScope = "space",
    rootPageRefs,
    incrementalLookbackSeconds,
    baseUrl,
    allowInsecureLoopback = false,
    maxRetries = 2,
    now = () => new Date().toISOString(),
    logger = NOOP_LOGGER,
  }) {
    if (!client || typeof client.fetchSpacePages !== "function") {
      throw new TypeError("A Confluence client with fetchSpacePages is required");
    }
    this.client = client;
    this.tenantId = typeof tenantId === "string" ? tenantId.trim() : tenantId;
    this.productId = typeof productId === "string" ? productId.trim() : productId;
    this.credentialRef = typeof credentialRef === "string" ? credentialRef.trim() : credentialRef;
    this.logger = logger;
    this.spaceKeys = normalizeSpaceKeys(spaceKeys);
    this.contentScope = contentScope;
    this.rootPageRefs = normalizeRootPageRefs(rootPageRefs);
    this.incrementalLookbackSeconds =
      assertIncrementalLookbackSeconds(incrementalLookbackSeconds);
    // An explicitly configured connector-level `baseUrl` is preferred (it is
    // used verbatim to build evidence `sourceUrl` links); when absent, the
    // connector falls back to the HTTP client's own already-validated
    // `baseUrl` metadata, so a plaintext or malformed override is never
    // silently substituted with a safe-looking value.
    this.baseUrl = normalizeBaseUrl(baseUrl) || normalizeBaseUrl(client?.baseUrl) || "";
    this.allowInsecureLoopback = allowInsecureLoopback === true;
    this.maxRetries = maxRetries;
    this.now = now;
    this.metrics = { records: 0, retries: 0, failures: 0, lastSyncAt: null, lastCheckpoint: null };
  }

  async validateConfiguration() {
    const errors = [];
    if (typeof this.tenantId !== "string" || this.tenantId.trim() === "") errors.push("tenantId is required");
    if (typeof this.productId !== "string" || this.productId.trim() === "") errors.push("productId is required");
    if (typeof this.credentialRef !== "string" || this.credentialRef.trim() === "") errors.push("credentialRef is required");
    if (this.spaceKeys.length === 0) errors.push("spaceKeys must contain at least one allowlisted space");
    if (!["tree", "page", "space"].includes(this.contentScope)) {
      errors.push('contentScope must be "tree", "page", or "space"');
    } else if (this.contentScope !== "space" && this.rootPageRefs.length === 0) {
      errors.push("page-scoped ingestion requires at least one valid root page reference");
    }
    if (
      this.contentScope === "tree"
      && (
        typeof this.client.fetchPage !== "function"
        || typeof this.client.fetchPageTree !== "function"
      )
    ) {
      errors.push("client.fetchPage and client.fetchPageTree are required for tree scope");
    }
    if (this.contentScope === "page" && typeof this.client.fetchPage !== "function") {
      errors.push("client.fetchPage is required for exact-page scope");
    }
    if (!isHttpUrl(this.baseUrl)) {
      errors.push("baseUrl must be a valid HTTP(S) URL");
    } else if (!isProductionSafeUrl(this.baseUrl, { allowInsecureLoopback: this.allowInsecureLoopback })) {
      errors.push(
        "baseUrl must use HTTPS in production; set allowInsecureLoopback: true only for local "
        + "loopback (localhost/127.0.0.1/[::1]) development or test HTTP endpoints",
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
        pluginId: confluenceManifest.id,
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
   * Collects current pages for every configured/allowlisted space,
   * resuming from an optional checkpoint identifying the space (by index
   * and key, so a reordered/removed space is detected rather than
   * silently resumed against the wrong one) and pagination `start` offset.
   * `health().lastCheckpoint` is `{ phase: "complete" }` after a full sync;
   * that exact shape is itself a valid, resumable checkpoint that starts a
   * fresh full sync.
   */
  async *collect(checkpoint = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    this.logEvent("connector.sync.start", { resumedFromCheckpoint: Object.keys(checkpoint).length > 0 });
    this.initializeIncrementalState(checkpoint);

    // Lookback filtering is safe only when every configured scope/page is
    // revisited; retain watermark state but discard positional resume fields.
    const resolvedCheckpoint = this.incrementalLookbackSeconds !== undefined
      ? this.withSourceWatermark({})
      : checkpoint.phase === "complete"
        ? this.withSourceWatermark({})
        : checkpoint;
    if (this.contentScope !== "space") {
      yield* this.collectRootPages(resolvedCheckpoint, signal);
      this.metrics.lastCheckpoint = this.withSourceWatermark({ phase: "complete" }, true);
      this.metrics.lastSyncAt = this.now();
      this.logEvent("connector.sync.complete", {
        records: this.metrics.records,
        retries: this.metrics.retries,
        failures: this.metrics.failures,
        lastCheckpoint: this.metrics.lastCheckpoint,
      });
      return;
    }
    const startSpaceIndex = Number.isSafeInteger(resolvedCheckpoint.spaceIndex) && resolvedCheckpoint.spaceIndex >= 0
      ? resolvedCheckpoint.spaceIndex
      : 0;
    if (startSpaceIndex >= this.spaceKeys.length) {
      throw new TypeError(`Checkpoint spaceIndex ${startSpaceIndex} is outside the configured spaceKeys`);
    }
    if (resolvedCheckpoint.spaceIndex !== undefined) {
      const expectedSpaceKey = this.spaceKeys[startSpaceIndex];
      if (expectedSpaceKey !== resolvedCheckpoint.spaceKey) {
        throw new TypeError(
          `Checkpoint space "${resolvedCheckpoint.spaceKey}" does not match the configured space at index `
          + `${startSpaceIndex} ("${expectedSpaceKey}"); the configured spaceKeys changed since this checkpoint was saved`,
        );
      }
    }

    for (let spaceIndex = startSpaceIndex; spaceIndex < this.spaceKeys.length; spaceIndex += 1) {
      const spaceKey = this.spaceKeys[spaceIndex];
      let page = spaceIndex === startSpaceIndex ? (resolvedCheckpoint.start ?? 0) : 0;
      while (true) {
        const result = await this.callWithRetry(
          () => callClient(this.client, "fetchSpacePages", [spaceKey, page], signal),
          signal,
        );
        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const nextPage = Array.isArray(result) ? undefined : result?.nextPage;
        for (const item of items) {
          if (this.shouldEmitSourceTimestamp(item?.version?.when)) {
            yield this.record(item, spaceKey);
          }
        }
        this.metrics.lastCheckpoint = this.withSourceWatermark({
          phase: "pages",
          spaceIndex,
          spaceKey,
          start: nextPage !== undefined ? (nextPage.start ?? nextPage) : page,
        });
        if (nextPage === undefined || nextPage === null) break;
        page = nextPage;
      }
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

  async *collectRootPages(checkpoint, signal) {
    const startRootIndex = Number.isSafeInteger(checkpoint.rootIndex) && checkpoint.rootIndex >= 0
      ? checkpoint.rootIndex
      : 0;
    if (startRootIndex >= this.rootPageRefs.length) {
      throw new TypeError(`Checkpoint rootIndex ${startRootIndex} is outside the configured root pages`);
    }
    if (checkpoint.rootIndex !== undefined) {
      const expected = this.rootPageRefs[startRootIndex];
      if (`${expected.pageId}:${expected.spaceKey}` !== checkpoint.rootPageRef) {
        throw new TypeError("Checkpoint root page does not match the configured root page");
      }
    }

    const emittedPageIds = new Set();
    for (let rootIndex = startRootIndex; rootIndex < this.rootPageRefs.length; rootIndex += 1) {
      const root = this.rootPageRefs[rootIndex];
      const rootPageRef = `${root.pageId}:${root.spaceKey}`;
      if (this.contentScope === "page") {
        const page = await this.callWithRetry(
          () => callClient(this.client, "fetchPage", [root.spaceKey, root.pageId], signal),
          signal,
        );
        if (!emittedPageIds.has(pageId(page))) {
          emittedPageIds.add(pageId(page));
          if (this.shouldEmitSourceTimestamp(page?.version?.when)) {
            yield this.record(page, root.spaceKey);
          }
        }
        this.metrics.lastCheckpoint = this.withSourceWatermark({
          phase: "pages",
          rootIndex,
          rootPageRef,
        });
        continue;
      }

      let page = rootIndex === startRootIndex ? (checkpoint.start ?? 0) : 0;
      if (page === 0) {
        const rootPage = await this.callWithRetry(
          () => callClient(this.client, "fetchPage", [root.spaceKey, root.pageId], signal),
          signal,
        );
        const rootId = pageId(rootPage);
        if (!emittedPageIds.has(rootId)) {
          emittedPageIds.add(rootId);
          if (this.shouldEmitSourceTimestamp(rootPage?.version?.when)) {
            yield this.record(rootPage, root.spaceKey);
          }
        }
      }
      while (true) {
        const result = await this.callWithRetry(
          () => callClient(
            this.client,
            "fetchPageTree",
            [root.spaceKey, root.pageId, page],
            signal,
          ),
          signal,
        );
        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const nextPage = Array.isArray(result) ? undefined : result?.nextPage;
        for (const item of items) {
          const id = pageId(item);
          if (emittedPageIds.has(id)) continue;
          emittedPageIds.add(id);
          if (this.shouldEmitSourceTimestamp(item?.version?.when)) {
            yield this.record(item, root.spaceKey);
          }
        }
        this.metrics.lastCheckpoint = this.withSourceWatermark({
          phase: "pages",
          rootIndex,
          rootPageRef,
          start: nextPage !== undefined ? (nextPage.start ?? nextPage) : page,
        });
        if (nextPage === undefined || nextPage === null) break;
        page = nextPage;
      }
    }
  }

  async *collectPagesByText(query, { signal } = {}) {
    signal?.throwIfAborted();
    const validation = await this.validateConfiguration();
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    if (typeof this.client.fetchPagesByText !== "function") {
      throw new TypeError("The Confluence client does not support contextual search");
    }
    const pages = await this.callWithRetry(
      () => callClient(this.client, "fetchPagesByText", [query], signal),
      signal,
    );
    for (const page of pages) {
      const spaceKey = page?.space?.key;
      if (typeof spaceKey !== "string" || !this.spaceKeys.includes(spaceKey)) {
        throw new TypeError("Confluence search returned a page outside the configured spaces");
      }
      yield this.record(page, spaceKey);
    }
  }

  record(page, spaceKey) {
    this.metrics.records += 1;
    const id = pageId(page);
    return createRawEvidenceRecord({
      tenantId: this.tenantId,
      productId: this.productId,
      source: "confluence",
      sourceId: id,
      sourceVersion: pageVersion(page),
      sourceUrl: `${this.baseUrl}/pages/viewpage.action?pageId=${encodeURIComponent(id)}`,
      observedAt: this.now(),
      contentType: "confluence.page",
      payload: page,
      classification: "internal",
      idempotencyKey: sha256(`confluence:${spaceKey}:${id}:${pageVersion(page)}:${sha256(page)}`),
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
      pluginId: confluenceManifest.id,
      status: this.metrics.failures === 0 ? "healthy" : "degraded",
      credentialRef: this.credentialRef,
      ...this.metrics,
    };
  }
}
