import { createRawEvidenceRecord, sha256 } from "@tkl/contracts";

/**
 * Deterministic, source-neutral test doubles for the OPS-101 coordinator.
 *
 * These stand in for a composed connector instance, exposing exactly the
 * surface the coordinator depends on -- `collect(checkpoint)`,
 * `metrics.lastCheckpoint`, and `health()` -- which is the surface the real
 * Jira/GitHub/TestRail connectors (ING-101..103) already implement. No
 * timers, no network, no wall-clock sleeps: every page boundary and failure
 * is explicit.
 */

export function createFixtureRecord({ tenantId, productId, page, index, revision = 1, observedAt }) {
  const sourceId = `page-${page}:item-${index}`;
  const payload = { page, index, revision };
  return createRawEvidenceRecord({
    tenantId,
    productId,
    source: "github",
    sourceId,
    sourceVersion: `v${revision}`,
    observedAt: observedAt ?? `2026-01-0${Math.min(page + 1, 9)}T00:00:0${index % 10}.000Z`,
    contentType: "fixture.item",
    payload,
    classification: "internal",
    idempotencyKey: sha256(`fixture:${sourceId}:v${revision}`),
  });
}

/**
 * A paginated connector whose pages are fixed arrays. `failAtPage` makes
 * collection throw *before* that page is yielded, modelling a source outage
 * or rate-limit exhaustion mid-sync.
 *
 * Checkpoint semantics mirror the real connectors: the cursor recorded
 * while streaming identifies the page to resume from, and a resumed run
 * re-reads that whole page (replayed records are deduplicated by the
 * store's idempotency keys) rather than trusting a mid-page offset that a
 * changing source could invalidate.
 */
export class FixtureConnector {
  constructor({
    tenantId,
    productId,
    pages,
    failAtPage = null,
    failureStatus = 503,
    credentialRef = "secret://fixture/scope",
  }) {
    this.tenantId = tenantId;
    this.productId = productId;
    this.pages = pages;
    this.failAtPage = failAtPage;
    this.failureStatus = failureStatus;
    this.credentialRef = credentialRef;
    this.metrics = { records: 0, retries: 0, failures: 0, lastSyncAt: null, lastCheckpoint: null };
    /** Every checkpoint this connector was resumed from, in call order. */
    this.resumedFrom = [];
  }

  async *collect(checkpoint = {}) {
    this.resumedFrom.push(structuredClone(checkpoint));
    const startPage = Number.isInteger(checkpoint.page) ? checkpoint.page : 0;
    for (let page = startPage; page < this.pages.length; page += 1) {
      if (this.failAtPage !== null && page === this.failAtPage) {
        this.metrics.failures += 1;
        const error = new Error("fixture source failure at https://example.invalid/api?token=abc");
        error.name = "FixtureSourceError";
        error.status = this.failureStatus;
        error.code = "EFIXTURE";
        throw error;
      }
      for (const record of this.pages[page]) {
        this.metrics.lastCheckpoint = { page };
        this.metrics.records += 1;
        yield record;
      }
    }
    this.metrics.lastSyncAt = "2026-01-09T00:00:00.000Z";
  }

  async health() {
    return {
      pluginId: "connector.github",
      status: this.metrics.failures ? "degraded" : "healthy",
      credentialRef: this.credentialRef,
      ...this.metrics,
    };
  }
}

/** A connector that never yields and proposes a non-JSON checkpoint. */
export class UnserializableCheckpointConnector {
  constructor() {
    this.metrics = { lastCheckpoint: { page: 1, resume: () => undefined } };
  }

  // eslint-disable-next-line require-yield -- intentionally yields nothing
  async *collect() {}

  async health() {
    return { pluginId: "connector.github", status: "healthy" };
  }
}

/**
 * A connector whose first page is gated on a promise the test resolves
 * explicitly. Used to hold a run open deterministically while a second,
 * overlapping run is attempted -- no timers, no sleeps.
 */
export class GatedConnector {
  constructor({ pages, gate, onStart }) {
    this.pages = pages;
    this.gate = gate;
    this.onStart = onStart;
    this.metrics = { lastCheckpoint: null, failures: 0 };
    this.started = false;
  }

  async *collect(checkpoint = {}) {
    this.started = true;
    this.resumedFrom = structuredClone(checkpoint);
    // Signals that collection has begun, which -- because the coordinator
    // only calls collect() after taking the run lock -- is the
    // deterministic point at which an overlapping run must be refused.
    this.onStart?.();
    await this.gate;
    for (let page = 0; page < this.pages.length; page += 1) {
      for (const record of this.pages[page]) {
        this.metrics.lastCheckpoint = { page };
        yield record;
      }
    }
  }

  async health() {
    return { pluginId: "connector.github", status: "healthy" };
  }
}

export function createDeferred() {
  let resolve;
  const promise = new Promise((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

/** Monotonic injected clock: deterministic ISO timestamps, one tick per call. */
export function createTestClock(startIso = "2026-02-01T00:00:00.000Z", stepMs = 1000) {
  let current = Date.parse(startIso);
  return () => {
    const value = new Date(current).toISOString();
    current += stepMs;
    return value;
  };
}

export function fixtureProductConfiguration(overrides = {}) {
  return {
    configVersion: "0.1",
    tenantId: "solera",
    productId: "fl-titling",
    enabledPlugins: ["connector.github"],
    plannedPlugins: ["connector.jira", "connector.testrail"],
    credentialRefs: {
      "connector.github": "secret://github/fl-titling",
      "connector.jira": "secret://jira/fl-titling",
      "connector.testrail": "secret://testrail/fl-titling",
    },
    sources: {
      github: {
        enabled: true,
        configurationStatus: "ready",
        repository: "Solera-Engineering/qa-tkl-mcp-f5",
      },
      jira: {
        enabled: false,
        configurationStatus: "pending-external-input",
        baseUrl: "https://jira.app.solera.com/jira",
      },
      testrail: {
        enabled: false,
        configurationStatus: "pending-external-input",
        baseUrlEnv: "TESTRAIL_BASE_URL",
      },
    },
    ...overrides,
  };
}

export function fixturePages({ tenantId, productId, pageCount = 3, itemsPerPage = 2, revision = 1 }) {
  return Array.from({ length: pageCount }, (_unused, page) =>
    Array.from({ length: itemsPerPage }, (_ignored, index) =>
      createFixtureRecord({ tenantId, productId, page, index, revision }),
    ),
  );
}
