const DEFAULT_BUDGETS = Object.freeze({
  timeoutMs: 30_000,
  jiraIssues: 3,
  testRailCases: 100,
  similarCases: 5,
  graphDepth: 3,
  graphNodes: 150,
  confluenceQueries: 2,
  reportPortalIdentities: 3,
});

const JIRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const MAX_CACHE_ENTRIES = 500;
const SECRET_PATTERN =
  /\b(password|passwd|pwd|secret|token|otp|api[_ -]?key)\b\s*[:=]\s*\S+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function createCrossSourceContextCoordinator({
  knowledgeService,
  sourceConnectionService,
  freshnessMs = 15 * 60 * 1_000,
  now = () => Date.now(),
  auditLogger,
} = {}) {
  if (!knowledgeService?.getTestRailCaseImprovementContext) {
    throw new TypeError("knowledgeService.getTestRailCaseImprovementContext is required");
  }
  if (!sourceConnectionService?.list) {
    throw new TypeError("sourceConnectionService.list is required");
  }
  const cache = new Map();
  const inflight = new Map();

  return Object.freeze({
    async enrich(request) {
      const normalized = normalizeRequest(request);
      pruneCache(cache, now(), freshnessMs);
      const cacheKey = `${normalized.productId}:${normalized.anchor.source}:`
        + `${normalized.anchor.type}:${normalized.anchor.externalId}`;
      const cached = cache.get(cacheKey);
      if (cached && now() - cached.createdAt <= freshnessMs) {
        return {
          ...cached.value,
          intent: normalized.intent,
          cache: { hit: true, freshnessMs },
        };
      }
      const active = inflight.get(cacheKey);
      if (active) return active;
      const operation = enrichContext({
        request: normalized,
        knowledgeService,
        sourceConnectionService,
        auditLogger,
      }).then((value) => {
        while (cache.size >= MAX_CACHE_ENTRIES) {
          cache.delete(cache.keys().next().value);
        }
        cache.set(cacheKey, { createdAt: now(), value });
        return {
          ...value,
          intent: normalized.intent,
          cache: { hit: false, freshnessMs },
        };
      }).finally(() => {
        if (inflight.get(cacheKey) === operation) inflight.delete(cacheKey);
      });
      inflight.set(cacheKey, operation);
      return operation;
    },
    clear(productId) {
      for (const key of cache.keys()) {
        if (!productId || key.startsWith(`${productId}:`)) cache.delete(key);
      }
    },
  });
}

async function enrichContext({
  request,
  knowledgeService,
  sourceConnectionService,
  auditLogger,
}) {
  const startedAt = new Date().toISOString();
  const connections = await sourceConnectionService.list({ productId: request.productId });
  const sourceStatus = statusFromConnections(connections);
  const limitations = [];
  const retrievals = [];
  let localContext = await readAnchorContext(request, knowledgeService);
  let neighborhoodCaseIds;

  if (!localContext.trace) {
    await attemptSource({
      source: request.anchor.source,
      sourceStatus,
      retrievals,
      limitations,
      operation: () => hydrateAnchor(request, sourceConnectionService),
      linked: true,
    });
    localContext = await readAnchorContext(request, knowledgeService);
  } else {
    markSource(sourceStatus, request.anchor.source, "local", {
      detail: "The exact anchor was already present in canonical knowledge.",
      hydrated: true,
      linked: true,
    });
  }

  if (!localContext.trace) {
    return finalizeContext({
      request,
      localContext,
      sourceStatus,
      limitations: [...limitations, "The exact anchor could not be hydrated."],
      retrievals,
      startedAt,
    });
  }

  if (request.testRailScope) {
    const section = await attemptSource({
      source: "testrail",
      sourceStatus,
      retrievals,
      limitations,
      operation: () => sourceConnectionService.hydrateTestRailSectionCases?.({
        productId: request.productId,
        suiteId: request.testRailScope.suiteId,
        sectionId: request.testRailScope.sectionId,
        maxRecords: request.budgets.testRailCases,
      }),
      linked: false,
    });
    neighborhoodCaseIds = section?.caseIds;
    localContext = await readAnchorContext(request, knowledgeService);
  }

  if (request.anchor.source === "testrail") {
    const neighborhood = await attemptSource({
      source: "testrail",
      sourceStatus,
      retrievals,
      limitations,
      operation: () => sourceConnectionService.hydrateTestRailCaseNeighborhood?.({
        productId: request.productId,
        caseId: request.anchor.externalId,
        maxRecords: request.budgets.testRailCases,
      }),
      linked: true,
    });
    neighborhoodCaseIds = neighborhood?.caseIds;
    localContext = await readAnchorContext(request, knowledgeService);
  }

  const jiraKeys = unique([
    ...(request.anchor.source === "jira" ? [request.anchor.externalId] : []),
    ...explicitJiraKeys(localContext),
  ])
    .slice(0, request.budgets.jiraIssues);
  if (jiraKeys.length === 0) {
    markSource(
      sourceStatus,
      "jira",
      connectionState(sourceStatus, "jira") === "not-connected" ? "not-connected" : "not-linked",
      {
      detail: "No explicit Jira reference was available from the anchor.",
      linked: false,
      },
    );
    markSource(
      sourceStatus,
      "github",
      connectionState(sourceStatus, "github") === "not-connected"
        ? "not-connected"
        : "not-linked",
      {
      detail: "GitHub enrichment requires an explicit Jira or automation reference.",
      linked: false,
      },
    );
  }
  for (const issueKey of jiraKeys) {
    await attemptSource({
      source: "jira",
      sourceStatus,
      retrievals,
      limitations,
      operation: () => sourceConnectionService.hydrateJiraIssue?.({
        productId: request.productId,
        issueKey,
      }),
      linked: true,
    });
    const relatedSource = connectionState(sourceStatus, "github") !== "not-connected"
      ? "github"
      : "testrail";
    const related = await attemptSource({
      source: relatedSource,
      sourceStatus,
      retrievals,
      limitations,
      operation: () => sourceConnectionService.enrichJiraIssue?.({
        productId: request.productId,
        issueKey,
      }),
      reportErrors: false,
      recordResult: false,
    });
    if (related?.testrail) {
      retrievals.push({ source: "testrail", ...safeRetrievalResult(related.testrail) });
      mergeRetrievalStatus(sourceStatus, "testrail", related.testrail, { linked: true });
    }
    if (related?.github) {
      retrievals.push({ source: "github", ...safeRetrievalResult(related.github) });
      mergeRetrievalStatus(sourceStatus, "github", related.github, { linked: true });
    }
  }

  localContext = await readAnchorContext(request, knowledgeService);
  const graph = await knowledgeService.getEvidenceGraph?.({
    productId: request.productId,
    entityId: anchorEntity(request, localContext).id,
    maxDepth: request.budgets.graphDepth,
    maxNodes: request.budgets.graphNodes,
  });
  const identities = stableExecutionIdentities(localContext, graph)
    .slice(0, request.budgets.reportPortalIdentities);
  if (identities.length === 0) {
    markSource(
      sourceStatus,
      "reportportal",
      connectionState(sourceStatus, "reportportal") === "not-connected"
        ? "not-connected"
        : "not-linked",
      {
      detail: "No stable codeRef or uniqueId could be derived from linked automation.",
      linked: false,
      },
    );
  }
  for (const identity of identities) {
    await attemptSource({
      source: "reportportal",
      sourceStatus,
      retrievals,
      limitations,
      operation: () => sourceConnectionService.hydrateReportPortalTestHistory?.({
        productId: request.productId,
        identity,
      }),
      linked: true,
    });
  }

  const documentationQueries = unique([
    ...jiraKeys,
    sanitizedText(anchorEntity(request, localContext).title ?? ""),
  ]).filter((value) => value.length >= 3)
    .slice(0, request.budgets.confluenceQueries);
  for (const query of documentationQueries) {
    await attemptSource({
      source: "confluence",
      sourceStatus,
      retrievals,
      limitations,
      operation: () => sourceConnectionService.hydrateConfluenceContext?.({
        productId: request.productId,
        query,
      }),
      reportErrors: false,
    });
  }

  localContext = await readAnchorContext(request, knowledgeService);
  const finalGraph = await knowledgeService.getEvidenceGraph?.({
    productId: request.productId,
    entityId: anchorEntity(request, localContext).id,
    maxDepth: request.budgets.graphDepth,
    maxNodes: request.budgets.graphNodes,
  });
  emitAudit(auditLogger, {
    eventType: "knowledge.cross_source_context.completed",
    productId: request.productId,
    source: request.anchor.source,
    resourceId: request.anchor.externalId,
    linkedSourceCount: Object.values(sourceStatus).filter((item) => item.linked).length,
  });
  return finalizeContext({
    request,
    localContext,
    graph: finalGraph,
    neighborhoodCaseIds,
    sourceStatus,
    limitations,
    retrievals,
    startedAt,
  });
}

function normalizeRequest(request) {
  if (!request?.productId) throw new TypeError("productId is required");
  if (!request?.anchor || !["jira", "testrail"].includes(request.anchor.source)) {
    throw new TypeError("A Jira or TestRail anchor is required");
  }
  const rawExternalId = String(request.anchor.externalId ?? "").trim();
  const externalId = request.anchor.source === "testrail"
    ? rawExternalId.replace(/^C/i, "")
    : rawExternalId.toUpperCase();
  if (
    request.anchor.source === "testrail"
      ? !/^\d+$/.test(externalId) || BigInt(externalId) <= 0n
      : !JIRA_KEY_PATTERN.test(externalId)
  ) {
    throw new TypeError(
      request.anchor.source === "testrail"
        ? "anchor.externalId must be a positive TestRail case ID"
        : "anchor.externalId must be a valid Jira issue key",
    );
  }
  const budgets = { ...DEFAULT_BUDGETS, ...(request.budgets ?? {}) };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`budgets.${name} must be a positive integer`);
    }
  }
  budgets.testRailCases = Math.min(100, budgets.testRailCases);
  budgets.similarCases = Math.min(10, budgets.similarCases);
  return {
    productId: request.productId,
    anchor: {
      source: request.anchor.source,
      type: request.anchor.source === "testrail" ? "manual-test" : "requirement",
      externalId: request.anchor.source === "testrail"
        ? BigInt(externalId).toString()
        : externalId,
    },
    intent: request.intent ?? "test-case-improvement",
    ...(normalizeTestRailScope(request.testRailScope)
      ? { testRailScope: normalizeTestRailScope(request.testRailScope) }
      : {}),
    budgets,
  };
}

function normalizeTestRailScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalizeId = (candidate) => {
    const text = typeof candidate === "string" || typeof candidate === "number"
      ? String(candidate).trim()
      : "";
    return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text).toString() : null;
  };
  const suiteId = normalizeId(value.suiteId);
  const sectionId = normalizeId(value.sectionId);
  return suiteId && sectionId ? { suiteId, sectionId } : null;
}

async function readAnchorContext(request, knowledgeService) {
  if (request.anchor.source === "jira") {
    return knowledgeService.getCoverageContext({
      productId: request.productId,
      workItemId: request.anchor.externalId,
    });
  }
  return knowledgeService.getTestRailCaseImprovementContext({
    productId: request.productId,
    caseId: request.anchor.externalId,
  });
}

function hydrateAnchor(request, sourceConnectionService) {
  if (request.anchor.source === "jira") {
    return sourceConnectionService.hydrateJiraIssue?.({
      productId: request.productId,
      issueKey: request.anchor.externalId,
    });
  }
  return sourceConnectionService.hydrateTestRailCase?.({
    productId: request.productId,
    caseId: request.anchor.externalId,
  });
}

function finalizeContext({
  request,
  localContext,
  graph,
  neighborhoodCaseIds,
  sourceStatus,
  limitations,
  retrievals,
  startedAt,
}) {
  const anchorContext = localContext.caseContexts?.[0];
  const anchor = anchorEntity(request, localContext);
  const graphNodes = graph?.nodes ?? [];
  const traceTests = localContext.trace?.tests ?? [];
  const candidates = similarCaseCandidates(
    anchorContext,
    neighborhoodCaseIds?.length
      ? (localContext.allManualTestContexts ?? []).filter((item) =>
          neighborhoodCaseIds.includes(item.testCase.id.replace(/^manual-test:testrail:/, "")))
      : localContext.allManualTestContexts ?? [],
    request.budgets.similarCases,
  );
  const explicitRelationships = uniqueById([
    ...(localContext.trace?.relationships ?? []),
    ...(anchorContext?.relationships ?? []),
    ...(graph?.edges ?? []),
  ]);
  const citations = uniqueCitations([
    ...(localContext.trace?.requirements ?? []).flatMap(provenanceEntries),
    ...(localContext.caseContexts ?? []).flatMap((item) => [
      ...provenanceEntries(item.testCase),
      ...item.claims.flatMap(provenanceEntries),
      ...item.relationships.flatMap(provenanceEntries),
    ]),
    ...(graph?.nodes ?? []).flatMap(provenanceEntries),
    ...(graph?.edges ?? []).flatMap(provenanceEntries),
  ]);
  const hydratedSources = Object.entries(sourceStatus)
    .filter(([, status]) => status.hydrated)
    .map(([source]) => source);
  const linkedSources = Object.entries(sourceStatus)
    .filter(([, status]) => status.linked)
    .map(([source]) => source);
  return {
    productId: request.productId,
    generatedAt: new Date().toISOString(),
    startedAt,
    intent: request.intent,
    budgets: request.budgets,
    anchor,
    requirements: localContext.trace?.requirements ?? [],
    manualTests: uniqueById([
      ...(localContext.allManualTestContexts ?? []).map((item) => item.testCase),
      ...traceTests.filter((item) => item.type === "manual-test"),
    ]),
    automatedTests: uniqueById([
      ...traceTests.filter((item) => item.type === "automated-test"),
      ...graphNodes.filter((node) => node.type === "automated-test"),
    ]),
    executions: graphNodes.filter((node) => node.type === "test-execution"),
    defects: graphNodes.filter((node) => node.type === "defect"),
    documentation: graphNodes.filter((node) =>
      ["document", "documentation"].includes(node.type)),
    reusableComponents: graphNodes.filter((node) =>
      ["repository-file", "automation-component"].includes(node.type)),
    relationships: explicitRelationships,
    candidateRelationships: candidates,
    sourceStatus,
    retrievals,
    limitations: unique([
      ...limitations,
      ...(graph?.truncated ? ["The evidence graph reached its configured node budget."] : []),
      ...(candidates.length > 0
        ? ["Similarity candidates require reviewer approval before becoming trace links."]
        : []),
    ]),
    confidence: {
      level: linkedSources.length >= 3 ? "high"
        : linkedSources.length >= 1 || candidates.length > 0 ? "medium" : "low",
      rationale: `${hydratedSources.length} source(s) were hydrated and `
        + `${linkedSources.length} source(s) have grounded links to the anchor.`,
    },
    citations,
  };
}

async function attemptSource({
  source,
  sourceStatus,
  retrievals,
  limitations,
  operation,
  reportErrors = true,
  linked = false,
  recordResult = true,
}) {
  if (connectionState(sourceStatus, source) === "not-connected" || !operation) return null;
  try {
    const result = await operation();
    if (!result) return null;
    if (recordResult) retrievals.push({ source, ...safeRetrievalResult(result) });
    mergeRetrievalStatus(sourceStatus, source, result, { linked });
    return result;
  } catch (error) {
    markSource(sourceStatus, source, "unavailable", {
      detail: safeErrorMessage(error),
      errorCode: error?.code ?? "retrieval_failed",
    });
    if (reportErrors) {
      limitations.push(`${source} retrieval was unavailable: ${safeErrorMessage(error)}`);
    }
    return null;
  }
}

function statusFromConnections(connections) {
  return Object.fromEntries((connections ?? []).map((connection) => [
    connection.source,
    {
      state: connection.status === "connected" ? "connected" : "not-connected",
      connected: connection.status === "connected",
      hydrated: false,
      linked: false,
      recordsCollected: 0,
      truncated: false,
      detail: connection.status === "connected"
        ? "Credentials are configured; evidence has not yet been linked for this request."
        : "The source is not connected.",
    },
  ]));
}

function mergeRetrievalStatus(statuses, source, result, { linked = false } = {}) {
  const state = result?.status === "partial" ? "partial"
    : result?.status === "not-connected" ? "not-connected"
      : result?.status === "unavailable" ? "unavailable" : "complete";
  markSource(statuses, source, state, {
    hydrated: ["complete", "partial"].includes(state),
    linked: statuses[source]?.linked === true
      || linked && Number(result?.recordsCollected ?? 0) > 0,
    recordsCollected: Number(result?.recordsCollected ?? 0),
    truncated: result?.truncated === true,
    detail: result?.recordsCollected === 0
      ? "The bounded query completed but returned no related records."
      : `The bounded query collected ${result?.recordsCollected ?? 0} record(s).`,
  });
}

function markSource(statuses, source, state, details = {}) {
  const existing = statuses[source] ?? {
    connected: false,
    hydrated: false,
    linked: false,
    recordsCollected: 0,
    truncated: false,
  };
  statuses[source] = {
    ...existing,
    ...details,
    state,
    connected: details.connected ?? existing.connected,
    hydrated: details.hydrated ?? existing.hydrated,
    linked: details.linked ?? existing.linked,
  };
}

function connectionState(statuses, source) {
  return statuses[source]?.state ?? "not-connected";
}

function explicitJiraKeys(context) {
  return unique((context.caseContexts ?? []).flatMap((item) => [
    ...item.requirementIds.map((id) => id.replace(/^requirement:/, "")),
    ...item.claims
      .filter((claim) => claim.attribute === "custom_jira_references")
      .flatMap((claim) => Array.isArray(claim.value) ? claim.value : [claim.value]),
  ]).map((value) => String(value).toUpperCase())
    .filter((value) => JIRA_KEY_PATTERN.test(value)));
}

function anchorEntity(request, context) {
  if (request.anchor.source === "jira") {
    return context.trace?.story
      ?? context.trace?.requirements?.find((item) =>
        item.id === `requirement:${request.anchor.externalId}`)
      ?? {
        id: `requirement:${request.anchor.externalId}`,
        type: "requirement",
        title: request.anchor.externalId,
      };
  }
  return context.caseContexts?.[0]?.testCase ?? {
    id: `manual-test:testrail:${request.anchor.externalId}`,
    type: "manual-test",
    title: `C${request.anchor.externalId}`,
  };
}

function stableExecutionIdentities(context, graph) {
  return unique([
    ...(graph?.nodes ?? []).filter((node) => node.type === "automated-test")
      .flatMap((node) => [node.codeRef, node.uniqueId].filter(Boolean)),
    ...(context.caseContexts ?? []).flatMap((item) =>
      item.relationships
        .filter((link) => link.type === "relates_to")
        .map((link) => link.toEntityId)
        .filter((id) => /^automated-test:/.test(id))),
  ]).filter((identity) => identity.length <= 500);
}

function similarCaseCandidates(anchorContext, allCases, limit) {
  if (!anchorContext?.testCase) return [];
  const anchorText = caseText(anchorContext);
  return allCases
    .filter((item) => item.testCase.id !== anchorContext.testCase.id)
    .map((item) => ({
      item,
      score: jaccard(tokens(anchorText), tokens(caseText(item))),
    }))
    .filter(({ score }) => score >= 0.2)
    .sort((left, right) =>
      right.score - left.score
      || left.item.testCase.id.localeCompare(right.item.testCase.id))
    .slice(0, limit)
    .map(({ item, score }) => ({
      id: `candidate:${anchorContext.testCase.id}:${item.testCase.id}`,
      fromEntityId: anchorContext.testCase.id,
      toEntityId: item.testCase.id,
      type: "similar_to",
      origin: "inferred",
      confidence: Number(score.toFixed(3)),
      status: "review-required",
      rationale: "Bounded title and step-token similarity within the retrieved TestRail neighborhood.",
      citations: uniqueCitations([
        ...provenanceEntries(anchorContext.testCase),
        ...provenanceEntries(item.testCase),
      ]),
    }));
}

function caseText(caseContext) {
  const values = caseContext.claims
    .filter((claim) => [
      "title",
      "custom_preconds",
      "custom_steps",
      "custom_steps_separated",
      "custom_expected",
    ].includes(claim.attribute))
    .flatMap((claim) => flattenText(claim.value));
  return sanitizedText([caseContext.testCase.title, ...values].join(" "));
}

function flattenText(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenText);
  return [];
}

function sanitizedText(value) {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(SECRET_PATTERN, "$1=[REDACTED]")
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []);
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function provenanceEntries(value) {
  return Array.isArray(value?.provenance)
    ? value.provenance
    : value?.provenance ? [value.provenance] : [];
}

function uniqueCitations(values) {
  return values.filter(Boolean).filter((value, index, all) =>
    all.findIndex((candidate) =>
      candidate.source === value.source
      && candidate.sourceId === value.sourceId
      && candidate.sourceVersion === value.sourceVersion
      && candidate.contentHash === value.contentHash) === index);
}

function safeRetrievalResult(result) {
  return Object.fromEntries(Object.entries(result).filter(([key, value]) =>
    ["status", "recordsCollected", "recordsCommitted", "duplicateRecords", "truncated"]
      .includes(key)
    && ["string", "number", "boolean"].includes(typeof value)));
}

function safeErrorMessage(error) {
  if (typeof error?.message !== "string" || error.message.trim().length === 0) {
    return "The bounded source query failed.";
  }
  return sanitizedText(error.message).slice(0, 300);
}

function unique(values) {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function uniqueById(values) {
  return values.filter((value, index) =>
    value?.id && values.findIndex((candidate) => candidate?.id === value.id) === index);
}

function emitAudit(logger, event) {
  if (typeof logger?.log === "function") logger.log(event);
  else if (typeof logger?.write === "function") logger.write(event);
}

function pruneCache(cache, currentTime, freshnessMs) {
  const cutoff = currentTime - freshnessMs;
  for (const [key, entry] of cache) {
    if (entry.createdAt < cutoff) cache.delete(key);
  }
}
