const JIRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const TESTRAIL_CASE_PATTERN = /^C?(\d+)$/i;
const REPORTPORTAL_PREFIX_PATTERN = /^(?:rp|reportportal):(.+)$/i;

const SOURCE_TYPES = Object.freeze({
  jira: new Set(["requirement", "story", "defect"]),
  testrail: new Set(["manual-test"]),
  github: new Set(["automated-test", "test"]),
  reportportal: new Set(["execution", "test-execution"]),
  confluence: new Set(["document"]),
});

export function createArtifactResolverService({
  knowledgeService,
  sourceConnectionService,
  maxCandidates = 8,
} = {}) {
  if (!knowledgeService || typeof knowledgeService.search !== "function") {
    throw new TypeError("knowledgeService.search is required");
  }
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 20) {
    throw new TypeError("maxCandidates must be between 1 and 20");
  }

  return {
    async resolve({ productId, query, limit = maxCandidates }) {
      const detected = detectArtifactQuery(query);
      const searchLimit = Math.min(limit, maxCandidates);
      await hydrateExactJiraIfNeeded(knowledgeService, {
        productId,
        detected,
      });
      let response = await searchLocal(knowledgeService, {
        productId,
        detected,
        limit: searchLimit,
      });
      if (
        response.items?.length === 0
        && detected.kind === "testrail-case-id"
        && typeof sourceConnectionService?.hydrateTestRailCase === "function"
      ) {
        await sourceConnectionService.hydrateTestRailCase({
          productId,
          caseId: detected.lookupValue,
        });
        response = await searchLocal(knowledgeService, {
          productId,
          detected,
          limit: searchLimit,
        });
      }
      if (
        response.items?.length === 0
        && detected.kind === "reportportal-identity"
        && typeof sourceConnectionService?.hydrateReportPortalTestHistory === "function"
      ) {
        await sourceConnectionService.hydrateReportPortalTestHistory({
          productId,
          identity: detected.lookupValue,
        });
        response = await searchLocal(knowledgeService, {
          productId,
          detected,
          limit: searchLimit,
        });
      }
      if (
        response.items?.length === 0
        && detected.kind === "text"
        && detected.lookupValue.length >= 3
        && typeof sourceConnectionService?.hydrateConfluenceContext === "function"
      ) {
        await sourceConnectionService.hydrateConfluenceContext({
          productId,
          query: detected.lookupValue,
        });
        response = await searchLocal(knowledgeService, {
          productId,
          detected,
          limit: searchLimit,
        });
      }
      const candidates = (response.items ?? [])
        .map((entity) => candidateFromEntity(entity, detected))
        .filter(Boolean)
        .sort(compareCandidates)
        .slice(0, searchLimit);
      const exactCandidates = candidates.filter((candidate) =>
        candidate.match === "exact-id" || candidate.match === "exact-title"
      );
      const selected = detected.kind === "reportportal-identity" && exactCandidates.length > 0
        ? exactCandidates[0]
        : exactCandidates.length === 1
        ? exactCandidates[0]
        : candidates.length === 1 ? candidates[0] : null;

      return {
        productId,
        query: query.trim(),
        detected,
        status: selected
          ? "resolved"
          : candidates.length > 0 ? "ambiguous" : "not-found",
        selected,
        candidates,
      };
    },
  };
}

function searchLocal(knowledgeService, { productId, detected, limit }) {
  if (
    detected.kind === "reportportal-identity"
    && typeof knowledgeService.searchReportPortalExecutions === "function"
  ) {
    return knowledgeService.searchReportPortalExecutions({
      productId,
      identity: detected.lookupValue,
      limit,
      offset: 0,
    });
  }
  return knowledgeService.search({
    productId,
    ...(detected.source ? { source: detected.source } : {}),
    query: detected.lookupValue,
    limit,
    offset: 0,
  });
}

export function detectArtifactQuery(value) {
  const query = typeof value === "string" ? value.trim() : "";
  if (JIRA_KEY_PATTERN.test(query)) {
    return {
      kind: "jira-key",
      source: "jira",
      lookupValue: query.toUpperCase(),
      exact: true,
    };
  }
  const testRailMatch = query.match(TESTRAIL_CASE_PATTERN);
  if (testRailMatch && BigInt(testRailMatch[1]) > 0n) {
    return {
      kind: "testrail-case-id",
      source: "testrail",
      lookupValue: BigInt(testRailMatch[1]).toString(),
      exact: true,
    };
  }
  const reportPortalMatch = query.match(REPORTPORTAL_PREFIX_PATTERN);
  if (reportPortalMatch?.[1]?.trim()) {
    return {
      kind: "reportportal-identity",
      source: "reportportal",
      lookupValue: reportPortalMatch[1].trim(),
      exact: true,
    };
  }
  return {
    kind: "text",
    source: null,
    lookupValue: query,
    exact: false,
  };
}

async function hydrateExactJiraIfNeeded(knowledgeService, { productId, detected }) {
  if (
    detected.kind !== "jira-key"
    || typeof knowledgeService.getStoryTestContext !== "function"
  ) {
    return;
  }
  await knowledgeService.getStoryTestContext({
    productId,
    source: "jira",
    storyId: detected.lookupValue,
  });
}

function candidateFromEntity(entity, detected) {
  if (!entity || typeof entity.id !== "string" || typeof entity.title !== "string") {
    return null;
  }
  const provenance = Array.isArray(entity.provenance)
    ? entity.provenance
    : entity.provenance && typeof entity.provenance === "object"
      ? [entity.provenance]
      : [];
  const preferred = provenance.find((item) => item?.source === detected.source)
    ?? provenance[0];
  const source = normalizeSource(preferred?.source, entity);
  if (!source) return null;
  const externalId = String(preferred?.sourceId ?? externalIdFromCanonical(entity.id));
  const artifactType = normalizeArtifactType(entity.type, source);
  const lookup = detected.lookupValue.toLowerCase();
  const exactId = externalId.toLowerCase() === lookup
    || entity.id.toLowerCase() === lookup
    || (
      source === "reportportal"
      && entity.matchedIdentity?.trim().toLowerCase() === lookup
    )
    || (
      source === "testrail"
      && /^\d+$/.test(externalId)
      && BigInt(externalId).toString() === lookup
    );
  const exactTitle = entity.title.trim().toLowerCase() === lookup;
  const match = exactId ? "exact-id" : exactTitle ? "exact-title" : "partial-title";

  return {
    ref: {
      source,
      type: artifactType,
      externalId,
    },
    canonicalId: entity.id,
    title: entity.title,
    match,
    confidence: match === "exact-id" ? 1 : match === "exact-title" ? 0.95 : 0.7,
    ...(typeof entity.matchedIdentity === "string"
      ? { matchedIdentity: entity.matchedIdentity }
      : {}),
    observedAt: typeof preferred?.observedAt === "string" ? preferred.observedAt : null,
    sourceUrl: typeof preferred?.sourceUrl === "string" ? preferred.sourceUrl : null,
  };
}

function normalizeSource(value, entity) {
  if (typeof value === "string" && Object.hasOwn(SOURCE_TYPES, value)) return value;
  const prefix = String(entity?.id ?? "").split(":")[1];
  return Object.hasOwn(SOURCE_TYPES, prefix) ? prefix : null;
}

function normalizeArtifactType(type, source) {
  if (type === "manual-test") return "test-case";
  if (type === "story") return "requirement";
  if (type === "test") return "automated-test";
  if (type === "test-execution") return "execution";
  if (SOURCE_TYPES[source]?.has(type)) {
    return type;
  }
  return {
    jira: "requirement",
    testrail: "test-case",
    github: "automated-test",
    reportportal: "execution",
    confluence: "document",
  }[source];
}

function externalIdFromCanonical(id) {
  const segments = id.split(":");
  return segments.at(-1) ?? id;
}

function compareCandidates(left, right) {
  return right.confidence - left.confidence
    || String(right.observedAt ?? "").localeCompare(String(left.observedAt ?? ""))
    || left.title.localeCompare(right.title)
    || left.canonicalId.localeCompare(right.canonicalId);
}
