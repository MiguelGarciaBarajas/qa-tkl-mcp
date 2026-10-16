import { TklApplicationService } from "@tkl/core";
import { InMemoryKnowledgeStore, SqliteKnowledgeStore } from "@tkl/knowledge-store";
import { JiraNormalizer } from "@tkl/normalizer-jira";
import { GitHubNormalizer } from "@tkl/normalizer-github";
import { TestRailNormalizer } from "@tkl/normalizer-testrail";
import { ConfluenceNormalizer } from "@tkl/normalizer-confluence";
import { ReportPortalNormalizer } from "@tkl/normalizer-reportportal";
import { CoverageAnalyzer } from "@tkl/analyzer-coverage";
import { ConflictAnalyzer } from "@tkl/analyzer-conflicts";
import { ApiError } from "./errors.js";
import { QaBrainNormalizer } from "./qa-brain-knowledge.js";

const AUXILIARY_EVIDENCE_TYPES = new Set([
  "jira.comment",
]);
const INDEXED_REPOSITORY_EVIDENCE_TYPES = new Set([
  "github.changed_file",
]);
const MAX_RELATED_REQUIREMENTS = 100;
const MAX_INDEXED_REPOSITORY_FILES = 5000;
const MAX_RETURNED_REPOSITORY_FILES = 500;
const MAX_REPOSITORY_FILE_CONTENT_LENGTH = 200_000;
const MAX_RELIABILITY_EXECUTIONS = 5000;
const MAX_CURATION_CANDIDATE_ENTITIES = 2000;
const MAX_CURATION_CANDIDATE_CLAIMS = 5000;
const MAX_CURATION_TRACE_LINKS = 5000;
/**
 * After ingestion, advance only a tiny, bounded slice of the serving (Gold)
 * projection outbox before returning. Any remaining durable backlog is left for
 * explicit drain/rebuild maintenance endpoints or background work, so a single
 * ingest never synchronously projects up to a thousand Gold documents (which
 * previously blocked the event loop and starved concurrent HTTP requests).
 */
const INGESTION_GOLD_DRAIN_LIMIT = 25;

export function createKnowledgeService({
  tenantId = "solera",
  maxPendingTraceLinks = 1000,
  storeFactory = () => new DeferredTraceLinkKnowledgeStore({ maxPendingTraceLinks }),
  createStoreOnRead = false,
  testRailReferenceMapping = {
    jiraReferenceField: "custom_jira_references",
    githubAutomationReferenceField: "custom_github_automation",
  },
  normalizers = [
    new JiraNormalizer(),
    new GitHubNormalizer(),
    new TestRailNormalizer(testRailReferenceMapping),
    new ConfluenceNormalizer(),
    new ReportPortalNormalizer(),
    new QaBrainNormalizer(),
  ],
  coverageAnalyzer = new CoverageAnalyzer(),
  conflictAnalyzer = new ConflictAnalyzer(),
} = {}) {
  const productContexts = new Map();

  function getProductContext(
    productId,
    create = createStoreOnRead
  ) {
    let context = productContexts.get(productId);
    if (!context && create) {
      const store = storeFactory({ tenantId, productId });
      try {
        // Store creation must stay cheap: it never drains serving (Gold)
        // projections. Reads rely on the canonical fallback in
        // SqliteKnowledgeStore.searchEntities while a backlog exists, and Gold
        // is advanced only by bounded post-ingestion drains and explicit
        // maintenance endpoints.
        context = {
          store,
          repositoryEvidence: new Map(),
          ingestionService: new TklApplicationService({
            store,
            normalizers,
            unsupportedRecordPolicy: "error",
          }),
        };
      } catch (error) {
        store.close?.();
        throw error;
      }
      productContexts.set(productId, context);
    }

    return context;
  }

  function findEntities({ productId, source, query, limit, offset = 0 }) {
    const store = getProductContext(productId)?.store;
    if (typeof store?.searchEntities === "function") {
      // SqliteKnowledgeStore.searchEntities transparently returns canonical
      // (Silver) results while serving projections are pending, so a read never
      // synchronously projects Gold documents before responding.
      return store.searchEntities({ productId, source, query, limit, offset });
    }
    const normalizedQuery = query.trim().toLowerCase();
    return (store?.listEntities(productId) ?? [])
      .filter((entity) => matchesSource(entity, source))
      .filter((entity) =>
        normalizedQuery.length === 0
        || entity.id.toLowerCase().includes(normalizedQuery)
        || entity.title.toLowerCase().includes(normalizedQuery))
      .slice(offset, offset + limit);
  }

  async function buildCoverageContext({ productId, workItemId }) {
    const store = getProductContext(productId)?.store;
    const canonicalId = normalizeRequirementId(workItemId);
    const story = store
      ? scopedEntity(store, canonicalId, productId, "jira")
      : undefined;
    if (!store || !story || !["requirement", "story"].includes(story.type)) {
      return { trace: undefined, coverageItems: [] };
    }
    const trace = buildTraceabilityItem(store, story, productId);
    const coverageItems = await Promise.all(
      trace.requirements.map(async (requirement) => ({
        requirement,
        finding: await coverageAnalyzer.analyze({
          store: scopedReadStore(store, productId),
          requirementId: requirement.id,
        }),
      })),
    );
    return { trace, coverageItems };
  }

  return {
    tenantId,

    close() {
      for (const context of productContexts.values()) {
        context.store.close?.();
      }
      productContexts.clear();
    },

    getStore(productId) {
      return getProductContext(productId)?.store;
    },

    requirementContextStatus({ productId, workItemId }) {
      const store = getProductContext(productId)?.store;
      const requirement = store
        ? scopedEntity(store, normalizeRequirementId(workItemId), productId, "jira")
        : undefined;
      const observedTimes = provenanceEntries(requirement)
        .filter((entry) => entry.source === "jira")
        .map((entry) => Date.parse(entry.observedAt))
        .filter(Number.isFinite);
      const latestObservedMillis = observedTimes.length > 0
        ? Math.max(...observedTimes)
        : null;
      return {
        exists: Boolean(requirement),
        lastObservedAt: latestObservedMillis === null
          ? null
          : new Date(latestObservedMillis).toISOString()
      };
    },

    async ingest(records) {
      if (!Array.isArray(records)) {
        throw new TypeError("Evidence records must be an array");
      }
      for (const record of records) {
        if (record?.tenantId !== tenantId) {
          throw new TypeError(`Evidence tenant must match configured tenant "${tenantId}"`);
        }
      }

      const recordsByProduct = Map.groupBy(records, (record) => record.productId);
      const ignoredRecords = [];
      const indexedRecords = [];
      let ingestedRecords = 0;
      for (const [productId, productRecords] of recordsByProduct) {
        const context = getProductContext(productId, true);
        for (const record of productRecords.filter((item) => item?.source === "github")) {
          indexRepositoryEvidence(context.repositoryEvidence, record);
          if (INDEXED_REPOSITORY_EVIDENCE_TYPES.has(record.contentType)) {
            indexedRecords.push({
              source: record.source,
              sourceId: record.sourceId,
              contentType: record.contentType,
            });
          }
        }
        const normalizableRecords = productRecords.filter((record) => {
          if (INDEXED_REPOSITORY_EVIDENCE_TYPES.has(record.contentType)) return false;
          if (!AUXILIARY_EVIDENCE_TYPES.has(record.contentType)) return true;
          ignoredRecords.push({
            source: record.source,
            sourceId: record.sourceId,
            contentType: record.contentType,
          });
          return false;
        });
        const normalized = await context.ingestionService.ingest(normalizableRecords);
        ingestedRecords += normalizableRecords.length;
        const affectedEntityIds = new Set(normalized.entities.map((entity) => entity.id));
        await Promise.all(
          [...affectedEntityIds].map((entityId) =>
            conflictAnalyzer.analyze({ store: context.store, entityId })),
        );
        drainServingProjectionBatches(context.store, {
          maxBatches: 1,
          limit: INGESTION_GOLD_DRAIN_LIMIT,
        });
      }
      const unresolvedLinks = [...recordsByProduct.keys()].flatMap(
        (productId) => {
          const context = getProductContext(productId);
          return context
              && typeof context.store.listPendingTraceLinks === "function"
              ? context.store.listPendingTraceLinks().map((link) => ({
                  productId,
                  linkId: link.id,
                  fromEntityId: link.fromEntityId,
                  toEntityId: link.toEntityId,
                }))
              : [];
        },
      );
      return { ingestedRecords, indexedRecords, ignoredRecords, unresolvedLinks };
    },

    async search({ productId, source, query, limit, offset = 0 }) {
      const items = findEntities({ productId, source, query, limit, offset });

      return { productId, query, items, limit, offset };
    },

    async searchReportPortalExecutions({ productId, identity, limit, offset = 0 }) {
      const store = getProductContext(productId)?.store;
      if (!store) return { productId, query: identity, items: [], limit, offset };
      const normalizedIdentity = identity.trim().toLowerCase();
      const executionIds = new Set(
        store.listClaims()
          .filter((claim) =>
            ["codeRef", "uniqueId"].includes(claim.attribute)
            && typeof claim.value === "string"
            && claim.value.trim().toLowerCase() === normalizedIdentity)
          .map((claim) => claim.entityId)
      );
      const items = store.listEntities(productId)
        .filter((entity) =>
          entity.type === "test-execution"
          && provenanceEntries(entity).some((item) => item.source === "reportportal")
          && (
            executionIds.has(entity.id)
            || entity.title.trim().toLowerCase() === normalizedIdentity
          ))
        .sort((left, right) =>
          String(provenanceEntries(right)[0]?.observedAt ?? "")
            .localeCompare(String(provenanceEntries(left)[0]?.observedAt ?? ""))
          || right.id.localeCompare(left.id))
        .slice(offset, offset + limit)
        .map((entity) => ({ ...entity, matchedIdentity: identity }));
      return { productId, query: identity, items, limit, offset };
    },

    async getEvidenceGraph({ productId, entityId, maxDepth = 2, maxNodes = 100 }) {
      const store = getProductContext(productId)?.store;
      const anchor = store?.getEntity(entityId);
      if (!store || !anchor || anchor.productId !== productId) {
        return { productId, anchorId: entityId, nodes: [], edges: [], truncated: false };
      }
      const allLinks = store.listTraceLinks().filter((link) => {
        const from = store.getEntity(link.fromEntityId);
        const to = store.getEntity(link.toEntityId);
        return from?.productId === productId && to?.productId === productId;
      });
      const nodeIds = new Set([entityId]);
      let frontier = new Set([entityId]);
      let truncated = false;
      for (let depth = 0; depth < maxDepth && frontier.size > 0; depth += 1) {
        const next = new Set();
        for (const link of allLinks) {
          if (!frontier.has(link.fromEntityId) && !frontier.has(link.toEntityId)) continue;
          for (const candidateId of [link.fromEntityId, link.toEntityId]) {
            if (nodeIds.has(candidateId)) continue;
            if (nodeIds.size >= maxNodes) {
              truncated = true;
              break;
            }
            nodeIds.add(candidateId);
            next.add(candidateId);
          }
        }
        frontier = next;
      }
      const claimsByEntity = Map.groupBy(
        store.listClaims().filter((claim) => nodeIds.has(claim.entityId)),
        (claim) => claim.entityId,
      );
      const nodes = [...nodeIds]
        .map((id) => store.getEntity(id))
        .filter(Boolean)
        .map((entity) => {
          const provenance = provenanceEntries(entity);
          return {
            id: entity.id,
            type: entity.type,
            title: entity.title,
            source: provenance[0]?.source ?? null,
            externalId: provenance[0]?.sourceId ?? null,
            observedAt: provenance[0]?.observedAt ?? null,
            claims: (claimsByEntity.get(entity.id) ?? [])
              .filter((claim) => claim.status !== "rejected")
              .slice(0, 20)
              .map((claim) => ({
                attribute: claim.attribute,
                value: claim.value,
                confidence: claim.confidence,
              })),
          };
        });
      const edges = allLinks
        .filter((link) => nodeIds.has(link.fromEntityId) && nodeIds.has(link.toEntityId))
        .map((link) => ({
          id: link.id,
          type: link.type,
          from: link.fromEntityId,
          to: link.toEntityId,
          confidence: link.confidence ?? null,
        }));
      return { productId, anchorId: entityId, nodes, edges, truncated };
    },

    pendingServingProjectionCount({ productId }) {
      const store = getProductContext(productId, true)?.store;
      return store?.pendingServingProjectionCount?.() ?? 0;
    },

    drainServingProjections({ productId, limit }) {
      const store = getProductContext(productId, true)?.store;
      if (typeof store?.drainServingProjections !== "function") {
        return { attempted: 0, projected: 0, remaining: 0, version: 0 };
      }
      return store.drainServingProjections({ limit });
    },

    rebuildServingProjections({ productId, batchSize, cursor }) {
      const store = getProductContext(productId, true)?.store;
      if (typeof store?.rebuildServingProjections !== "function") {
        return { processed: 0, done: true, remaining: 0, version: 0 };
      }
      return store.rebuildServingProjections({ batchSize, cursor });
    },

    async listStoryTraceability({ productId, source, query, limit, offset = 0 }) {
      const store = getProductContext(productId)?.store;
      if (!store) return { productId, query, items: [], limit, offset };
      const stories = findEntities({ productId, source, query, limit, offset })
        .filter((entity) => entity.type === "requirement" || entity.type === "story");
      const items = stories.map((story) =>
        buildTraceabilityItem(store, story, productId));
      return { productId, query, items, limit, offset };
    },

    async getCoverageContext({ productId, workItemId }) {
      return buildCoverageContext({ productId, workItemId });
    },

    async getRequirementSummaryContext({ productId, workItemId }) {
      const store = getProductContext(productId)?.store;
      const requirementId = normalizeRequirementId(workItemId);
      const requirement = store
        ? scopedEntity(store, requirementId, productId, "jira")
        : undefined;
      if (!store || !requirement) {
        return {
          productId,
          workItemId,
          requirement: null,
          claims: [],
        };
      }
      return {
        productId,
        workItemId,
        requirement,
        claims: store.getClaims(requirementId)
          .filter((claim) => claim.status !== "rejected")
          .filter((claim) => provenanceEntries(claim).some((item) => item.source === "jira"))
          .filter((claim) =>
            ["description", "acceptanceCriteria", "issueType", "status"].includes(claim.attribute)),
      };
    },

    async getTestDesignContext({ productId, workItemId }) {
      const context = await buildCoverageContext({ productId, workItemId });
      const store = getProductContext(productId)?.store;
      if (!store || !context.trace) {
        return {
          ...context,
          rootRequirementId: normalizeRequirementId(workItemId),
          requirementClaims: [],
          existingManualTests: [],
          existingManualTestContexts: [],
          excludedConflictedClaimCount: 0,
          skippedNonTextClaimCount: 0,
        };
      }
      const rootRequirementId = normalizeRequirementId(workItemId);
      const designRequirementIds = collectContainedRequirementIds(
        rootRequirementId,
        context.trace.relationships,
      );
      const designRequirements = context.trace.requirements.filter((requirement) =>
        designRequirementIds.has(requirement.id));
      const conflictedClaimIds = new Set(
        designRequirements.flatMap((requirement) =>
          store.listOpenConflicts(requirement.id).flatMap((conflict) => conflict.claimIds)),
      );
      let excludedConflictedClaimCount = 0;
      let skippedNonTextClaimCount = 0;
      const requirementClaims = designRequirements.flatMap((requirement) =>
        store.getClaims(requirement.id)
          .filter((claim) => claim.status !== "rejected")
          .filter((claim) => provenanceEntries(claim).some((item) => item.source === "jira"))
          .filter((claim) => {
            if (conflictedClaimIds.has(claim.id)) {
              excludedConflictedClaimCount += 1;
              return false;
            }
            if (
              ["acceptanceCriteria", "description"].includes(claim.attribute)
              && (typeof claim.value !== "string" || claim.value.trim().length === 0)
            ) {
              skippedNonTextClaimCount += 1;
              return false;
            }
            return true;
          })
          .map((claim) => ({ requirement, claim })));
      const existingManualTests = store.listEntities(productId)
        .filter((entity) =>
          entity.type === "manual-test"
          && provenanceEntries(entity).some((item) => item.source === "testrail"));
      const existingManualTestContexts = existingManualTests.map((testCase) =>
        buildManualTestContext(store, testCase, productId));
      const qaBrainDocuments = rankQaBrainDocuments({
        store,
        productId,
        requirements: designRequirements,
        requirementClaims,
        limit: 8,
      });
      return {
        ...context,
        rootRequirementId,
        requirementClaims,
        existingManualTests,
        existingManualTestContexts,
        qaBrainDocuments,
        excludedConflictedClaimCount,
        skippedNonTextClaimCount,
      };
    },

    async getTestRailImprovementContext({ productId, workItemId }) {
      const context = await buildCoverageContext({ productId, workItemId });
      const store = getProductContext(productId)?.store;
      const rootRequirementId = normalizeRequirementId(workItemId);
      if (!store || !context.trace) {
        return {
          ...context,
          rootRequirementId,
          scopeRequirementIds: [rootRequirementId],
          caseContexts: [],
          allManualTestContexts: [],
        };
      }

      const scopeRequirementIds = collectContainedRequirementIds(
        rootRequirementId,
        context.trace.relationships,
      );
      const linkedManualTests = context.trace.tests.filter((entity) =>
        entity.type === "manual-test"
        && provenanceEntries(entity).some((item) => item.source === "testrail"));
      const allManualTests = store.listEntities(productId).filter((entity) =>
        entity.type === "manual-test"
        && provenanceEntries(entity).some((item) => item.source === "testrail"));

      return {
        ...context,
        rootRequirementId,
        scopeRequirementIds: [...scopeRequirementIds],
        caseContexts: linkedManualTests.map((testCase) =>
          buildManualTestContext(store, testCase, productId, scopeRequirementIds))
          .filter((caseContext) => caseContext.requirementIds.length > 0),
        allManualTestContexts: allManualTests.map((testCase) =>
          buildManualTestContext(store, testCase, productId)),
      };
    },

    async getTestRailCaseImprovementContext({ productId, caseId }) {
      const store = getProductContext(productId)?.store;
      const normalizedCaseId = normalizePositiveIntegerId(caseId);
      const canonicalId = normalizedCaseId
        ? `manual-test:testrail:${normalizedCaseId}`
        : null;
      const testCase = store && canonicalId
        ? scopedEntity(store, canonicalId, productId, "testrail")
        : undefined;
      const allManualTests = store
        ? store.listEntities(productId).filter((entity) =>
            entity.type === "manual-test"
            && provenanceEntries(entity).some((item) => item.source === "testrail"))
        : [];
      if (!store || !testCase) {
        return {
          rootRequirementId: null,
          scopeRequirementIds: [],
          trace: null,
          caseContexts: [],
          allManualTestContexts: allManualTests.map((item) =>
            buildManualTestContext(store, item, productId)),
        };
      }
      const caseContext = buildManualTestContext(store, testCase, productId);
      const requirements = caseContext.requirementIds
        .map((id) => scopedEntity(store, id, productId, "jira"))
        .filter(Boolean);
      return {
        rootRequirementId: requirements[0]?.id ?? null,
        scopeRequirementIds: requirements.map((item) => item.id),
        trace: {
          story: requirements[0] ?? null,
          requirements,
          tests: [testCase],
          relationships: caseContext.relationships,
          context: {
            relatedRequirementCount: requirements.length,
            returnedRequirementCount: requirements.length,
            truncated: false,
          },
        },
        caseContexts: [caseContext],
        allManualTestContexts: allManualTests.map((item) =>
          buildManualTestContext(store, item, productId)),
      };
    },

    async getAutomationDesignContext({ productId, workItemId }) {
      const context = await buildCoverageContext({ productId, workItemId });
      const productContext = getProductContext(productId);
      const store = productContext?.store;
      const rootRequirementId = normalizeRequirementId(workItemId);
      if (!store || !context.trace) {
        return {
          ...context,
          rootRequirementId,
          scopeRequirementIds: [rootRequirementId],
          requirementClaims: [],
          manualCaseContexts: [],
          githubAutomation: [],
          scopeRepositoryFiles: [],
          repositoryFiles: [],
          repositoryContentCollected: false,
        };
      }

      const scopeRequirementIds = collectContainedRequirementIds(
        rootRequirementId,
        context.trace.relationships,
      );
      const requirementClaims = context.trace.requirements
        .filter((requirement) => scopeRequirementIds.has(requirement.id))
        .flatMap((requirement) => {
          const conflictedClaimIds = new Set(
            store.listOpenConflicts(requirement.id)
              .flatMap((conflict) => conflict.claimIds),
          );
          return store.getClaims(requirement.id)
            .filter((claim) => claim.status !== "rejected")
            .filter((claim) => !conflictedClaimIds.has(claim.id))
            .filter((claim) => provenanceEntries(claim)
              .some((item) => item.source === "jira"))
            .map((claim) => ({ requirement, claim }));
        });
      const manualCaseContexts = context.trace.tests
        .filter((entity) =>
          entity.type === "manual-test"
          && provenanceEntries(entity).some((item) => item.source === "testrail"))
        .map((testCase) =>
          buildManualTestContext(store, testCase, productId, scopeRequirementIds))
        .filter((caseContext) => caseContext.requirementIds.length > 0);
      const githubAutomation = context.trace.tests.filter((entity) =>
        entity.type === "test"
        && provenanceEntries(entity).some((item) => item.source === "github"));
      const linkedVersions = new Set(
        githubAutomation.flatMap((entity) =>
          provenanceEntries(entity)
            .filter((item) => item.source === "github")
            .map((item) => `${item.sourceId}@${item.sourceVersion}`)),
      );
      const linkedRepositories = new Set(
        githubAutomation.flatMap((entity) =>
          provenanceEntries(entity)
            .filter((item) => item.source === "github")
            .map((item) => repositoryFromGitHubSourceId(item.sourceId))
            .filter(Boolean)),
      );
      const allRepositoryFiles = [...(productContext.repositoryEvidence?.values() ?? [])];
      const allScopeRepositoryFiles = allRepositoryFiles.filter((file) =>
        linkedVersions.has(`${file.pullRequestSourceId}@${file.provenance.sourceVersion}`));
      const allMatchingRepositoryFiles = (linkedRepositories.size > 0
        ? allRepositoryFiles.filter((file) => linkedRepositories.has(file.repository))
        : allScopeRepositoryFiles)
        .sort((left, right) => left.path.localeCompare(right.path));
      const scopeRepositoryFiles = allScopeRepositoryFiles
        .slice(0, MAX_RETURNED_REPOSITORY_FILES);
      const repositoryFiles = allMatchingRepositoryFiles
        .slice(0, MAX_RETURNED_REPOSITORY_FILES);

      return {
        ...context,
        rootRequirementId,
        scopeRequirementIds: [...scopeRequirementIds],
        requirementClaims,
        manualCaseContexts,
        githubAutomation,
        scopeRepositoryFiles,
        repositoryFiles,
        repositoryEvidenceTruncated:
          allMatchingRepositoryFiles.length > repositoryFiles.length
          || allScopeRepositoryFiles.length > scopeRepositoryFiles.length,
        repositoryContentCollected:
          repositoryFiles.length > 0 && repositoryFiles.every((file) => file.contentAvailable),
      };
    },

    async getReliabilityIntelligenceContext({ productId, workItemId }) {
      const context = await buildCoverageContext({ productId, workItemId });
      const productContext = getProductContext(productId);
      const store = productContext?.store;
      const rootRequirementId = normalizeRequirementId(workItemId);
      if (!store || !context.trace) {
        return {
          ...context,
          rootRequirementId,
          scopeRequirementIds: [rootRequirementId],
          executionContexts: [],
          jiraDefects: [],
          matchedIdentityCount: 0,
          executionEvidenceTruncated: false,
        };
      }

      const scopeRequirementIds = collectContainedRequirementIds(
        rootRequirementId,
        context.trace.relationships,
      );
      const scopeJiraKeys = new Set(
        [...scopeRequirementIds].map((id) =>
          id.replace(/^(requirement|story):/, "").trim().toUpperCase()),
      );
      const linkedGitHubVersions = new Set(
        context.trace.tests
          .filter((entity) =>
            entity.type === "test"
            && provenanceEntries(entity).some((item) => item.source === "github"))
          .flatMap((entity) =>
            provenanceEntries(entity)
              .filter((item) => item.source === "github")
              .map((item) => `${item.sourceId}@${item.sourceVersion}`)),
      );
      const scopedRepositoryPaths = new Set(
        [...(productContext.repositoryEvidence?.values() ?? [])]
          .filter((file) =>
            linkedGitHubVersions.has(
              `${file.pullRequestSourceId}@${file.provenance.sourceVersion}`,
            ))
          .map((file) => normalizeRepositoryPath(file.path)),
      );
      const claimsByEntityId = Map.groupBy(store.listClaims(), (claim) => claim.entityId);
      const linksByEntityId = new Map();
      for (const link of store.listTraceLinks()) {
        for (const entityId of [link.fromEntityId, link.toEntityId]) {
          const links = linksByEntityId.get(entityId) ?? [];
          links.push(link);
          linksByEntityId.set(entityId, links);
        }
      }
      const conflictedClaimIdsByEntityId = new Map();
      for (const conflict of store.listOpenConflicts()) {
        const claimIds = conflictedClaimIdsByEntityId.get(conflict.entityId) ?? new Set();
        conflict.claimIds.forEach((claimId) => claimIds.add(claimId));
        conflictedClaimIdsByEntityId.set(conflict.entityId, claimIds);
      }
      const allExecutionContexts = store.listEntities(productId)
        .filter((entity) =>
          entity.type === "test-execution"
          && entity.id.startsWith("test-execution:reportportal:item:")
          && provenanceEntries(entity).some((item) => item.source === "reportportal"))
        .map((execution) => buildReportPortalExecutionContext(
          store,
          execution,
          productId,
          claimsByEntityId,
          linksByEntityId,
          conflictedClaimIdsByEntityId,
        ))
        .sort(compareExecutionContexts);
      const seedIdentities = new Set(
        allExecutionContexts
          .filter((executionContext) =>
            executionContext.externalIssueKeys.some((key) => scopeJiraKeys.has(key))
            || (
              executionContext.codeRef
              && scopedRepositoryPaths.has(codeRefPath(executionContext.codeRef))
            ))
          .map((executionContext) => executionContext.stableIdentity.key),
      );
      const matchingExecutions = allExecutionContexts.filter((executionContext) =>
        seedIdentities.has(executionContext.stableIdentity.key));
      const boundedExecutions = matchingExecutions.slice(-MAX_RELIABILITY_EXECUTIONS);
      const relatedJiraKeys = new Set(
        boundedExecutions.flatMap((executionContext) =>
          executionContext.externalIssueKeys),
      );
      const jiraDefects = store.listEntities(productId)
        .filter((entity) =>
          (entity.type === "requirement" || entity.type === "story")
          && isJiraDefect(entity)
          && (
            scopeRequirementIds.has(entity.id)
            || relatedJiraKeys.has(
              entity.id.replace(/^(requirement|story):/, "").trim().toUpperCase(),
            )
          ))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((entity) => ({
          entity,
          claims: currentSourceClaims(store, entity, "jira"),
        }));

      return {
        ...context,
        rootRequirementId,
        scopeRequirementIds: [...scopeRequirementIds],
        executionContexts: boundedExecutions,
        jiraDefects,
        matchedIdentityCount: seedIdentities.size,
        executionEvidenceTruncated: matchingExecutions.length > boundedExecutions.length,
      };
    },

    async getReportPortalReliabilityContext({ productId, identity }) {
      const store = getProductContext(productId)?.store;
      if (!store) {
        return {
          trace: undefined,
          executionContexts: [],
          jiraDefects: [],
          matchedIdentityCount: 0,
          executionEvidenceTruncated: false,
        };
      }
      const normalizedIdentity = identity.trim().toLowerCase();
      const claimsByEntityId = Map.groupBy(store.listClaims(), (claim) => claim.entityId);
      const linksByEntityId = new Map();
      for (const link of store.listTraceLinks()) {
        for (const entityId of [link.fromEntityId, link.toEntityId]) {
          const links = linksByEntityId.get(entityId) ?? [];
          links.push(link);
          linksByEntityId.set(entityId, links);
        }
      }
      const conflictedClaimIdsByEntityId = new Map();
      for (const conflict of store.listOpenConflicts()) {
        const claimIds = conflictedClaimIdsByEntityId.get(conflict.entityId) ?? new Set();
        conflict.claimIds.forEach((claimId) => claimIds.add(claimId));
        conflictedClaimIdsByEntityId.set(conflict.entityId, claimIds);
      }
      const allExecutions = store.listEntities(productId)
        .filter((entity) =>
          entity.type === "test-execution"
          && entity.id.startsWith("test-execution:reportportal:item:"))
        .map((execution) => buildReportPortalExecutionContext(
          store,
          execution,
          productId,
          claimsByEntityId,
          linksByEntityId,
          conflictedClaimIdsByEntityId,
        ))
        .filter((execution) => {
          const uniqueId = execution.claims.findLast(
            (claim) => claim.attribute === "uniqueId",
          )?.value;
          return execution.stableIdentity.value.toLowerCase() === normalizedIdentity
            || (
              typeof uniqueId === "string"
              && uniqueId.trim().toLowerCase() === normalizedIdentity
            );
        })
        .sort(compareExecutionContexts);
      const executionContexts = allExecutions.slice(-MAX_RELIABILITY_EXECUTIONS);
      const relatedJiraKeys = new Set(
        executionContexts.flatMap((execution) => execution.externalIssueKeys),
      );
      const jiraDefects = store.listEntities(productId)
        .filter((entity) =>
          (entity.type === "requirement" || entity.type === "story")
          && isJiraDefect(entity)
          && relatedJiraKeys.has(
            entity.id.replace(/^(requirement|story):/, "").trim().toUpperCase(),
          ))
        .map((entity) => ({
          entity,
          claims: currentSourceClaims(store, entity, "jira"),
        }));
      return {
        trace: { requirements: [], relationships: [], tests: [] },
        executionContexts,
        jiraDefects,
        matchedIdentityCount: executionContexts.length > 0 ? 1 : 0,
        executionEvidenceTruncated: allExecutions.length > executionContexts.length,
      };
    },

    async getKnowledgeCurationContext({ productId, workItemId }) {
      const context = await buildCoverageContext({ productId, workItemId });
      const productContext = getProductContext(productId);
      const store = productContext?.store;
      const rootRequirementId = normalizeRequirementId(workItemId);
      if (!store || !context.trace) {
        return {
          ...context,
          rootRequirementId,
          scopeRequirementIds: [rootRequirementId],
          scopedEntities: [],
          scopedClaims: [],
          currentScopedClaims: [],
          scopedTraceLinks: [],
          productTraceLinks: [],
          candidateEntities: [],
          candidateClaims: [],
          currentCandidateClaims: [],
          openConflicts: [],
          conflictedClaimIds: [],
          unresolvedTraceLinks: [],
        };
      }

      const allProductEntities = store.listEntities(productId)
        .sort((left, right) => left.id.localeCompare(right.id));
      const productEntityIds = new Set(allProductEntities.map((entity) => entity.id));
      const allProductTraceLinks = store.listTraceLinks()
        .filter((link) =>
          productEntityIds.has(link.fromEntityId) && productEntityIds.has(link.toEntityId))
        .sort((left, right) => left.id.localeCompare(right.id));
      const allHierarchyRequirementIds = [...collectContainedRequirementIds(
        rootRequirementId,
        allProductTraceLinks,
      )].filter((entityId) => {
        const entity = store.getEntity(entityId);
        return entity?.productId === productId
          && ["requirement", "story"].includes(entity.type)
          && provenanceEntries(entity).some((item) => item.source === "jira");
      });
      const boundedHierarchyRequirementIds = allHierarchyRequirementIds
        .slice(0, MAX_RELATED_REQUIREMENTS + 1);
      const scopeRequirementIds = new Set(boundedHierarchyRequirementIds);
      const scopeEntityIds = new Set(scopeRequirementIds);
      for (const link of allProductTraceLinks) {
        if (
          scopeRequirementIds.has(link.fromEntityId)
          || scopeRequirementIds.has(link.toEntityId)
        ) {
          scopeEntityIds.add(link.fromEntityId);
          scopeEntityIds.add(link.toEntityId);
        }
      }
      const scopedEntities = allProductEntities.filter((entity) =>
        scopeEntityIds.has(entity.id));
      const scopedHierarchyLinks = allProductTraceLinks.filter((link) =>
        scopeRequirementIds.has(link.fromEntityId)
        || scopeRequirementIds.has(link.toEntityId));
      const allProductClaims = store.listClaims()
        .filter((claim) => productEntityIds.has(claim.entityId))
        .sort((left, right) => left.id.localeCompare(right.id));
      const scopedClaims = allProductClaims.filter((claim) =>
        scopeEntityIds.has(claim.entityId));
      const isCurrentClaim = (claim) => {
        if (claim.status === "rejected") return false;
        const entity = store.getEntity(claim.entityId);
        const currentVersions = new Set(provenanceEntries(entity).map((item) =>
          `${item.source}|${item.sourceId}|${item.sourceVersion}`));
        return provenanceEntries(claim).some((item) =>
          currentVersions.has(`${item.source}|${item.sourceId}|${item.sourceVersion}`));
      };
      const currentScopedClaims = scopedClaims.filter(isCurrentClaim);
      const candidateEntities = allProductEntities
        .filter((entity) =>
          ["requirement", "story", "manual-test", "test"].includes(entity.type))
        .slice(0, MAX_CURATION_CANDIDATE_ENTITIES);
      const candidateEntityIds = new Set(candidateEntities.map((entity) => entity.id));
      const candidateClaims = allProductClaims
        .filter((claim) => candidateEntityIds.has(claim.entityId))
        .slice(0, MAX_CURATION_CANDIDATE_CLAIMS);
      const currentCandidateClaims = candidateClaims.filter(isCurrentClaim);
      const openConflicts = store.listOpenConflicts()
        .filter((conflict) => scopeEntityIds.has(conflict.entityId))
        .sort((left, right) => left.id.localeCompare(right.id));
      const conflictedClaimIds = [...new Set(
        store.listOpenConflicts()
          .filter((conflict) => candidateEntityIds.has(conflict.entityId))
          .flatMap((conflict) => conflict.claimIds),
      )].sort();
      const unresolvedTraceLinks = (
        typeof store.listPendingTraceLinks === "function"
          ? store.listPendingTraceLinks()
          : []
      )
        .filter((link) =>
          scopeRequirementIds.has(link.fromEntityId)
          || scopeRequirementIds.has(link.toEntityId))
        .sort((left, right) => left.id.localeCompare(right.id));

      return {
        ...context,
        trace: {
          ...context.trace,
          requirements: scopedEntities.filter((entity) =>
            ["requirement", "story"].includes(entity.type)
            && provenanceEntries(entity).some((item) => item.source === "jira")),
          tests: scopedEntities.filter((entity) =>
            ["test", "manual-test", "test-suite", "test-execution"].includes(entity.type)),
          relationships: scopedHierarchyLinks,
          context: {
            ...context.trace.context,
            relatedRequirementCount: Math.max(allHierarchyRequirementIds.length - 1, 0),
            returnedRequirementCount: Math.max(scopeRequirementIds.size - 1, 0),
            truncated: allHierarchyRequirementIds.length > scopeRequirementIds.size,
          },
        },
        rootRequirementId,
        scopeRequirementIds: [...scopeRequirementIds].sort(),
        scopedEntities,
        scopedClaims,
        currentScopedClaims,
        scopedTraceLinks: scopedHierarchyLinks,
        productTraceLinks: allProductTraceLinks.slice(0, MAX_CURATION_TRACE_LINKS),
        candidateEntities,
        candidateClaims,
        currentCandidateClaims,
        openConflicts,
        conflictedClaimIds,
        unresolvedTraceLinks,
        candidateEntitiesTruncated:
          allProductEntities.filter((entity) =>
            ["requirement", "story", "manual-test", "test"].includes(entity.type)).length
          > candidateEntities.length,
        candidateClaimsTruncated:
          allProductClaims.filter((claim) => candidateEntityIds.has(claim.entityId)).length
          > candidateClaims.length,
        productTraceLinksTruncated:
          allProductTraceLinks.length > MAX_CURATION_TRACE_LINKS,
        hierarchyTruncated: allHierarchyRequirementIds.length > scopeRequirementIds.size,
      };
    },

    async listCoverageGaps({ productId, source, query, limit, offset = 0 }) {
      const store = getProductContext(productId)?.store;
      if (!store) return { productId, query, items: [], limit, offset };
      const requirements = findEntities({ productId, source, query, limit, offset })
        .filter((entity) => entity.type === "requirement" || entity.type === "story");
      const items = await Promise.all(requirements.map(async (requirement) => ({
        requirement,
        finding: await coverageAnalyzer.analyze({
          store: scopedReadStore(store, productId),
          requirementId: requirement.id,
        }),
      })));
      return { productId, query, items, limit, offset };
    },

    async getStoryTestContext({ productId, source, storyId }) {
      const store = getProductContext(productId)?.store;
      if (!store) return emptyStoryContext(productId, storyId);

      const requirementId = normalizeRequirementId(storyId);
      const requirement = scopedEntity(store, requirementId, productId, source);
      const relationships = requirement
        ? scopedLinks(store, requirementId, productId)
        : [];
      const relatedIds = new Set(
        relationships.flatMap((link) => [link.fromEntityId, link.toEntityId]),
      );
      const entities = [...relatedIds]
        .map((entityId) => scopedEntity(store, entityId, productId))
        .filter(Boolean);

      if (requirement && !entities.some((entity) => entity.id === requirement.id)) {
        entities.push(requirement);
      }

      return {
        productId,
        storyId,
        requirements: entities.filter((entity) =>
          entity.type === "requirement" || entity.type === "story"),
        tests: entities.filter((entity) =>
          ["test", "manual-test", "test-suite", "test-execution"].includes(entity.type)),
        defects: entities.filter((entity) => entity.type === "defect"),
        provenance: collectProvenance([...entities, ...relationships]),
      };
    },

    async analyzeRequirementCoverage({ productId, source, requirementId }) {
      const store = getProductContext(productId)?.store;
      const canonicalRequirementId = normalizeRequirementId(requirementId);
      const requirement = store
        ? scopedEntity(store, canonicalRequirementId, productId, source)
        : undefined;
      const relationships = store
        && requirement
        ? scopedLinks(store, canonicalRequirementId, productId)
        : [];
      const findings = requirement
        ? [await coverageAnalyzer.analyze({
            store: scopedReadStore(store, productId),
            requirementId: canonicalRequirementId,
          })]
        : [];

      return {
        productId,
        requirementId,
        findings,
        provenance: requirement
          ? collectProvenance([requirement, ...relationships])
          : [],
      };
    },

    async explainTraceability({ productId, source, requirementId }) {
      const store = getProductContext(productId)?.store;
      const canonicalRequirementId = normalizeRequirementId(requirementId);
      const requirement = store
        ? scopedEntity(store, canonicalRequirementId, productId, source)
        : undefined;
      const relationships = requirement
        ? scopedLinks(store, canonicalRequirementId, productId)
        : [];

      return {
        productId,
        requirementId,
        relationships,
        provenance: collectProvenance([
          ...(requirement ? [requirement] : []),
          ...relationships,
        ]),
      };
    },

    async listKnowledgeConflicts({ productId, source }) {
      const store = getProductContext(productId)?.store;
      const entities = (store?.listEntities(productId) ?? [])
        .filter((entity) => matchesSource(entity, source));
      const entityIds = new Set(entities.map((entity) => entity.id));
      const conflicts = (store?.listOpenConflicts() ?? [])
        .filter((conflict) => entityIds.has(conflict.entityId));

      return {
        productId,
        conflicts,
        provenance: collectProvenance(entities),
      };
    },

    /**
     * Applies a human reviewer's decision to an open conflict: the approved claim IDs are
     * marked "approved" and every other claim in the conflict is marked "rejected"; the
     * conflict itself transitions to "reviewed". `reviewerId`/`reviewedAt` must be supplied
     * by the caller (the API route derives them from the authenticated subject and the
     * server clock, never from client-supplied request fields) so the durable audit trail
     * in `@tkl/knowledge-store` cannot be forged by the request body.
     */
    async reviewConflict({ productId, source, conflictId, approvedClaimIds, reviewerId, reviewedAt, note }) {
      const store = getProductContext(productId)?.store;
      const conflict = store
        ?.listOpenConflicts()
        .find((candidate) =>
          candidate.id === conflictId
          && scopedEntity(store, candidate.entityId, productId, source));

      if (!store || !conflict) {
        throw new ApiError(
          404,
          "conflict_not_found",
          `Open conflict ${conflictId} does not exist for product ${productId}.`,
        );
      }

      let review;
      try {
        review = store.reviewConflict({ conflictId, approvedClaimIds, reviewerId, reviewedAt, note });
      } catch (error) {
        throw translateConflictReviewError(error);
      }

      return {
        productId,
        conflict: { ...conflict, status: "reviewed" },
        review,
      };
    },

    async readResource({ productId, uri }) {
      const store = getProductContext(productId)?.store;
      const resource = parseResourceUri(uri, productId);
      if (!store || !resource) return { productId, uri, contents: [] };

      if (resource.kind === "traceability") {
        const requirementId = normalizeRequirementId(resource.resourceId);
        const requirement = scopedEntity(store, requirementId, productId);
        const relationships = requirement
          ? scopedLinks(store, requirementId, productId)
          : [];
        return {
          productId,
          uri,
          contents: relationships.length > 0
            ? [jsonResourceContent({
                requirementId: resource.resourceId,
                relationships,
                provenance: collectProvenance([requirement, ...relationships]),
              })]
            : [],
        };
      }

      if (resource.kind === "provenance") {
        const entities = store
          .listEntities(productId)
          .filter((entity) => provenanceEntries(entity).some((entry) =>
            entry.source === resource.source && entry.sourceId === resource.resourceId));
        return {
          productId,
          uri,
          contents: entities.length > 0
            ? [jsonResourceContent({
                source: resource.source,
                sourceId: resource.resourceId,
                entities,
                provenance: collectProvenance(entities),
              })]
            : [],
        };
      }

      const candidateIds = resource.kind === "requirement"
        ? [resource.resourceId, normalizeRequirementId(resource.resourceId)]
        : [resource.resourceId, `feature:${resource.resourceId}`];
      const entity = candidateIds
        .map((entityId) => scopedEntity(store, entityId, productId))
        .find(Boolean);

      return {
        productId,
        uri,
        contents: entity
          ? [jsonResourceContent({
              entity,
              claims: store.getClaims(entity.id),
              relationships: scopedLinks(store, entity.id, productId),
            })]
          : [],
      };
    },
  };
}

class DeferredTraceLinkKnowledgeStore extends InMemoryKnowledgeStore {
  pendingTraceLinks = new Map();

  constructor({ maxPendingTraceLinks }) {
    super();
    if (!Number.isSafeInteger(maxPendingTraceLinks) || maxPendingTraceLinks < 1) {
      throw new TypeError("maxPendingTraceLinks must be a positive integer");
    }
    this.maxPendingTraceLinks = maxPendingTraceLinks;
  }

  upsert(result) {
    const incomingEntityIds = new Set(
      (result.entities ?? []).map((entity) => entity.id),
    );
    const endpointExists = (entityId) =>
      incomingEntityIds.has(entityId) || Boolean(this.getEntity(entityId));
    const projectedPending = new Map(this.pendingTraceLinks);

    for (const [linkId, link] of projectedPending) {
      if (endpointExists(link.fromEntityId) && endpointExists(link.toEntityId)) {
        projectedPending.delete(linkId);
      }
    }
    for (const link of result.traceLinks ?? []) {
      if (endpointExists(link.fromEntityId) && endpointExists(link.toEntityId)) {
        projectedPending.delete(link.id);
      } else {
        projectedPending.set(link.id, link);
      }
    }
    if (projectedPending.size > this.maxPendingTraceLinks) {
      throw new Error(`Pending trace link limit of ${this.maxPendingTraceLinks} exceeded`);
    }

    super.upsert(result);
  }

  addEntity(entity) {
    super.addEntity(entity);
    this.flushPendingTraceLinks();
  }

  addTraceLink(link) {
    try {
      super.addTraceLink(link);
      this.pendingTraceLinks.delete(link.id);
    } catch (error) {
      if (!String(error?.message).includes("requires both endpoint entities")) {
        throw error;
      }
      if (!this.pendingTraceLinks.has(link.id)
        && this.pendingTraceLinks.size >= this.maxPendingTraceLinks) {
        throw new Error(`Pending trace link limit of ${this.maxPendingTraceLinks} exceeded`);
      }
      this.pendingTraceLinks.set(link.id, link);
    }
  }

  flushPendingTraceLinks() {
    for (const link of this.pendingTraceLinks.values()) {
      try {
        super.addTraceLink(link);
        this.pendingTraceLinks.delete(link.id);
      } catch (error) {
        if (!String(error?.message).includes("requires both endpoint entities")) {
          throw error;
        }
      }
    }
  }

  listPendingTraceLinks() {
    return [...this.pendingTraceLinks.values()];
  }
}

class SqliteDeferredTraceLinkKnowledgeStore extends SqliteKnowledgeStore {
  batchUpsertInProgress = false;

  constructor({ maxPendingTraceLinks, ...options }) {
    super(options);
    if (!Number.isSafeInteger(maxPendingTraceLinks) || maxPendingTraceLinks < 1) {
      throw new TypeError("maxPendingTraceLinks must be a positive integer");
    }
    this.maxPendingTraceLinks = maxPendingTraceLinks;
  }

  upsert(result) {
    this.batchUpsertInProgress = true;
    try {
      this.upsertWithDeferredTraceLinks(result, this.maxPendingTraceLinks);
    } finally {
      this.batchUpsertInProgress = false;
    }
  }

  addEntity(entity) {
    if (this.batchUpsertInProgress) {
      super.addEntity(entity);
      return;
    }
    this.addEntityWithDeferredTraceLinks(entity);
  }

  addTraceLink(link) {
    if (this.batchUpsertInProgress) {
      super.addTraceLink(link);
      return;
    }
    this.addTraceLinkWithDeferredTraceLinks(link, this.maxPendingTraceLinks);
  }

  flushPendingTraceLinks() {
    this.flushDeferredTraceLinks();
  }

  listPendingTraceLinks() {
    return this.persistedDeferredTraceLinks();
  }
}

export function createPersistentKnowledgeStoreFactory({
  dataDirectory,
  maxPendingTraceLinks = 1000,
  busyTimeoutMs = 5000
}) {
  if (typeof dataDirectory !== "string" || dataDirectory.trim().length === 0) {
    throw new TypeError("A knowledge data directory is required");
  }
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError("busyTimeoutMs must be a non-negative integer");
  }
  return ({ tenantId, productId }) => new SqliteDeferredTraceLinkKnowledgeStore({
    dataDirectory,
    tenantId,
    productId,
    maxPendingTraceLinks,
    busyTimeoutMs
  });
}

function drainServingProjectionBatches(store, { maxBatches = 10, limit = 100 } = {}) {
  if (
    !store
    || typeof store.pendingServingProjectionCount !== "function"
    || typeof store.drainServingProjections !== "function"
  ) {
    return true;
  }
  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (store.pendingServingProjectionCount() === 0) return true;
    const result = store.drainServingProjections({ limit });
    if (result.remaining > 0 && result.attempted === 0) {
      throw new Error("Serving projection drain made no progress");
    }
  }
  return store.pendingServingProjectionCount() === 0;
}

/**
 * Translates `@tkl/knowledge-store`'s plain `Error`/`TypeError` messages from
 * `reviewConflict` into status-coded `ApiError`s. The store's messages are stable
 * substrings (see `packages/knowledge-store/src/store.ts`), not a typed error contract,
 * so matching is intentionally conservative and falls back to a generic 409 for any other
 * store-side rejection rather than a misleading 500.
 */
function translateConflictReviewError(error) {
  const message = String(error?.message ?? "Failed to record the conflict review.");
  if (message.includes("has already been reviewed")) {
    return new ApiError(409, "conflict_already_reviewed", message);
  }
  if (message.includes("does not exist")) {
    return new ApiError(404, "conflict_not_found", message);
  }
  if (
    message.includes("does not belong to conflict")
    || message.includes("must approve at least one claim")
  ) {
    return new ApiError(400, "invalid_request", message, { parameter: "approvedClaimIds" });
  }
  return new ApiError(409, "conflict_review_rejected", message);
}

function emptyStoryContext(productId, storyId) {
  return {
    productId,
    storyId,
    requirements: [],
    tests: [],
    defects: [],
    provenance: [],
  };
}

function normalizeRequirementId(requirementId) {
  return requirementId.startsWith("requirement:")
    ? requirementId
    : `requirement:${requirementId}`;
}

function collectContainedRequirementIds(rootRequirementId, relationships) {
  const collected = new Set([rootRequirementId]);
  let frontier = [rootRequirementId];
  while (frontier.length > 0) {
    const parents = new Set(frontier);
    const children = relationships
      .filter((link) => link.type === "contains" && parents.has(link.fromEntityId))
      .map((link) => link.toEntityId)
      .filter((entityId) => !collected.has(entityId));
    children.forEach((entityId) => collected.add(entityId));
    frontier = children;
  }
  return collected;
}

function rankQaBrainDocuments({
  store,
  productId,
  requirements,
  requirementClaims,
  limit,
}) {
  const queryText = [
    ...requirements.flatMap((requirement) => [requirement.id, requirement.title]),
    ...requirementClaims.flatMap(({ claim }) =>
      typeof claim.value === "string" ? [claim.value] : []),
  ].join(" ");
  const queryTokens = semanticTokens(queryText);
  return store.listEntities(productId)
    .filter((entity) =>
      entity.type === "documentation"
      && provenanceEntries(entity).some((item) => item.source === "qa-brain"))
    .map((document) => {
      const claims = store.getClaims(document.id)
        .filter((claim) => claim.status !== "rejected")
        .filter((claim) =>
          provenanceEntries(claim).some((item) => item.source === "qa-brain"));
      const content = claims.find((claim) => claim.attribute === "content")?.value;
      const searchable = [
        document.title,
        typeof content === "string" ? content : "",
        JSON.stringify(document.metadata ?? {}),
      ].join(" ");
      const documentTokens = semanticTokens(searchable);
      const intersection = [...queryTokens].filter((token) => documentTokens.has(token)).length;
      const exactReferences = claims
        .filter((claim) => claim.attribute === "jiraKeys")
        .flatMap((claim) => Array.isArray(claim.value) ? claim.value : [])
        .filter((key) => queryText.toUpperCase().includes(String(key).toUpperCase()))
        .length;
      const score = exactReferences > 0
        ? 1
        : queryTokens.size === 0 ? 0 : intersection / Math.min(queryTokens.size, 12);
      return { document, claims, score: Number(Math.min(1, score).toFixed(3)) };
    })
    .filter((item) => item.score >= 0.15)
    .sort((left, right) =>
      right.score - left.score || left.document.title.localeCompare(right.document.title))
    .slice(0, limit);
}

function semanticTokens(value) {
  const stopWords = new Set([
    "and", "are", "for", "from", "into", "that", "the", "this", "when", "with",
    "verify", "should", "case", "test", "ticket",
  ]);
  return new Set(
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) => token.replace(/(?:ing|ed|es|s)$/i, ""))
      .filter((token) => token.length >= 3 && !stopWords.has(token)),
  );
}

function indexRepositoryEvidence(index, record) {
  if (INDEXED_REPOSITORY_EVIDENCE_TYPES.has(record.contentType)) {
    const file = repositoryFileFromRecord(record);
    if (file) {
      const key = repositoryEvidenceKey(file);
      index.delete(key);
      index.set(key, file);
      trimRepositoryEvidenceIndex(index);
    }
    return;
  }
  if (
    ["github.pull_request", "github.pull-request"].includes(record.contentType)
    && Array.isArray(record.payload?.changedFiles)
  ) {
    for (const [id, existing] of index) {
      if (existing.pullRequestSourceId === record.sourceId) index.delete(id);
    }
  }
  if (Array.isArray(record.payload?.changedFiles)) {
    for (const path of record.payload.changedFiles) {
      if (typeof path !== "string" || path.trim().length === 0) continue;
      const file = repositoryFileFromRecord({
        ...record,
        sourceId: `${record.sourceId}:${path}`,
        contentType: "github.changed_file",
        payload: { filename: path },
      });
      if (file) {
        index.set(repositoryEvidenceKey(file), file);
        trimRepositoryEvidenceIndex(index);
      }
    }
  }
}

function repositoryFileFromRecord(record) {
  const path = typeof record.payload?.filename === "string"
    ? record.payload.filename.trim().replaceAll("\\", "/")
    : "";
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return undefined;
  const pullRequestSourceId = changedFilePullRequestSourceId(record.sourceId, path);
  const rawContent = repositoryFileContent(record.payload);
  const content = rawContent?.length <= MAX_REPOSITORY_FILE_CONTENT_LENGTH
    ? rawContent
    : undefined;
  return {
    id: `repository-file:${record.sourceId}`,
    repository: repositoryFromGitHubSourceId(record.sourceId),
    pullRequestSourceId,
    path,
    status: typeof record.payload?.status === "string" ? record.payload.status : undefined,
    additions: safeNonNegativeInteger(record.payload?.additions),
    deletions: safeNonNegativeInteger(record.payload?.deletions),
    changes: safeNonNegativeInteger(record.payload?.changes),
    contentAvailable: content !== undefined,
    contentTruncated: rawContent !== undefined && content === undefined,
    ...(content !== undefined ? { content } : {}),
    provenance: {
      source: "github",
      sourceId: record.sourceId,
      sourceVersion: record.sourceVersion,
      contentHash: record.contentHash,
      observedAt: record.observedAt,
      normalizerId: "github-repository-evidence-index",
      normalizerVersion: "0.1.0",
    },
  };
}

function repositoryEvidenceKey(file) {
  return `${file.pullRequestSourceId}\u0000${file.provenance.sourceVersion}\u0000${file.path}`;
}

function trimRepositoryEvidenceIndex(index) {
  while (index.size > MAX_INDEXED_REPOSITORY_FILES) {
    const oldestKey = index.keys().next().value;
    if (oldestKey === undefined) break;
    index.delete(oldestKey);
  }
}

function changedFilePullRequestSourceId(sourceId, path) {
  const suffix = `:${path}`;
  return sourceId.endsWith(suffix)
    ? sourceId.slice(0, -suffix.length)
    : sourceId.split(":")[0];
}

function repositoryFromGitHubSourceId(sourceId) {
  const hashIndex = sourceId.indexOf("#");
  return hashIndex > 0 ? sourceId.slice(0, hashIndex) : undefined;
}

function repositoryFileContent(payload) {
  for (const candidate of [payload?.content, payload?.fileContent, payload?.text]) {
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function buildReportPortalExecutionContext(
  store,
  execution,
  productId,
  claimsByEntityId,
  linksByEntityId,
  conflictedClaimIdsByEntityId,
) {
  const claims = currentSourceClaims(
    store,
    execution,
    "reportportal",
    claimsByEntityId?.get(execution.id),
    conflictedClaimIdsByEntityId?.get(execution.id),
  );
  const value = (attribute) =>
    claims.findLast((claim) => claim.attribute === attribute)?.value;
  const codeRef = typeof value("codeRef") === "string"
    ? value("codeRef").trim()
    : undefined;
  const launchId = String(value("launchId") ?? "");
  const externalIssueKeys = Array.isArray(value("externalIssues"))
    ? value("externalIssues")
      .filter((item) => typeof item === "string")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean)
    : [];
  const linkedDefects = (linksByEntityId?.get(execution.id) ?? scopedLinks(store, execution.id, productId))
    .filter((link) => link.fromEntityId === execution.id && link.type === "relates_to")
    .map((link) => scopedEntity(store, link.toEntityId, productId))
    .filter(Boolean);
  const identityValue = codeRef || normalizeTestName(execution.title);
  return {
    execution,
    claims,
    launchId,
    status: typeof value("status") === "string" ? value("status") : "UNKNOWN",
    startedAt: typeof value("startedAt") === "string" ? value("startedAt") : undefined,
    endedAt: typeof value("endedAt") === "string" ? value("endedAt") : undefined,
    duration: Number.isFinite(value("duration")) ? value("duration") : undefined,
    codeRef,
    retry: value("retry"),
    issueType: typeof value("issueType") === "string" ? value("issueType") : undefined,
    attributes: Array.isArray(value("attributes")) ? value("attributes") : [],
    externalIssueKeys: uniqueStrings(externalIssueKeys),
    linkedDefects,
    stableIdentity: {
      type: codeRef ? "codeRef" : "name",
      value: identityValue,
      key: `${codeRef ? "codeRef" : "name"}:${identityValue}`,
    },
  };
}

function currentSourceClaims(store, entity, source, indexedClaims, conflictedClaimIds = new Set()) {
  const currentVersions = new Set(
    provenanceEntries(entity)
      .filter((item) => item.source === source)
      .map((item) => `${item.sourceId}@${item.sourceVersion}`),
  );
  return (indexedClaims ?? store.getClaims(entity.id))
    .filter((claim) => claim.status !== "rejected")
    .filter((claim) => !conflictedClaimIds.has(claim.id))
    .filter((claim) => provenanceEntries(claim).some((item) =>
      item.source === source
      && currentVersions.has(`${item.sourceId}@${item.sourceVersion}`)));
}

function compareExecutionContexts(left, right) {
  return String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? ""))
    || compareNumericStrings(left.launchId, right.launchId)
    || left.execution.id.localeCompare(right.execution.id);
}

function compareNumericStrings(left, right) {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
    return 0;
  }
  return left.localeCompare(right);
}

function codeRefPath(codeRef) {
  return normalizeRepositoryPath(codeRef.split("#")[0]);
}

function normalizeRepositoryPath(path) {
  return String(path ?? "").trim().replaceAll("\\", "/").replace(/^\.?\//, "").toLowerCase();
}

function normalizeTestName(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isJiraDefect(entity) {
  const issueType = String(entity.metadata?.issueType ?? "").trim().toLowerCase();
  return ["bug", "defect", "incident", "problem"].some((term) => issueType.includes(term));
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function normalizePositiveIntegerId(value) {
  const text = typeof value === "number" || typeof value === "string"
    ? String(value).trim().replace(/^C/i, "")
    : "";
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) return null;
  return BigInt(text).toString();
}

function provenanceEntries(value) {
  if (!value?.provenance) return [];
  return Array.isArray(value.provenance) ? value.provenance : [value.provenance];
}

function matchesSource(value, source) {
  return !source || provenanceEntries(value).some((entry) => entry.source === source);
}

function scopedEntity(store, entityId, productId, source) {
  const entity = store.getEntity(entityId);
  return entity?.productId === productId && matchesSource(entity, source)
    ? entity
    : undefined;
}

function scopedLinks(store, entityId, productId, source) {
  return store.getTraceLinks(entityId).filter((link) => {
    const fromEntity = store.getEntity(link.fromEntityId);
    const toEntity = store.getEntity(link.toEntityId);
    return fromEntity?.productId === productId
      && toEntity?.productId === productId
      && matchesSource(link, source);
  });
}

function collectProvenance(values) {
  const entries = values.filter(Boolean).flatMap(provenanceEntries);
  return entries.filter((entry, index) =>
    entries.findIndex((candidate) =>
      candidate.source === entry.source
      && candidate.sourceId === entry.sourceId
      && candidate.sourceVersion === entry.sourceVersion
      && candidate.contentHash === entry.contentHash
      && candidate.normalizerId === entry.normalizerId
      && candidate.normalizerVersion === entry.normalizerVersion) === index);
}

function buildManualTestContext(store, testCase, productId, scopeRequirementIds) {
  const inspectedAttributes = new Set([
    "custom_preconds",
    "custom_steps",
    "custom_steps_separated",
    "custom_expected",
    "custom_jira_references",
  ]);
  const claims = store.getClaims(testCase.id)
    .filter((claim) => claim.status !== "rejected")
    .filter((claim) => provenanceEntries(claim).some((item) => item.source === "testrail"));
  const conflictedClaimIds = new Set(
    store.listOpenConflicts(testCase.id)
      .flatMap((conflict) => conflict.claimIds)
      .filter((claimId) => claims.some((claim) =>
        claim.id === claimId && inspectedAttributes.has(claim.attribute))),
  );
  const currentTestRailVersions = provenanceEntries(testCase)
    .filter((item) => item.source === "testrail")
    .map((item) => `${item.sourceId}:${item.sourceVersion}`);
  const relationships = scopedLinks(store, testCase.id, productId)
    .filter((link) => link.fromEntityId === testCase.id && link.type === "verifies")
    .filter((link) => !scopeRequirementIds || scopeRequirementIds.has(link.toEntityId));
  return {
    testCase,
    claims: claims
      .filter((claim) => provenanceEntries(claim).some((item) =>
        currentTestRailVersions.includes(`${item.sourceId}:${item.sourceVersion}`)))
      .filter((claim) => !conflictedClaimIds.has(claim.id)),
    relationships,
    requirementIds: uniqueById(
      relationships.map((link) => ({ id: link.toEntityId })),
    ).map(({ id }) => id),
    conflictedClaimCount: conflictedClaimIds.size,
  };
}

function uniqueById(values) {
  return values.filter((value, index) =>
    values.findIndex((candidate) => candidate.id === value.id) === index);
}

function buildTraceabilityItem(store, story, productId) {
  const directRelationships = scopedLinks(store, story.id, productId);
  const childRequirementIds = directRelationships
    .filter((link) => link.type === "contains" && link.fromEntityId === story.id)
    .map((link) => link.toEntityId)
    .filter((entityId) => {
      const entity = scopedEntity(store, entityId, productId);
      return entity?.type === "requirement" || entity?.type === "story";
    });
  const selectedChildIds = childRequirementIds.slice(0, MAX_RELATED_REQUIREMENTS);
  const relationships = uniqueById([
    ...directRelationships,
    ...selectedChildIds.flatMap((entityId) =>
      scopedLinks(store, entityId, productId)),
  ]);
  const relatedIds = new Set(
    relationships.flatMap((link) => [link.fromEntityId, link.toEntityId]),
  );
  const entities = [...relatedIds]
    .map((entityId) => scopedEntity(store, entityId, productId))
    .filter(Boolean);
  if (!entities.some((entity) => entity.id === story.id)) entities.push(story);
  return {
    story,
    requirements: entities.filter((entity) =>
      entity.type === "requirement" || entity.type === "story"),
    tests: entities.filter((entity) =>
      ["test", "manual-test", "test-suite", "test-execution"].includes(entity.type)),
    relationships,
    context: {
      issueType: story.metadata?.issueType,
      status: story.metadata?.status,
      relatedRequirementCount: childRequirementIds.length,
      returnedRequirementCount: selectedChildIds.length,
      truncated: childRequirementIds.length > selectedChildIds.length,
    },
  };
}

function scopedReadStore(store, productId, source) {
  const entityInScope = (entityId) => scopedEntity(store, entityId, productId, source);
  const rejectWrite = () => {
    throw new TypeError("Analyzers cannot mutate the scoped read store");
  };

  return {
    upsert: rejectWrite,
    addEntity: rejectWrite,
    getEntity(entityId) {
      return entityInScope(entityId);
    },
    listEntities(requestedProductId) {
      return requestedProductId === productId
        ? store.listEntities(productId).filter((entity) => matchesSource(entity, source))
        : [];
    },
    addClaim: rejectWrite,
    getClaims(entityId) {
      return entityInScope(entityId)
        ? store.getClaims(entityId).filter((claim) => matchesSource(claim, source))
        : [];
    },
    getApprovedClaims(entityId) {
      return entityInScope(entityId)
        ? store.getApprovedClaims(entityId).filter((claim) => matchesSource(claim, source))
        : [];
    },
    addTraceLink: rejectWrite,
    getTraceLinks(entityId) {
      return entityInScope(entityId)
        ? scopedLinks(store, entityId, productId, source)
        : [];
    },
    addConflict: rejectWrite,
    listOpenConflicts(entityId) {
      if (entityId && !entityInScope(entityId)) return [];
      return store.listOpenConflicts(entityId).filter((conflict) =>
        Boolean(entityInScope(conflict.entityId)));
    },
    conflicts() {
      return store.conflicts().filter((item) =>
        "entityId" in item && Boolean(entityInScope(item.entityId)));
    },
  };
}

function jsonResourceContent(value) {
  return {
    type: "application/json",
    text: JSON.stringify(value),
  };
}

function parseResourceUri(uri, productId) {
  let resource;
  try {
    resource = new URL(uri);
  } catch {
    return undefined;
  }

  let segments;
  try {
    segments = resource.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (resource.protocol !== "tkl:" || resource.hostname !== "products" || segments[0] !== productId) {
    return undefined;
  }

  if (segments.length === 3 && ["features", "requirements", "traceability"].includes(segments[1])) {
    return {
      kind: {
        features: "feature",
        requirements: "requirement",
        traceability: "traceability",
      }[segments[1]],
      resourceId: segments[2],
    };
  }
  if (segments.length === 5 && segments[1] === "sources" && segments[4] === "provenance") {
    return {
      kind: "provenance",
      source: segments[2],
      resourceId: segments[3],
    };
  }
  return undefined;
}
