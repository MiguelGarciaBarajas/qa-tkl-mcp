import { ApiError } from "./errors.js";

/**
 * Knowledge Inventory / Quality Overview aggregate (UI-105).
 *
 * Produces one bounded, aggregate-only intelligence snapshot for a tenant/product scope by
 * composing durable stores through their *count/metadata* primitives only. It never calls
 * `rawStore.listRecords()` or any other unbounded list API, never loads raw payloads, and
 * never triggers a source synchronization: opening the raw evidence store only reads
 * already-durable data (no connector — including TestRail/ReportPortal — is contacted).
 *
 * Every tier reports an explicit `available` flag. When a durable read fails or a dependency
 * is not wired, the affected tier is flagged unavailable and `meta.partial` is set to `true`
 * rather than silently returning fabricated zero counts.
 */

const DEAD_LETTER_METADATA_LIMIT = 500;

const SOURCE_DEFINITIONS = Object.freeze([
  { source: "jira", displayName: "Jira", connectorId: "connector.jira" },
  { source: "github", displayName: "GitHub", connectorId: "connector.github" },
  { source: "testrail", displayName: "TestRail", connectorId: "connector.testrail" },
  { source: "confluence", displayName: "Confluence", connectorId: "connector.confluence" },
  { source: "reportportal", displayName: "ReportPortal", connectorId: "connector.reportportal" },
]);

const CONNECTOR_TO_SOURCE = new Map(
  SOURCE_DEFINITIONS.map((definition) => [definition.connectorId, definition.source]),
);

export function createKnowledgeInventoryService({
  knowledgeService,
  rawEvidenceStoreProvider,
  sourceConnectionService,
  now = () => new Date().toISOString(),
} = {}) {
  const canReadCanonical =
    !!knowledgeService && typeof knowledgeService.getStore === "function";

  async function getInventory({ productId, source }) {
    if (typeof productId !== "string" || productId.length === 0) {
      throw new ApiError(400, "invalid_request", "A productId is required.", {
        parameter: "productId",
      });
    }

    const notes = [];
    const limitations = [];
    let partial = false;
    const markPartial = (note) => {
      partial = true;
      if (note) notes.push(note);
    };

    const canonical = readCanonicalKnowledge({
      knowledgeService,
      canReadCanonical,
      productId,
      markPartial,
    });
    const bronze = await readCollectedEvidence({
      rawEvidenceStoreProvider,
      productId,
      source,
      markPartial,
      limitations,
    });
    const syncStatus = await readSyncStatus({
      sourceConnectionService,
      productId,
      markPartial,
    });

    const coverage = buildCoverage(canonical, notes, limitations);
    const pipeline = buildPipeline(canonical, bronze);
    const collectedEvidence = buildCollectedEvidence(bronze, source);
    const canonicalKnowledge = buildCanonicalKnowledge(canonical);
    const freshness = buildFreshness(bronze);
    const actionableGaps = buildActionableGaps({
      coverage,
      canonicalKnowledge,
      pipeline,
      collectedEvidence,
      syncStatus,
    });

    limitations.push(
      "Canonical (Silver) counts are product-scoped; the optional source filter narrows only"
        + " the collected-evidence (Bronze) tier.",
      "Pending-projection counts are store-wide and not attributable to a single source;"
        + " dead-letter counts are attributed by connector where available.",
      "Records (24h) shown on Connector Health is recent runtime activity, not the total"
        + " retained knowledge reported here.",
    );

    return {
      productId,
      generatedAt: now(),
      source: source ?? null,
      collectedEvidence,
      canonicalKnowledge,
      coverage,
      pipeline,
      syncStatus,
      actionableGaps,
      freshness,
      meta: {
        generatedAt: now(),
        partial,
        truncated: bronze.truncated === true,
        notes,
        limitations,
      },
    };
  }

  return Object.freeze({ getInventory });
}

function readCanonicalKnowledge({ knowledgeService, canReadCanonical, productId, markPartial }) {
  if (!canReadCanonical) {
    markPartial(
      "Canonical knowledge store accessor is not configured; canonical metrics are"
        + " unavailable.",
    );
    return { available: false, summary: null };
  }
  let store;
  try {
    store = knowledgeService.getStore(productId);
  } catch (error) {
    markPartial(
      "Canonical knowledge store could not be opened; canonical metrics are unavailable.",
    );
    return { available: false, summary: null };
  }
  if (!store || typeof store.inventorySummary !== "function") {
    markPartial(
      "Canonical knowledge store is not initialized for this product; canonical metrics"
        + " are unavailable.",
    );
    return { available: false, summary: null };
  }
  try {
    return { available: true, summary: store.inventorySummary() };
  } catch (error) {
    markPartial("Canonical knowledge aggregate failed; canonical metrics are unavailable.");
    return { available: false, summary: null };
  }
}

async function readCollectedEvidence({
  rawEvidenceStoreProvider,
  productId,
  source,
  markPartial,
  limitations,
}) {
  if (typeof rawEvidenceStoreProvider !== "function") {
    markPartial(
      "Raw evidence store is not configured for this deployment; collected-evidence"
        + " (Bronze) inventory is unavailable.",
    );
    return { available: false };
  }

  let store;
  try {
    store = await rawEvidenceStoreProvider(productId);
  } catch (error) {
    markPartial(
      "Raw evidence store could not be opened; collected-evidence (Bronze) inventory is"
        + " unavailable.",
    );
    return { available: false };
  }
  if (!store || typeof store.sourceInventory !== "function") {
    markPartial(
      "Raw evidence store does not expose bounded inventory metadata; collected-evidence"
        + " inventory is unavailable.",
    );
    return { available: false };
  }

  try {
    const inventory = store.sourceInventory();
    const filtered = source
      ? inventory.filter((entry) => entry.source === source)
      : inventory;
    const pendingProjection = safeCount(() => store.countPendingProjectionRecords());
    const deadLetterTotal = safeCount(() => store.countDeadLetterProjectionRecords());
    const deadLetterMetadata =
      typeof store.listDeadLetterProjectionRecords === "function"
        ? store.listDeadLetterProjectionRecords(DEAD_LETTER_METADATA_LIMIT)
        : [];
    const truncated = deadLetterMetadata.length >= DEAD_LETTER_METADATA_LIMIT
      && deadLetterTotal > deadLetterMetadata.length;
    if (truncated) {
      limitations.push(
        "Dead-letter attribution is truncated to the first"
          + ` ${DEAD_LETTER_METADATA_LIMIT} records; the total is reported separately.`,
      );
    }
    const deadLetterBySource = attributeDeadLetter(deadLetterMetadata);

    return {
      available: true,
      inventory: filtered,
      totalRetainedRecords: filtered.reduce((total, entry) => total + entry.recordCount, 0),
      pendingProjectionTotal: pendingProjection,
      deadLetterTotal,
      deadLetterBySource,
      truncated,
    };
  } catch (error) {
    markPartial(
      "Raw evidence inventory read failed; collected-evidence (Bronze) inventory is"
        + " unavailable.",
    );
    return { available: false };
  }
}

async function readSyncStatus({ sourceConnectionService, productId, markPartial }) {
  if (!sourceConnectionService || typeof sourceConnectionService.list !== "function") {
    markPartial(
      "Source connection service is not configured; sync/freshness status is unavailable.",
    );
    return {
      available: false,
      sources: [],
      note:
        "Connected-source status reflects runtime connection health, not durable inventory.",
    };
  }
  try {
    const connections = await sourceConnectionService.list({ productId });
    return {
      available: true,
      sources: connections.map((connection) => ({
        source: connection.source,
        displayName: connection.displayName,
        status: connection.status,
        configured: connection.configured === true,
        connected: connection.status === "connected",
        lastSyncAt: connection.lastSyncAt ?? null,
        lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt ?? null,
        error: connection.error ?? null,
      })),
      note:
        "Connected-source status reflects runtime connection health, not durable inventory."
        + " A zero runtime count does not imply data loss or require a resync.",
    };
  } catch (error) {
    markPartial("Source connection status read failed; sync/freshness status is unavailable.");
    return {
      available: false,
      sources: [],
      note:
        "Connected-source status reflects runtime connection health, not durable inventory.",
    };
  }
}

function buildCollectedEvidence(bronze, source) {
  if (!bronze.available) {
    return {
      available: false,
      totalRetainedRecords: null,
      bySource: [],
      pendingProjection: { total: null, attributable: false },
      deadLetter: { total: null, bySource: [] },
    };
  }
  return {
    available: true,
    totalRetainedRecords: bronze.totalRetainedRecords,
    bySource: bronze.inventory.map((entry) => ({
      source: entry.source,
      retainedRecords: entry.recordCount,
      firstObservedAt: entry.firstObservedAt,
      lastObservedAt: entry.lastObservedAt,
      connectorIds: entry.connectorIds,
    })),
    pendingProjection: {
      total: bronze.pendingProjectionTotal,
      attributable: false,
    },
    deadLetter: {
      total: bronze.deadLetterTotal,
      bySource: bronze.deadLetterBySource,
    },
    ...(source ? { filteredSource: source } : {}),
  };
}

function buildCanonicalKnowledge(canonical) {
  if (!canonical.available || !canonical.summary) {
    return {
      available: false,
      entities: { total: null, byType: {} },
      claims: { total: null, byStatus: {} },
      traceLinks: { total: null, deferred: null, byType: {} },
      conflicts: { total: null, open: null },
      reviews: { total: null },
      bySource: [],
    };
  }
  const summary = canonical.summary;
  return {
    available: true,
    entities: summary.entities,
    claims: summary.claims,
    traceLinks: summary.traceLinks,
    conflicts: summary.conflicts,
    reviews: summary.reviews,
    bySource: summary.canonicalSourceProvenance,
  };
}

function buildCoverage(canonical, notes, limitations) {
  const model = {
    numerator:
      "Requirement/story entities linked by at least one explicit-origin 'verifies' trace"
      + " link from a matching test entity (manual-test for manual coverage; test — directly"
      + " or via a manual test's explicit relates_to link — for automation coverage).",
    denominator: "All canonical requirement + story entities in the product scope.",
    trustSignal:
      "Trace link origin === 'explicit' (the same trust signal used by @tkl/analyzer-coverage).",
    confidenceThreshold: null,
    confidenceThresholdNote:
      "No numeric link-confidence cutoff is applied to the mapping buckets; the average"
      + " verify-link confidence is surfaced separately for transparency.",
  };
  if (!canonical.available || !canonical.summary) {
    return {
      available: false,
      requirementTotal: null,
      withManual: null,
      withAutomation: null,
      withBoth: null,
      withNeither: null,
      unmappedTests: null,
      verifyLinkTotal: null,
      averageVerifyLinkConfidence: null,
      manualCoverageRatio: null,
      automationCoverageRatio: null,
      mappedCoverageRatio: null,
      model,
    };
  }
  const coverage = canonical.summary.coverage;
  const total = coverage.requirementTotal;
  const mapped = total - coverage.withNeither;
  limitations.push(
    "Jira 'epic' is not a distinct canonical entity type; requirement and story counts are"
      + " reported and coverage is measured against them.",
  );
  return {
    available: true,
    requirementTotal: total,
    withManual: coverage.withManual,
    withAutomation: coverage.withAutomation,
    withBoth: coverage.withBoth,
    withNeither: coverage.withNeither,
    unmappedTests: coverage.unmappedTests,
    verifyLinkTotal: coverage.verifyLinkTotal,
    averageVerifyLinkConfidence:
      coverage.averageVerifyLinkConfidence === null
        ? null
        : round(coverage.averageVerifyLinkConfidence, 4),
    manualCoverageRatio: ratio(coverage.withManual, total),
    automationCoverageRatio: ratio(coverage.withAutomation, total),
    mappedCoverageRatio: ratio(mapped, total),
    model,
  };
}

function buildPipeline(canonical, bronze) {
  const servingBacklog = canonical.available && canonical.summary
    ? canonical.summary.pendingServingProjections
    : null;
  return {
    available: canonical.available || bronze.available,
    servingProjectionBacklog: servingBacklog,
    servingCurrent: servingBacklog === null ? null : servingBacklog === 0,
    rawProjectionBacklog: bronze.available ? bronze.pendingProjectionTotal : null,
    rawDeadLetterBacklog: bronze.available ? bronze.deadLetterTotal : null,
  };
}

function buildFreshness(bronze) {
  if (!bronze.available) {
    return { newestObservedAt: null, oldestObservedAt: null };
  }
  let newest = null;
  let oldest = null;
  for (const entry of bronze.inventory) {
    if (entry.lastObservedAt && (newest === null || entry.lastObservedAt > newest)) {
      newest = entry.lastObservedAt;
    }
    if (entry.firstObservedAt && (oldest === null || entry.firstObservedAt < oldest)) {
      oldest = entry.firstObservedAt;
    }
  }
  return { newestObservedAt: newest, oldestObservedAt: oldest };
}

function buildActionableGaps({
  coverage,
  canonicalKnowledge,
  pipeline,
  collectedEvidence,
  syncStatus,
}) {
  const gaps = [];
  const add = (gap) => {
    if (typeof gap.count === "number" && gap.count > 0) gaps.push(gap);
  };

  if (coverage.available) {
    add({
      id: "missing-tests",
      category: "missing-tests",
      severity: "high",
      count: coverage.withNeither,
      title: "Requirements with no mapped tests",
      recommendedAction:
        "Author manual or automated tests and link them with an explicit 'verifies' trace"
        + " link to close these coverage gaps.",
    });
    add({
      id: "missing-automation",
      category: "missing-automation",
      severity: "medium",
      count: Math.max(coverage.withManual - coverage.withBoth, 0),
      title: "Manually covered requirements lacking automation",
      recommendedAction:
        "Automate the manual tests verifying these requirements and link the automation"
        + " (test entity) to the requirement.",
    });
    add({
      id: "unmapped-tests",
      category: "unmapped-evidence",
      severity: "medium",
      count: coverage.unmappedTests,
      title: "Tests not mapped to any requirement",
      recommendedAction:
        "Add explicit 'verifies' trace links from these tests to the requirements they"
        + " exercise so their coverage is credited.",
    });
  }

  if (canonicalKnowledge.available) {
    add({
      id: "unresolved-conflicts",
      category: "unresolved-conflicts",
      severity: "high",
      count: canonicalKnowledge.conflicts.open,
      title: "Open knowledge conflicts",
      recommendedAction:
        "Review open conflicts in Knowledge Conflicts and approve the correct claim(s).",
    });
    add({
      id: "deferred-links",
      category: "deferred-links",
      severity: "low",
      count: canonicalKnowledge.traceLinks.deferred,
      title: "Deferred trace links awaiting endpoints",
      recommendedAction:
        "Ingest the missing endpoint entities so deferred trace links can resolve.",
    });
  }

  if (pipeline.available) {
    add({
      id: "serving-backlog",
      category: "backlog",
      severity: "medium",
      count: pipeline.servingProjectionBacklog ?? 0,
      title: "Serving (Gold) projection backlog",
      recommendedAction:
        "Drain the serving projection outbox so search results reflect the latest canonical"
        + " knowledge.",
    });
    add({
      id: "pending-projection",
      category: "backlog",
      severity: "medium",
      count: pipeline.rawProjectionBacklog ?? 0,
      title: "Raw evidence pending projection to canonical",
      recommendedAction:
        "Run a bounded projection drain to fold pending raw evidence into canonical knowledge.",
    });
    add({
      id: "dead-letter",
      category: "dead-letter",
      severity: "high",
      count: pipeline.rawDeadLetterBacklog ?? 0,
      title: "Raw evidence dead-lettered after repeated projection failures",
      recommendedAction:
        "Investigate the failing records and requeue them once the normalizer defect is fixed.",
    });
  }

  if (syncStatus.available) {
    const staleSources = syncStatus.sources.filter(
      (entry) => entry.configured && entry.lastSuccessfulSyncAt === null,
    );
    if (staleSources.length > 0) {
      gaps.push({
        id: "stale-source",
        category: "stale-source",
        severity: "medium",
        count: staleSources.length,
        title: "Connected sources without a successful sync",
        recommendedAction:
          "Run a synchronization for these connected sources to populate durable inventory.",
      });
    }
    const erroredSources = syncStatus.sources.filter((entry) => entry.error !== null);
    if (erroredSources.length > 0) {
      gaps.push({
        id: "errored-source",
        category: "stale-source",
        severity: "high",
        count: erroredSources.length,
        title: "Sources reporting a connection or sync error",
        recommendedAction:
          "Resolve the reported source error in Source Connections and retest the connection.",
      });
    }
  }

  const severityRank = { high: 0, medium: 1, low: 2 };
  return gaps.sort(
    (left, right) => (severityRank[left.severity] ?? 3) - (severityRank[right.severity] ?? 3),
  );
}

function attributeDeadLetter(metadata) {
  const bySource = new Map();
  for (const item of metadata) {
    const source = CONNECTOR_TO_SOURCE.get(item.connectorId) ?? "unattributed";
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
  }
  return [...bySource.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => left.source.localeCompare(right.source));
}

function safeCount(reader) {
  try {
    const value = reader();
    return Number.isSafeInteger(value) ? value : 0;
  } catch {
    return 0;
  }
}

function ratio(numerator, denominator) {
  if (!denominator || denominator <= 0) return null;
  return round(numerator / denominator, 4);
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
