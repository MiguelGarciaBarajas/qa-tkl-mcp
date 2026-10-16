import { randomUUID } from "node:crypto";

const MULTI_VALUE_ATTRIBUTES = new Set([
  "acceptanceCriteria",
  "label",
  "attributes",
  "externalIssues",
]);
const RULE_ATTRIBUTES = new Set([
  "acceptanceCriteria",
  "description",
  "custom_preconds",
  "custom_steps",
  "custom_steps_separated",
  "custom_expected",
]);
const DUPLICATE_TYPES = new Set(["requirement", "story", "manual-test", "test"]);
const MAPPABLE_TEST_TYPES = new Set(["manual-test", "test"]);
const STOP_WORDS = new Set([
  "and", "are", "for", "from", "into", "the", "then", "this", "that", "with",
  "when", "where", "will", "should", "must", "verify", "validate", "test",
]);

export const knowledgeCuratorAgentManifest = Object.freeze({
  id: "agent.knowledge-curator",
  version: "0.1.0",
  capabilities: [
    "knowledge-conflicts.read",
    "knowledge-duplicates.inspect",
    "traceability-gaps.inspect",
    "knowledge-staleness.inspect",
    "knowledge-curation.propose",
  ],
  mode: "proposal-only",
});

export function createKnowledgeCuratorAgent({
  knowledgeService,
  now = () => new Date().toISOString(),
  createRunId = () => randomUUID(),
  staleAfterDays = 180,
  maxFindings = 100,
  maxSimilarityComparisons = 10_000,
} = {}) {
  if (!knowledgeService) throw new TypeError("knowledgeService is required");
  if (!Number.isSafeInteger(staleAfterDays) || staleAfterDays < 1) {
    throw new TypeError("staleAfterDays must be a positive integer");
  }
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1) {
    throw new TypeError("maxFindings must be a positive integer");
  }
  if (!Number.isSafeInteger(maxSimilarityComparisons) || maxSimilarityComparisons < 1) {
    throw new TypeError("maxSimilarityComparisons must be a positive integer");
  }

  return {
    manifest: knowledgeCuratorAgentManifest,

    async execute({ productId, workItemId }) {
      const context = await knowledgeService.getKnowledgeCurationContext({
        productId,
        workItemId,
      });
      const generatedAt = now();
      const run = {
        runId: createRunId(),
        agent: knowledgeCuratorAgentManifest,
        productId,
        workItemId,
        generatedAt,
        scope: {
          rootRequirementId: context.rootRequirementId
            ?? `requirement:${workItemId}`,
          requirementIds: context.scopeRequirementIds ?? [],
          productId,
        },
      };

      if (!context.trace) {
        return {
          ...run,
          status: "not-found",
          confidence: {
            level: "none",
            rationale: "The Jira work item is not present in canonical knowledge.",
          },
          summary: `No grounded curation context was found for ${workItemId}.`,
          findings: [],
          proposals: [],
          evidence: emptyEvidence(),
          limitations: [
            "No canonical Jira requirement was found in the requested product.",
            proposalOnlyLimitation(),
          ],
          approval: approvalRequirement(),
        };
      }

      const similarityAnalysis = createSimilarityAnalysis(maxSimilarityComparisons);
      const findings = [
        ...inspectConflicts(context),
        ...inspectDuplicateEntities(context, similarityAnalysis),
        ...inspectDuplicateIntents(context, similarityAnalysis),
        ...inspectMissingTraceLinks(context, similarityAnalysis),
        ...inspectStaleClaims(context, generatedAt, staleAfterDays),
      ]
        .sort(compareFindings)
        .slice(0, maxFindings);
      const proposals = findings.map(proposalForFinding);
      const citations = uniqueCitations([
        ...(context.scopedEntities ?? []).flatMap(provenanceEntries),
        ...(context.scopedClaims ?? []).flatMap(provenanceEntries),
        ...(context.scopedTraceLinks ?? []).flatMap(provenanceEntries),
        ...findings.flatMap((finding) => finding.citations),
      ]);
      const limitations = buildLimitations({
        context,
        findings,
        maxFindings,
        staleAfterDays,
        similarityAnalysis,
      });

      return {
        ...run,
        status: findings.length > 0 ? "ready-for-review" : "insufficient-context",
        confidence: overallConfidence(context, findings, similarityAnalysis),
        summary:
          `${findings.length} reviewable curation finding(s) were identified within `
          + `${context.scopeRequirementIds.length} Jira requirement(s) in the requested hierarchy.`,
        findings,
        proposals,
        evidence: {
          sources: unique(citations.map((citation) => citation.source)),
          requirements: context.trace.requirements ?? [],
          entities: context.scopedEntities ?? [],
          claims: context.scopedClaims ?? [],
          traceLinks: context.scopedTraceLinks ?? [],
          openConflicts: context.openConflicts ?? [],
          unresolvedTraceLinks: context.unresolvedTraceLinks ?? [],
          citations,
        },
        limitations,
        approval: approvalRequirement(),
      };
    },
  };
}

function inspectConflicts(context) {
  const scopeRequirementIds = hierarchyScopeIds(context);
  const claimsById = new Map((context.scopedClaims ?? []).map((claim) => [claim.id, claim]));
  const entitiesById = new Map((context.scopedEntities ?? []).map((entity) => [entity.id, entity]));
  return (context.openConflicts ?? [])
    .filter((conflict) => scopeRequirementIds.has(conflict.entityId))
    .map((conflict) => {
      const entity = entitiesById.get(conflict.entityId);
      const claims = conflict.claimIds.map((claimId) => claimsById.get(claimId)).filter(Boolean);
      const attribute = claims[0]?.attribute ?? "unknown";
      const recommendation = recommendedConflictClaims(entity, claims, attribute);
      const citations = uniqueCitations([
        ...provenanceEntries(entity),
        ...claims.flatMap(provenanceEntries),
      ]);
      return {
        id: `curation:${conflict.id}`,
        category: "open-conflict",
        severity: "high",
        title: `Review conflicting ${attribute} claims for ${entity?.title ?? conflict.entityId}`,
        detail: conflict.reason,
        entityIds: [conflict.entityId],
        claimIds: conflict.claimIds,
        evidenceIds: unique([conflict.entityId, ...conflict.claimIds]),
        confidence: recommendation.claimIds.length > 0
          ? {
              level: "medium",
              rationale: "One scalar claim matches the current canonical source version; a reviewer must still verify it.",
            }
          : {
              level: "low",
              rationale: "The evidence does not safely identify a winning claim, so the agent abstains from selecting one.",
            },
        citations,
        preview: {
          before: claims.map(claimPreview),
          action: "review-conflict",
          after: recommendation.claimIds.length > 0
            ? {
                proposedApprovedClaimIds: recommendation.claimIds,
                otherClaimStatuses: "rejected only after explicit human approval",
              }
            : {
                proposedApprovedClaimIds: [],
                outcome: "Reviewer must select supported claim(s); no automatic resolution is proposed.",
              },
        },
        disposition: recommendation.claimIds.length > 0 ? "propose-review" : "abstain",
        limitations: recommendation.limitations,
      };
    });
}

function recommendedConflictClaims(entity, claims, attribute) {
  if (MULTI_VALUE_ATTRIBUTES.has(attribute)) {
    return {
      claimIds: [],
      limitations: [
        `${attribute} is multi-valued; different values may all be valid and cannot be reduced automatically.`,
      ],
    };
  }
  const currentVersions = new Set(
    provenanceEntries(entity).map(sourceVersionKey),
  );
  const currentClaims = claims.filter((claim) =>
    provenanceEntries(claim).some((item) => currentVersions.has(sourceVersionKey(item))));
  const sources = new Set(claims.flatMap(provenanceEntries).map((item) => item.source));
  if (currentClaims.length === 1 && sources.size === 1) {
    return { claimIds: [currentClaims[0].id], limitations: [] };
  }
  return {
    claimIds: [],
    limitations: [
      "Conflicting sources or current-version claims require a reviewer to choose; the agent abstained.",
    ],
  };
}

function inspectDuplicateEntities(context, similarityAnalysis) {
  const scopeRequirementIds = hierarchyScopeIds(context);
  const candidates = (context.candidateEntities ?? [])
    .filter((entity) => DUPLICATE_TYPES.has(entity.type));
  const anchors = candidates.filter((entity) => scopeRequirementIds.has(entity.id));
  const titleProfiles = new Map(
    candidates.map((entity) => [entity.id, similarityAnalysis.profile(entity.title)]),
  );
  const comparedPairs = new Set();
  const findings = [];
  comparisons:
  for (const left of anchors) {
    for (const right of candidates) {
      if (left.id === right.id) continue;
      if (!sameEntityFamily(left.type, right.type)) continue;
      const key = pairKey(left.id, right.id);
      if (comparedPairs.has(key)) continue;
      comparedPairs.add(key);
      const score = similarityAnalysis.compare(
        titleProfiles.get(left.id),
        titleProfiles.get(right.id),
        { exactNormalizedMatch: true },
      );
      if (score === null) break comparisons;
      if (score < 0.9) continue;
      const citations = uniqueCitations([
        ...provenanceEntries(left),
        ...provenanceEntries(right),
      ]);
      findings.push({
        id: `curation:duplicate-entity:${safeId(left.id)}:${safeId(right.id)}`,
        category: "duplicate-entity",
        severity: "medium",
        title: `Review possible duplicate entities: ${left.title}`,
        detail: `The canonical titles have ${Math.round(score * 100)}% token similarity.`,
        entityIds: [left.id, right.id],
        claimIds: [],
        evidenceIds: [left.id, right.id],
        confidence: {
          level: score === 1 ? "medium" : "low",
          rationale: "Title similarity is a review signal, not proof that identity and lifecycle are equivalent.",
        },
        citations,
        preview: {
          before: [entityPreview(left), entityPreview(right)],
          action: "review-entity-merge",
          after: {
            survivorId: "reviewer-select",
            aliases: [left.id, right.id],
            traceLinks: "Repoint only after provenance and lifecycle review.",
          },
        },
        disposition: "propose-review",
        limitations: ["No entity is deleted, aliased, or merged by this proposal."],
      });
    }
  }
  return findings;
}

function inspectDuplicateIntents(context, similarityAnalysis) {
  const findings = [];
  const scopeRequirementIds = hierarchyScopeIds(context);
  const conflictedClaimIds = new Set(context.conflictedClaimIds ?? []);
  const byEntity = Map.groupBy(
    (context.currentScopedClaims ?? []).filter((claim) =>
      scopeRequirementIds.has(claim.entityId)
      && claim.status !== "rejected"
      && RULE_ATTRIBUTES.has(claim.attribute)
      && typeof claim.value === "string"),
    (claim) => `${claim.entityId}\u0000${claim.attribute}`,
  );
  const claimProfiles = new Map(
    [...byEntity.values()]
      .flat()
      .map((claim) => [claim.id, similarityAnalysis.profile(claim.value)]),
  );
  withinEntityComparisons:
  for (const claims of byEntity.values()) {
    const entityId = claims[0].entityId;
    for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
        const left = claims[leftIndex];
        const right = claims[rightIndex];
        const score = similarityAnalysis.compare(
          claimProfiles.get(left.id),
          claimProfiles.get(right.id),
        );
        if (score === null) break withinEntityComparisons;
        if (score < 0.88) continue;
        const citations = uniqueCitations([
          ...provenanceEntries(left),
          ...provenanceEntries(right),
        ]);
        findings.push({
          id: `curation:duplicate-intent:${safeId(left.id)}:${safeId(right.id)}`,
          category: "duplicate-intent",
          severity: "low",
          title: `Review repeated ${left.attribute} intent`,
          detail: `Two claims on ${entityId} have ${Math.round(score * 100)}% semantic-token overlap.`,
          entityIds: [entityId],
          claimIds: [left.id, right.id],
          evidenceIds: [left.id, right.id],
          confidence: {
            level: score === 1 ? "medium" : "low",
            rationale: "Lexical overlap cannot prove that edge cases, scope, or business meaning are identical.",
          },
          citations,
          preview: {
            before: [claimPreview(left), claimPreview(right)],
            action: "review-intent-consolidation",
            after: {
              retainedIntent: "reviewer-select-or-rewrite",
              provenance: "Preserve both evidence histories if consolidated.",
            },
          },
          disposition: "propose-review",
          limitations: [
            "The claims remain unchanged until a human approves a consolidation.",
            ...(
              conflictedClaimIds.has(left.id) || conflictedClaimIds.has(right.id)
                ? ["At least one intent also belongs to an open conflict; resolve both reviews together."]
                : []
            ),
          ],
        });
      }
    }
  }

  const currentClaimsByEntity = Map.groupBy(
    (context.currentCandidateClaims ?? context.candidateClaims ?? []).filter((claim) =>
      claim.status !== "rejected"
      && !conflictedClaimIds.has(claim.id)
      && RULE_ATTRIBUTES.has(claim.attribute)
      && typeof claim.value === "string"),
    (claim) => claim.entityId,
  );
  const candidates = (context.candidateEntities ?? [])
    .filter((entity) => DUPLICATE_TYPES.has(entity.type));
  const anchors = candidates.filter((entity) => scopeRequirementIds.has(entity.id));
  const titleProfiles = new Map(
    candidates.map((entity) => [entity.id, similarityAnalysis.profile(entity.title)]),
  );
  const intentProfiles = new Map(
    candidates.map((entity) => [
      entity.id,
      similarityAnalysis.profile(entityIntent(entity, currentClaimsByEntity.get(entity.id))),
    ]),
  );
  const comparedPairs = new Set();
  crossEntityComparisons:
  for (const left of anchors) {
    for (const right of candidates) {
      if (left.id === right.id) continue;
      if (!sameEntityFamily(left.type, right.type)) continue;
      const key = pairKey(left.id, right.id);
      if (comparedPairs.has(key)) continue;
      comparedPairs.add(key);
      const titleScore = similarityAnalysis.compare(
        titleProfiles.get(left.id),
        titleProfiles.get(right.id),
        { exactNormalizedMatch: true },
      );
      if (titleScore === null) break crossEntityComparisons;
      if (titleScore >= 0.9) continue;
      const leftClaims = currentClaimsByEntity.get(left.id) ?? [];
      const rightClaims = currentClaimsByEntity.get(right.id) ?? [];
      if (leftClaims.length === 0 || rightClaims.length === 0) continue;
      const score = similarityAnalysis.compare(
        intentProfiles.get(left.id),
        intentProfiles.get(right.id),
      );
      if (score === null) break crossEntityComparisons;
      if (score < 0.88) continue;
      const citations = uniqueCitations([
        ...provenanceEntries(left),
        ...provenanceEntries(right),
        ...leftClaims.flatMap(provenanceEntries),
        ...rightClaims.flatMap(provenanceEntries),
      ]);
      findings.push({
        id: `curation:duplicate-intent:${safeId(left.id)}:${safeId(right.id)}`,
        category: "duplicate-intent",
        severity: "medium",
        title: `Review possible duplicate intent across ${left.title} and ${right.title}`,
        detail: `Current cited intent has ${Math.round(score * 100)}% lexical-token overlap.`,
        entityIds: [left.id, right.id],
        claimIds: [...leftClaims, ...rightClaims].map((claim) => claim.id),
        evidenceIds: [
          left.id,
          right.id,
          ...leftClaims.map((claim) => claim.id),
          ...rightClaims.map((claim) => claim.id),
        ],
        confidence: {
          level: "low",
          rationale: "Matching intent text does not prove equivalent setup, scope, ownership, or lifecycle.",
        },
        citations,
        preview: {
          before: [
            { entity: entityPreview(left), claims: leftClaims.map(claimPreview) },
            { entity: entityPreview(right), claims: rightClaims.map(claimPreview) },
          ],
          action: "review-intent-consolidation",
          after: {
            outcome: "Reviewer keeps both, consolidates intent, or records an explicit distinction.",
            provenance: "Preserve both evidence histories in any approved decision.",
          },
        },
        disposition: "propose-review",
        limitations: ["No test, requirement, or claim is merged or removed by this proposal."],
      });
    }
  }
  return findings;
}

function inspectMissingTraceLinks(context, similarityAnalysis) {
  const findings = [];
  const requirements = context.trace?.requirements ?? [];
  const scopeRequirementIds = hierarchyScopeIds(context);
  const links = context.productTraceLinks ?? [];
  const linkedPairs = new Set(links.map((link) => `${link.fromEntityId}|${link.toEntityId}`));
  const conflictedClaimIds = new Set(context.conflictedClaimIds ?? []);
  const claimTextByEntity = Map.groupBy(
    (context.currentCandidateClaims ?? context.candidateClaims ?? []).filter((claim) =>
      claim.status !== "rejected"
      && !conflictedClaimIds.has(claim.id)
      && typeof claim.value === "string"),
    (claim) => claim.entityId,
  );
  const candidates = (context.candidateEntities ?? []).filter((entity) =>
    MAPPABLE_TEST_TYPES.has(entity.type)
    || (
      entity.type === "requirement"
      && provenanceEntries(entity).some((item) => item.source === "confluence")
    ));
  const intentProfiles = new Map(
    [...requirements, ...candidates].map((entity) => [
      entity.id,
      similarityAnalysis.profile(entityIntent(entity, claimTextByEntity.get(entity.id))),
    ]),
  );

  inferredLinkComparisons:
  for (const requirement of requirements.filter((item) =>
    scopeRequirementIds.has(item.id))) {
    for (const candidate of candidates) {
      if (candidate.id === requirement.id) continue;
      const linkType = MAPPABLE_TEST_TYPES.has(candidate.type) ? "verifies" : "relates_to";
      if (
        linkedPairs.has(`${candidate.id}|${requirement.id}`)
        || linkedPairs.has(`${requirement.id}|${candidate.id}`)
      ) continue;
      const score = similarityAnalysis.compare(
        intentProfiles.get(requirement.id),
        intentProfiles.get(candidate.id),
      );
      if (score === null) break inferredLinkComparisons;
      if (score < 0.78) continue;
      const citations = uniqueCitations([
        ...provenanceEntries(requirement),
        ...provenanceEntries(candidate),
        ...(claimTextByEntity.get(requirement.id) ?? []).flatMap(provenanceEntries),
        ...(claimTextByEntity.get(candidate.id) ?? []).flatMap(provenanceEntries),
      ]);
      findings.push({
        id: `curation:missing-link:${safeId(candidate.id)}:${safeId(requirement.id)}`,
        category: "missing-trace-link",
        severity: "medium",
        title: `Review a possible ${linkType} mapping`,
        detail:
          `${candidate.title} is not linked to ${requirement.title}; cited intent has `
          + `${Math.round(score * 100)}% semantic-token overlap.`,
        entityIds: [candidate.id, requirement.id],
        claimIds: [],
        evidenceIds: [candidate.id, requirement.id],
        confidence: {
          level: "low",
          rationale: "The mapping is inferred from bounded text overlap and requires source-owner confirmation.",
        },
        citations,
        preview: {
          before: { matchingTraceLink: null },
          action: "review-trace-mapping",
          after: {
            proposedLink: {
              fromEntityId: candidate.id,
              toEntityId: requirement.id,
              type: linkType,
              origin: "inferred",
              confidence: round(score),
            },
          },
        },
        disposition: "propose-review",
        limitations: ["No trace link is created by this proposal."],
      });
    }
  }

  for (const unresolved of (context.unresolvedTraceLinks ?? []).filter((link) =>
    scopeRequirementIds.has(link.fromEntityId)
    || scopeRequirementIds.has(link.toEntityId))) {
    findings.push({
      id: `curation:unresolved-link:${safeId(unresolved.id)}`,
      category: "missing-trace-link",
      severity: "high",
      title: "Review an unresolved explicit trace link",
      detail: `${unresolved.fromEntityId} → ${unresolved.toEntityId} cannot be materialized because an endpoint is missing.`,
      entityIds: [unresolved.fromEntityId, unresolved.toEntityId],
      claimIds: [],
      evidenceIds: [unresolved.id],
      confidence: {
        level: "high",
        rationale: "The unresolved link is preserved directly by the canonical ingestion boundary.",
      },
      citations: uniqueCitations(provenanceEntries(unresolved)),
      preview: {
        before: { unresolvedLink: unresolved },
        action: "review-source-mapping-or-sync",
        after: {
          outcome: "Synchronize or map the missing endpoint, then re-run normalization and human review.",
        },
      },
      disposition: "propose-review",
      limitations: ["The agent cannot fabricate the missing endpoint or repair the link."],
    });
  }
  return findings;
}

function inspectStaleClaims(context, generatedAt, staleAfterDays) {
  const generatedTimestamp = Date.parse(generatedAt);
  if (!Number.isFinite(generatedTimestamp)) return [];
  const staleBefore = generatedTimestamp - staleAfterDays * 24 * 60 * 60 * 1000;
  const scopeRequirementIds = hierarchyScopeIds(context);
  const entitiesById = new Map((context.scopedEntities ?? []).map((entity) => [entity.id, entity]));
  return (context.currentScopedClaims ?? [])
    .filter((claim) =>
      scopeRequirementIds.has(claim.entityId) && RULE_ATTRIBUTES.has(claim.attribute))
    .flatMap((claim) => {
      const newestObservedAt = newestTimestamp(provenanceEntries(claim));
      if (newestObservedAt === null || newestObservedAt >= staleBefore) return [];
      const entity = entitiesById.get(claim.entityId);
      const businessRule = claim.attribute === "acceptanceCriteria"
        || provenanceEntries(claim).some((item) => item.source === "confluence");
      const ageDays = Math.floor((generatedTimestamp - newestObservedAt) / (24 * 60 * 60 * 1000));
      return [{
        id: `curation:stale-claim:${safeId(claim.id)}`,
        category: businessRule ? "stale-business-rule" : "stale-claim",
        severity: businessRule ? "high" : "medium",
        title: `Review stale ${businessRule ? "business rule" : claim.attribute}`,
        detail:
          `${entity?.title ?? claim.entityId} has not been observed from its source in `
          + `${ageDays} days.`,
        entityIds: [claim.entityId],
        claimIds: [claim.id],
        evidenceIds: [claim.id],
        confidence: {
          level: "medium",
          rationale: "Staleness is based only on the cited source observation time, not on an assertion that the value is wrong.",
        },
        citations: uniqueCitations(provenanceEntries(claim)),
        preview: {
          before: claimPreview(claim),
          action: "review-stale-knowledge",
          after: {
            outcome: "Reviewer retains, updates from newly synchronized evidence, or rejects the claim.",
            requiredEvidence: "A current authoritative source version and reviewer decision.",
          },
        },
        disposition: "propose-review",
        limitations: [
          "Age alone does not prove that a claim or business rule is obsolete.",
          "No value or status is changed by this proposal.",
        ],
      }];
    });
}

function proposalForFinding(finding) {
  return {
    id: `proposal:${finding.id}`,
    findingId: finding.id,
    kind: {
      "open-conflict": "conflict-resolution",
      "duplicate-entity": "entity-merge",
      "duplicate-intent": "intent-merge",
      "missing-trace-link": "trace-mapping",
      "stale-claim": "stale-claim-review",
      "stale-business-rule": "business-rule-review",
    }[finding.category],
    disposition: finding.disposition,
    title: finding.title,
    rationale: finding.detail,
    confidence: finding.confidence,
    evidenceIds: finding.evidenceIds,
    citations: finding.citations,
    preview: finding.preview,
    limitations: finding.limitations,
    approval: approvalRequirement(),
  };
}

function buildLimitations({
  context,
  findings,
  maxFindings,
  staleAfterDays,
  similarityAnalysis,
}) {
  const limitations = [
    proposalOnlyLimitation(),
    "Similarity findings are deterministic lexical review signals, not semantic proof.",
    `Staleness means the latest cited observation is older than ${staleAfterDays} days; it does not mean the claim is false.`,
    "Every proposed mapping, merge, stale-knowledge decision, and conflict resolution requires explicit human approval.",
  ];
  if ((context.openConflicts ?? []).some((conflict) =>
    findings.some((finding) =>
      finding.category === "open-conflict"
      && finding.id === `curation:${conflict.id}`
      && finding.disposition === "abstain"))) {
    limitations.push("At least one conflict was intentionally left without a preferred winner.");
  }
  if (context.candidateEntitiesTruncated || context.candidateClaimsTruncated
    || context.productTraceLinksTruncated) {
    limitations.push("Product candidate evidence was truncated by service safety bounds.");
  }
  if (context.hierarchyTruncated) {
    limitations.push("The Jira hierarchy was truncated by the existing traceability safety bound.");
  }
  if (similarityAnalysis.truncated) {
    limitations.push(
      `Similarity analysis was truncated after ${similarityAnalysis.comparisons} comparisons `
      + `by the ${similarityAnalysis.maxComparisons}-comparison safety bound; additional candidates were not inspected.`,
    );
  }
  if (findings.length >= maxFindings) {
    limitations.push(`Findings are bounded to the first ${maxFindings} items in deterministic order.`);
  }
  if ((context.unresolvedTraceLinks ?? []).length > 0) {
    limitations.push("Some explicit links still reference a missing canonical endpoint.");
  }
  return limitations;
}

function overallConfidence(context, findings, similarityAnalysis) {
  if (similarityAnalysis.truncated) {
    return {
      level: "low",
      rationale: "Similarity analysis reached its safety bound, so uninspected candidates may contain additional findings.",
    };
  }
  if ((context.scopedClaims ?? []).length === 0) {
    return {
      level: "low",
      rationale: "The Jira hierarchy exists, but it has no claim evidence for reliable curation.",
    };
  }
  if (findings.length === 0) {
    return {
      level: "medium",
      rationale: "The bounded scoped evidence was inspected and no conservative curation proposal threshold was met.",
    };
  }
  if (findings.some((finding) => finding.confidence.level === "low")) {
    return {
      level: "medium",
      rationale: "Direct provenance is available, but one or more proposals rely on inferred similarity or intentionally abstain.",
    };
  }
  return {
    level: "high",
    rationale: "All findings are based on direct conflicts, unresolved links, or source observation timestamps.",
  };
}

function approvalRequirement() {
  return {
    required: true,
    role: "knowledge-reviewer",
    allowedActions: ["approve", "reject", "request-evidence"],
    statement:
      "A human reviewer must verify provenance and scope before any separate approved workflow changes canonical knowledge.",
  };
}

function proposalOnlyLimitation() {
  return "This agent is proposal-only and cannot mutate canonical entities, claims, trace links, reviews, or source systems.";
}

function entityIntent(entity, claims = []) {
  return [
    entity.title,
    ...claims
      .filter((claim) => RULE_ATTRIBUTES.has(claim.attribute))
      .map((claim) => serializableText(claim.value)),
  ].join(" ");
}

function claimPreview(claim) {
  return {
    id: claim.id,
    attribute: claim.attribute,
    value: claim.value,
    status: claim.status,
    origin: claim.origin,
    confidence: claim.confidence,
    provenance: provenanceEntries(claim),
  };
}

function entityPreview(entity) {
  return {
    id: entity.id,
    type: entity.type,
    title: entity.title,
    provenance: provenanceEntries(entity),
  };
}

function sameEntityFamily(left, right) {
  if (left === right) return true;
  return ["requirement", "story"].includes(left) && ["requirement", "story"].includes(right);
}

function createSimilarityAnalysis(maxComparisons) {
  const profiles = new Map();
  const state = {
    comparisons: 0,
    maxComparisons,
    truncated: false,
    profile(value) {
      const normalized = normalizeText(serializableText(value));
      let profile = profiles.get(normalized);
      if (!profile) {
        profile = {
          normalized,
          tokens: new Set(
            normalized
              .split(" ")
              .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
          ),
        };
        profiles.set(normalized, profile);
      }
      return profile;
    },
    compare(left, right, { exactNormalizedMatch = false } = {}) {
      if (state.comparisons >= maxComparisons) {
        state.truncated = true;
        return null;
      }
      state.comparisons += 1;
      if (
        exactNormalizedMatch
        && left.normalized
        && left.normalized === right.normalized
      ) {
        return 1;
      }
      if (left.tokens.size === 0 || right.tokens.size === 0) return 0;
      const intersection = [...left.tokens]
        .filter((token) => right.tokens.has(token))
        .length;
      if (intersection < Math.min(3, left.tokens.size, right.tokens.size)) return 0;
      const unionSize = new Set([...left.tokens, ...right.tokens]).size;
      return intersection / unionSize;
    },
  };
  return state;
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function serializableText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function newestTimestamp(provenance) {
  const timestamps = provenance.map((item) => Date.parse(item.observedAt)).filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function sourceVersionKey(provenance) {
  return `${provenance.source}|${provenance.sourceId}|${provenance.sourceVersion}`;
}

function provenanceEntries(value) {
  if (!value?.provenance) return [];
  return Array.isArray(value.provenance) ? value.provenance : [value.provenance];
}

function uniqueCitations(values) {
  const citations = new Map();
  for (const value of values.filter(Boolean)) {
    citations.set(
      `${value.source}|${value.sourceId}|${value.sourceVersion}|${value.contentHash ?? ""}`,
      value,
    );
  }
  return [...citations.values()].sort((left, right) =>
    left.source.localeCompare(right.source)
    || left.sourceId.localeCompare(right.sourceId)
    || left.sourceVersion.localeCompare(right.sourceVersion));
}

function compareFindings(left, right) {
  const severity = { high: 0, medium: 1, low: 2 };
  return severity[left.severity] - severity[right.severity]
    || left.category.localeCompare(right.category)
    || left.id.localeCompare(right.id);
}

function unique(values) {
  return [...new Set(values)];
}

function hierarchyScopeIds(context) {
  return new Set(context.scopeRequirementIds ?? []);
}

function pairKey(leftId, rightId) {
  return leftId.localeCompare(rightId) < 0
    ? `${leftId}\u0000${rightId}`
    : `${rightId}\u0000${leftId}`;
}

function safeId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function emptyEvidence() {
  return {
    sources: [],
    requirements: [],
    entities: [],
    claims: [],
    traceLinks: [],
    openConflicts: [],
    unresolvedTraceLinks: [],
    citations: [],
  };
}
