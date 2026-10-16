import { randomUUID } from "node:crypto";

export const testRailImprovementAgentManifest = Object.freeze({
  id: "agent.testrail-improvement",
  version: "0.1.0",
  capabilities: [
    "quality-context.read",
    "test-case.inspect",
    "test-case.improvement.propose",
    "duplicates.detect",
  ],
  mode: "proposal-only",
});

const REVIEW_PRECONDITIONS =
  "[Reviewer input required: document only prerequisites verified for this case.]";
const REVIEW_ACTION =
  "[Reviewer input required: add a verified product action from the cited requirement.]";
const REVIEW_EXPECTED =
  "[Reviewer input required: add the observable result supported by cited evidence.]";
const REVIEW_REQUIREMENT =
  "[Reviewer selection required: map this case to the specific scoped Jira requirement(s) it verifies.]";

export function createTestRailImprovementAgent({
  knowledgeService,
  now = () => new Date().toISOString(),
  createRunId = () => randomUUID(),
  duplicateThreshold = 0.6,
} = {}) {
  if (!knowledgeService) throw new TypeError("knowledgeService is required");

  return {
    manifest: testRailImprovementAgentManifest,

    async execute({ productId, workItemId, caseId, unifiedContext }) {
      const normalizedCaseId = caseId
        ? BigInt(String(caseId).replace(/^C/i, "")).toString()
        : null;
      const context = normalizedCaseId
        ? await knowledgeService.getTestRailCaseImprovementContext({
            productId,
            caseId: normalizedCaseId,
          })
        : await knowledgeService.getTestRailImprovementContext({
            productId,
            workItemId,
          });
      const scopeId = normalizedCaseId ? `C${normalizedCaseId}` : workItemId;
      const run = {
        runId: createRunId(),
        agent: testRailImprovementAgentManifest,
        productId,
        workItemId: scopeId,
        ...(normalizedCaseId ? { caseId: normalizedCaseId } : {}),
        generatedAt: now(),
      };

      if (!context.trace) {
        return {
          ...run,
          status: "not-found",
          confidence: {
            level: "none",
            rationale: "The Jira work item is not present in canonical knowledge.",
          },
          summary: `No grounded TestRail improvement context was found for ${scopeId}.`,
          proposals: [],
          evidence: emptyEvidence(),
          limitations: ["No canonical Jira requirement was found."],
        };
      }

      const conflictedCaseCount = context.caseContexts.filter(
        (item) => item.conflictedClaimCount > 0,
      ).length;
      const eligibleCases = context.caseContexts.filter(
        (item) => item.conflictedClaimCount === 0,
      );
      const proposals = eligibleCases
        .map((caseContext) => assessCase({
          caseContext,
          allManualTestContexts: context.allManualTestContexts,
          rootRequirementId: context.rootRequirementId,
          hasContainedRequirements: context.scopeRequirementIds.length > 1,
          duplicateThreshold,
        }))
        .filter((proposal) =>
          proposal.findings.length > 0 || proposal.duplicateCandidates.length > 0);
      const limitations = [];

      if (context.caseContexts.length === 0) {
        limitations.push(
          "No synchronized TestRail cases are explicitly linked to the requested Jira scope.",
        );
      }
      if (conflictedCaseCount > 0) {
        limitations.push(
          `${conflictedCaseCount} linked TestRail case(s) were excluded because their current claims have unresolved conflicts.`,
        );
      }
      if (context.allManualTestContexts.length === 0) {
        limitations.push(
          "No synchronized TestRail library is available for duplicate-intent comparison.",
        );
      }
      if (context.allManualTestContexts.some((item) => item.conflictedClaimCount > 0)) {
        limitations.push(
          "TestRail cases with unresolved conflicts in inspected fields were excluded from duplicate comparison.",
        );
      }
      if (context.allManualTestContexts.length > 4) {
        limitations.push(
          "Duplicate candidates are ranked by title and step-token similarity; only the top three are returned per case.",
        );
      }
      if (context.trace.context?.truncated) {
        limitations.push(
          `The Jira hierarchy is truncated to ${context.trace.context.returnedRequirementCount} of `
          + `${context.trace.context.relatedRequirementCount} related work items.`,
        );
      }
      limitations.push(
        "Proposed placeholder values require QA review; the agent does not invent product actions or write to TestRail.",
      );
      limitations.push(...(unifiedContext?.limitations ?? []));

      const evidenceValues = [
        ...context.trace.requirements,
        ...context.trace.relationships,
        ...context.caseContexts.flatMap(({ testCase, claims, relationships }) =>
          [testCase, ...claims, ...relationships]),
      ].filter(Boolean);
      const citations = uniqueCitations([
        ...evidenceValues.flatMap(provenanceEntries),
        ...proposals.flatMap((proposal) => proposal.citations),
      ]);
      const sources = unique([
        ...citations.map((citation) => citation.source),
        ...(unifiedContext?.citations ?? []).map((citation) => citation.source),
      ]);
      const improvementCount = proposals.filter((proposal) =>
        proposal.fieldDiffs.length > 0).length;
      const duplicateCount = proposals.filter((proposal) =>
        proposal.duplicateCandidates.length > 0).length;

      return {
        ...run,
        status: eligibleCases.length === 0
          ? "insufficient-context"
          : "ready-for-review",
        confidence: confidenceFor({
          caseCount: context.caseContexts.length,
          conflictedCaseCount,
          sources,
        }),
        summary: `${context.caseContexts.length} linked TestRail case(s) inspected for `
          + `${scopeId}; ${improvementCount} edit proposal(s) and `
          + `${duplicateCount} duplicate-intent review(s) produced across `
          + `${sources.length} grounded source(s).`,
        proposals,
        evidence: {
          sources,
          requirements: context.trace.requirements,
          manualTests: context.caseContexts.map(({ testCase }) => testCase),
          relationships: uniqueById(
            context.caseContexts.flatMap(({ relationships }) => relationships),
          ),
          candidateRelationships: unifiedContext?.candidateRelationships ?? [],
          sourceStatus: unifiedContext?.sourceStatus ?? {},
          retrievals: unifiedContext?.retrievals ?? [],
          citations: uniqueCitations([
            ...citations,
            ...(unifiedContext?.citations ?? []),
          ]),
        },
        limitations: unique(limitations),
      };
    },
  };
}

function assessCase({
  caseContext,
  allManualTestContexts,
  rootRequirementId,
  hasContainedRequirements,
  duplicateThreshold,
}) {
  const { testCase, claims, relationships, requirementIds } = caseContext;
  const preconditions = latestClaimValue(claims, "custom_preconds");
  const separatedSteps = latestClaimValue(claims, "custom_steps_separated");
  const plainSteps = latestClaimValue(claims, "custom_steps");
  const customExpected = latestClaimValue(claims, "custom_expected");
  const caseCitations = uniqueCitations(
    [testCase, ...claims, ...relationships].flatMap(provenanceEntries),
  );
  const findings = [];
  const fieldDiffs = [];

  if (typeof preconditions !== "string" || preconditions.trim().length === 0) {
    findings.push(finding({
      caseId: testCase.id,
      category: "missing-preconditions",
      severity: "medium",
      detail: "The synchronized TestRail case has no explicit preconditions.",
      evidenceIds: [testCase.id],
    }));
    fieldDiffs.push(fieldDiff({
      field: "custom_preconds",
      before: preconditions ?? null,
      after: REVIEW_PRECONDITIONS,
      rationale: "Make prerequisites explicit without asserting an unverified product setup.",
      citations: caseCitations,
    }));
  }

  const stepDiff = improveSeparatedSteps(separatedSteps, plainSteps, customExpected);
  if (stepDiff.missingSteps) {
    findings.push(finding({
      caseId: testCase.id,
      category: "missing-steps",
      severity: "high",
      detail: "The synchronized TestRail case has no complete executable action sequence.",
      evidenceIds: [testCase.id],
    }));
  }
  if (stepDiff.missingExpectedResults) {
    findings.push(finding({
      caseId: testCase.id,
      category: "missing-expected-results",
      severity: "high",
      detail: "One or more TestRail steps have no observable expected result.",
      evidenceIds: [testCase.id],
    }));
  }
  if (stepDiff.changed && Array.isArray(separatedSteps)) {
    fieldDiffs.push(fieldDiff({
      field: "custom_steps_separated",
      before: Array.isArray(separatedSteps) ? separatedSteps : null,
      after: stepDiff.after,
      rationale: "Preserve synchronized actions and mark only unsupported gaps for reviewer input.",
      citations: caseCitations,
    }));
  }

  if (
    hasContainedRequirements
    && requirementIds.length === 1
    && requirementIds[0] === rootRequirementId
  ) {
    findings.push(finding({
      caseId: testCase.id,
      category: "missing-requirement-mapping",
      severity: "medium",
      detail: "The case maps only to the parent Jira scope even though contained requirements exist.",
      evidenceIds: [testCase.id, rootRequirementId],
    }));
    const currentReferences = latestClaimValue(claims, "custom_jira_references");
    if (Array.isArray(currentReferences)) {
      fieldDiffs.push(fieldDiff({
        field: "custom_jira_references",
        before: currentReferences,
        after: [...currentReferences, REVIEW_REQUIREMENT],
        rationale: "A reviewer must add the specific contained requirement; existing references are preserved.",
        citations: caseCitations,
        confidence: "low",
      }));
    }
  }

  const duplicateCandidates = allManualTestContexts
    .filter((candidate) =>
      candidate.testCase.id !== testCase.id && candidate.conflictedClaimCount === 0)
    .map((candidate) => ({
      id: candidate.testCase.id,
      title: candidate.testCase.title,
      similarity: intentSimilarity(caseContext, candidate),
      evidence: candidate.testCase,
      citations: uniqueCitations(
        [candidate.testCase, ...candidate.claims].flatMap(provenanceEntries),
      ),
    }))
    .filter((candidate) => candidate.similarity >= duplicateThreshold)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 3);

  if (duplicateCandidates.length > 0) {
    findings.push(finding({
      caseId: testCase.id,
      category: "duplicate-intent",
      severity: "medium",
      detail: "Another synchronized TestRail case has strongly overlapping title and step intent.",
      evidenceIds: [testCase.id, ...duplicateCandidates.map(({ id }) => id)],
    }));
  }

  return {
    id: `testrail-improvement:${testCase.id}`,
    caseId: testCase.id,
    title: testCase.title,
    disposition: fieldDiffs.length > 0 ? "propose-edit" : "review-duplicate",
    requirementIds,
    findings,
    fieldDiffs,
    duplicateCandidates: duplicateCandidates.map(({ evidence: _evidence, ...candidate }) =>
      candidate),
    confidence: {
      level: findings.some(({ category }) => category === "missing-requirement-mapping")
        ? "low"
        : "medium",
      rationale: fieldDiffs.length > 0
        ? "The proposal is based on explicit synchronized field absence and uses reviewer placeholders for unsupported content."
        : "Duplicate intent is a similarity signal and requires human confirmation.",
    },
    citations: uniqueCitations([
      ...caseCitations,
      ...duplicateCandidates.flatMap(({ citations }) => citations),
    ]),
  };
}

function improveSeparatedSteps(value, plainSteps, customExpected) {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      changed: false,
      missingSteps: typeof plainSteps !== "string" || plainSteps.trim().length === 0,
      missingExpectedResults:
        typeof customExpected !== "string" || customExpected.trim().length === 0,
      after: null,
    };
  }

  let missingSteps = false;
  let missingExpectedResults = false;
  const after = value.map((step) => {
    const content = typeof step?.content === "string" ? step.content.trim() : "";
    const expected = typeof step?.expected === "string" ? step.expected.trim() : "";
    if (!content) missingSteps = true;
    if (!expected) missingExpectedResults = true;
    return {
      content: content || REVIEW_ACTION,
      expected: expected || REVIEW_EXPECTED,
    };
  });
  return {
    changed: missingSteps || missingExpectedResults,
    missingSteps,
    missingExpectedResults,
    after,
  };
}

function finding({ caseId, category, severity, detail, evidenceIds }) {
  return {
    id: `${caseId}:${category}`,
    category,
    severity,
    detail,
    evidenceIds,
  };
}

function fieldDiff({
  field,
  before,
  after,
  rationale,
  citations,
  confidence = "medium",
}) {
  return {
    field,
    before,
    after,
    rationale,
    confidence: {
      level: confidence,
      rationale:
        confidence === "low"
          ? "The gap is grounded, but the correct replacement requires reviewer selection."
          : "The current field value is directly supported by synchronized TestRail evidence.",
    },
    citations,
  };
}

function latestClaimValue(claims, attribute) {
  return claims.filter((claim) => claim.attribute === attribute).at(-1)?.value;
}

function intentSimilarity(left, right) {
  const leftTokens = tokenSet(caseIntent(left));
  const rightTokens = tokenSet(caseIntent(right));
  const union = new Set([...leftTokens, ...rightTokens]);
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token));
  if (union.size === 0) return 0;
  const normalizedLeftTitle = normalizeIntentTitle(left.testCase.title);
  const normalizedRightTitle = normalizeIntentTitle(right.testCase.title);
  if (normalizedLeftTitle === normalizedRightTitle) return 1;
  if (intersection.length < 2) return 0;
  const containment = intersection.length / Math.min(leftTokens.size, rightTokens.size);
  const jaccard = intersection.length / union.size;
  return Number(Math.max(containment, jaccard).toFixed(3));
}

function caseIntent({ testCase, claims }) {
  const preconditions = latestClaimValue(claims, "custom_preconds");
  const steps = latestClaimValue(claims, "custom_steps_separated");
  const plainSteps = latestClaimValue(claims, "custom_steps");
  return [
    testCase.title,
    typeof preconditions === "string" ? preconditions : "",
    typeof plainSteps === "string" ? plainSteps : "",
    ...(Array.isArray(steps)
      ? steps.flatMap((step) => [step?.content ?? "", step?.expected ?? ""])
      : []),
  ].join(" ");
}

function normalizeIntentTitle(value) {
  return [...tokenSet(value)].sort().join(" ");
}

function tokenSet(value) {
  const ignored = new Set(["and", "for", "from", "that", "the", "test", "then", "verify", "with"]);
  return new Set(
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !ignored.has(token)),
  );
}

function confidenceFor({ caseCount, conflictedCaseCount, sources }) {
  if (caseCount === 0) {
    return {
      level: "low",
      rationale: "Jira scope exists, but no explicitly linked TestRail case can be inspected.",
    };
  }
  if (sources.includes("jira") && sources.includes("testrail") && conflictedCaseCount === 0) {
    return {
      level: "medium",
      rationale: "Current Jira scope and TestRail case versions are cited; proposed content remains reviewer-owned.",
    };
  }
  return {
    level: "low",
    rationale: "One or more linked TestRail cases are conflicted or cross-source evidence is incomplete.",
  };
}

function provenanceEntries(value) {
  if (!value?.provenance) return [];
  return Array.isArray(value.provenance) ? value.provenance : [value.provenance];
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueById(values) {
  return values.filter((value, index) =>
    values.findIndex((candidate) => candidate.id === value.id) === index);
}

function uniqueCitations(values) {
  return values.filter((value, index) =>
    values.findIndex((candidate) =>
      candidate.source === value.source
      && candidate.sourceId === value.sourceId
      && candidate.sourceVersion === value.sourceVersion) === index);
}

function emptyEvidence() {
  return {
    sources: [],
    requirements: [],
    manualTests: [],
    relationships: [],
    citations: [],
  };
}
