import { randomUUID } from "node:crypto";
import { parseStructuredJiraDescription } from "../jira-description.js";

export const testDesignerAgentManifest = Object.freeze({
  id: "agent.test-designer",
  version: "0.1.0",
  capabilities: ["quality-context.read", "test-case.propose", "duplicates.detect"],
  mode: "proposal-only",
});

export function createTestDesignerAgent({
  knowledgeService,
  now = () => new Date().toISOString(),
  createRunId = () => randomUUID(),
  maxCases = 12,
} = {}) {
  if (!knowledgeService) throw new TypeError("knowledgeService is required");

  return {
    manifest: testDesignerAgentManifest,

    async execute({ productId, workItemId, unifiedContext, suiteId, sectionId }) {
      const context = await knowledgeService.getTestDesignContext({ productId, workItemId });
      const run = baseRun({ productId, workItemId, now, createRunId });
      if (!context.trace) {
        return {
          ...run,
          status: "not-found",
          confidence: {
            level: "none",
            rationale: "The Jira work item is not present in canonical knowledge.",
          },
          summary: `No grounded test design context was found for ${workItemId}.`,
          proposals: [],
          evidence: emptyEvidence(),
          limitations: ["No canonical Jira requirement was found."],
        };
      }

      const allExistingManualTests = context.existingManualTests ?? [];
      const allManualTestContexts = context.existingManualTestContexts
        ?? allExistingManualTests.map((testCase) => ({ testCase, claims: [] }));
      const existingManualTestContexts = suiteId && sectionId
        ? allManualTestContexts.filter((caseContext) =>
            textClaim(caseContext.claims, "section_id") === String(sectionId))
        : allManualTestContexts;
      const existingManualTests = existingManualTestContexts.map(({ testCase }) => testCase);
      const criteria = uniqueClaims(
        context.requirementClaims.filter(({ claim }) =>
          claim.attribute === "acceptanceCriteria"),
      );
      const descriptions = uniqueClaims(
        context.requirementClaims.filter(({ claim }) =>
          claim.attribute === "description"),
      );
      const designInputs = selectDesignInputs({ criteria, descriptions });
      const qaBrainDocuments = mergeQaBrainDocuments(
        context.qaBrainDocuments ?? [],
        unifiedContext?.documentation ?? [],
      );
      const proposals = designInputs.slice(0, maxCases).map(({ requirement, claim }, index) =>
        proposalFromClaim({
          requirement,
          claim,
          index,
          existingManualTestContexts,
          qaBrainDocuments,
          rootRequirementId: context.rootRequirementId,
          sectionScoped: Boolean(suiteId && sectionId),
        }));
      const citations = uniqueCitations([
        ...context.requirementClaims.map(({ claim }) => claim).flatMap(provenanceEntries),
        ...existingManualTests.flatMap(provenanceEntries),
        ...qaBrainDocuments.flatMap((item) => item.citations),
      ]);
      const limitations = [];
      if (designInputs.some(({ claim }) => claim.attribute === "description")) {
        limitations.push(
          "At least one requirement has no explicit acceptance criteria; its draft is based on description evidence only.",
        );
      }
      if (existingManualTests.length === 0) {
        limitations.push(
          "No synchronized TestRail cases are available for a complete duplicate analysis.",
        );
      }
      if (qaBrainDocuments.length === 0) {
        limitations.push(
          "No matching curated QA brain guidance was found for this requirement.",
        );
      }
      if (designInputs.length > maxCases) {
        limitations.push(`Only the first ${maxCases} evidence items were converted into drafts.`);
      }
      if (context.excludedConflictedClaimCount > 0) {
        limitations.push(
          `${context.excludedConflictedClaimCount} Jira claim(s) with unresolved knowledge conflicts were excluded.`,
        );
      }
      if (context.skippedNonTextClaimCount > 0) {
        limitations.push(
          `${context.skippedNonTextClaimCount} non-text Jira claim(s) could not be converted into test drafts.`,
        );
      }
      if (proposals.length === 0) {
        limitations.push(
          "No approved or pending Jira description/acceptance-criteria claims are available.",
        );
      }
      const duplicateCount = proposals.filter((proposal) =>
        proposal.duplicateCandidates.length > 0).length;

      return {
        ...run,
        status: proposals.length === 0 ? "insufficient-context" : "ready-for-review",
        confidence: {
          level:
            criteria.length > 0 && existingManualTests.length > 0
              ? "high"
              : existingManualTests.length > 0 && qaBrainDocuments.length > 0
                ? "high"
              : criteria.length > 0
                ? "medium"
                : existingManualTests.length > 0
                  ? "medium"
                : proposals.length > 0
                  ? "low"
                  : "none",
          rationale: confidenceRationale({
            criteriaCount: criteria.length,
            existingManualCount: existingManualTests.length,
            qaBrainCount: qaBrainDocuments.length,
          }),
        },
        summary: `${proposals.length} manual test draft(s) proposed for ${workItemId}; `
          + `${duplicateCount} draft(s) have possible TestRail duplicates.`,
        proposals,
        evidence: {
          sources: unique([
            ...context.trace.requirements.flatMap(provenanceEntries).map((item) => item.source),
            ...existingManualTests.flatMap(provenanceEntries).map((item) => item.source),
            ...qaBrainDocuments.flatMap((item) => item.citations).map((item) => item.source),
          ]),
          requirements: context.trace.requirements,
          existingManualTests,
          qaBrainDocuments: qaBrainDocuments.map((item) => ({
            id: item.id,
            title: item.title,
            path: item.path,
            score: item.score,
          })),
          citations,
        },
        limitations,
      };
    },
  };
}

function baseRun({ productId, workItemId, now, createRunId }) {
  return {
    runId: createRunId(),
    agent: testDesignerAgentManifest,
    productId,
    workItemId,
    generatedAt: now(),
  };
}

function proposalFromClaim({
  requirement,
  claim,
  index,
  existingManualTestContexts,
  qaBrainDocuments,
  rootRequirementId,
  sectionScoped = false,
}) {
  const structuredDescription = claim.attribute === "description"
    ? parseStructuredJiraDescription(claim.value)
    : null;
  const expectedResult = structuredDescription?.acceptanceCriteria
    || structuredDescription?.issue
    || claim.value.trim();
  const title = conciseTitle(
    structuredDescription?.issue || expectedResult,
    requirement.title,
  );
  const reproSteps = structuredDescription?.reproSteps ?? [];
  const qaOracleChecks = extractQaOracleChecks(qaBrainDocuments, [
    requirement.id,
    requirement.title,
    expectedResult,
  ].join(" "));
  const focusText = [
    title,
    requirement.title,
    expectedResult,
    ...qaBrainDocuments.map((item) => `${item.title} ${item.content}`),
  ].join(" ");
  const candidatePool = existingManualTestContexts
    .map((caseContext) => ({
      id: caseContext.testCase.id,
      title: caseContext.testCase.title,
      similarity: caseContextSimilarity(focusText, caseContext),
      preconditions: cleanReusableStepText(
        textClaim(caseContext.claims, "custom_preconds"),
      ),
      steps: separatedSteps(caseContext.claims),
      automationStatus: textClaim(caseContext.claims, "custom_automation_status"),
      citations: uniqueCitations([
        ...provenanceEntries(caseContext.testCase),
        ...caseContext.claims.flatMap(provenanceEntries),
      ]),
    }))
    .filter((candidate) =>
      candidate.steps.length > 0
        ? candidate.similarity >= (sectionScoped ? 0.1 : 0.18)
        : candidate.similarity >= 0.6)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, sectionScoped ? 12 : 3);
  const referenceCases = candidatePool.slice(0, 3);
  const duplicateCandidates = candidatePool
    .filter((candidate) => candidate.similarity >= 0.8)
    .slice(0, 3);
  const reusableCase = candidatePool
    .filter((candidate) => candidate.steps.length > 0)
    .sort((left, right) =>
      completeExpectedRatio(right.steps) - completeExpectedRatio(left.steps)
      || Number(right.automationStatus === "4") - Number(left.automationStatus === "4")
      || right.similarity - left.similarity)[0];
  const baselineSteps = reusableCase?.steps.length
    ? reusableCase.steps.map((step, stepIndex) => ({
        order: stepIndex + 1,
        action: step.action,
        expectedResult: step.expectedResult,
      }))
    : reproSteps.map((action, stepIndex) => ({
        order: stepIndex + 1,
        action,
        expectedResult: stepIndex === reproSteps.length - 1 ? expectedResult : "",
      }));
  const groundedSteps = appendOracleChecks(baselineSteps, qaOracleChecks);
  return {
    id: `test-draft:${requirement.id}:${index + 1}`,
    disposition: duplicateCandidates.length > 0 ? "review-existing" : "propose-new",
    title,
    objective: `Verify the behavior required by ${requirement.id}`
      + (requirement.id === rootRequirementId ? "." : `, contained by ${rootRequirementId}.`),
    preconditions: reusableCase?.preconditions
      ? [reusableCase.preconditions]
      : ["QA reviewer must confirm the applicable environment, user permissions, and test data."],
    steps: groundedSteps.length > 0
      ? groundedSteps
      : [
          {
            order: 1,
            action: `Reviewer placeholder: define setup and test data for ${requirement.id}.`,
            expectedResult: "The reviewer confirms the setup is grounded in the product workflow.",
          },
          {
            order: 2,
            action: "Reviewer placeholder: replace with verified product actions before approval.",
            expectedResult,
          },
        ],
    expectedResult,
    requirementIds: [requirement.id],
    duplicateCandidates,
    referenceCases,
    automationSuitability: {
      status: groundedSteps.length > 0 ? "candidate" : "needs-details",
      rationale: groundedSteps.length > 0
        ? "The draft has repeatable, evidence-backed actions and expected results that can be reviewed for automation."
        : "The workflow or expected results need concrete TestRail or Jira evidence before automation.",
      blockers: [
        ...(groundedSteps.length > 0 ? [] : ["Concrete executable steps are missing."]),
        ...(groundedSteps.some((step) => !step.expectedResult)
          ? ["One or more steps still need a concrete expected result before publication."]
          : []),
        "ReportPortal execution evidence requires a stable codeRef or uniqueId; a TestRail case ID alone is not treated as a match.",
      ],
      reusedCaseId: reusableCase?.id ?? null,
    },
    qaBrainGuidance: {
      documents: qaBrainDocuments.map((item) => ({
        id: item.id,
        title: item.title,
        path: item.path,
        score: item.score,
      })),
      oracleChecks: qaOracleChecks,
    },
    confidence: {
      level:
        claim.attribute === "acceptanceCriteria"
        || (reusableCase && qaOracleChecks.length > 0)
          ? "high"
          : "low",
      rationale:
        claim.attribute === "acceptanceCriteria"
          ? "The draft is directly derived from an explicit Jira acceptance criterion."
          : reusableCase && qaOracleChecks.length > 0
            ? `The draft combines grounded steps from ${reusableCase.id} with requirement-specific QA oracle checks.`
          : reusableCase
            ? `The draft reuses grounded step structure from similar TestRail case ${reusableCase.id}; QA must verify applicability.`
          : reproSteps.length > 0
            ? "The Jira description contains explicit repro steps and expected behavior; QA review is still required."
          : "The draft is derived from a Jira description because no acceptance criterion is available.",
    },
    citations: uniqueCitations([
      ...provenanceEntries(claim),
      ...(reusableCase?.citations ?? []),
      ...qaBrainDocuments.flatMap((item) => item.citations),
    ]),
  };
}

function textClaim(claims, attribute) {
  const value = claims.find((claim) => claim.attribute === attribute)?.value;
  return typeof value === "string" ? value.trim() : "";
}

function separatedSteps(claims) {
  const value = claims.find((claim) => claim.attribute === "custom_steps_separated")?.value;
  if (!Array.isArray(value)) return [];
  return value.flatMap((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return [];
    const action = typeof step.content === "string" ? cleanReusableStepText(step.content) : "";
    const expectedResult = typeof step.expected === "string"
      ? cleanReusableStepText(step.expected)
      : "";
    return action ? [{ action, expectedResult }] : [];
  });
}

function cleanReusableStepText(value) {
  return String(value)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function completeExpectedRatio(steps) {
  if (steps.length === 0) return 0;
  return steps.filter((step) => step.expectedResult.length > 0).length / steps.length;
}

function conciseTitle(value, fallback) {
  const normalized = value.replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  const candidate = normalized.length > 0 ? normalized : fallback;
  const missingFields = candidate.match(
    /^when (.+?),\s+(?:it(?:'s| is)) missing the following fields?\s+(.+)$/i,
  );
  const behavior = missingFields
    ? `${missingFields[2]} are available when ${missingFields[1]}`
    : candidate;
  return `Verify ${behavior.length > 100 ? `${behavior.slice(0, 97)}...` : behavior}`;
}

function titleSimilarity(left, right) {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  const union = new Set([...leftTokens, ...rightTokens]);
  const shorterSize = Math.min(leftTokens.size, rightTokens.size);
  if (union.size === 0 || shorterSize === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token));
  const jaccard = intersection.length / union.size;
  const containment = intersection.length / shorterSize;
  return Number(Math.max(jaccard, containment).toFixed(3));
}

function caseContextSimilarity(focusText, caseContext) {
  const caseText = [
    caseContext.testCase.title,
    ...caseContext.claims.flatMap((claim) => flattenText(claim.value)),
  ].join(" ");
  return titleSimilarity(focusText, caseText);
}

function flattenText(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenText);
  return [];
}

function tokenSet(value) {
  return new Set(
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) => token.replace(/(?:ing|ed|es|s)$/i, ""))
      .filter((token) => token.length > 2 && !["verify", "test", "case", "should"].includes(token)),
  );
}

function mergeQaBrainDocuments(contextDocuments, unifiedDocuments) {
  const normalized = [
    ...contextDocuments.map((item) => ({
      id: item.document?.id,
      title: item.document?.title,
      path: item.document?.metadata?.path
        ?? textClaim(item.claims ?? [], "path"),
      content: textClaim(item.claims ?? [], "content"),
      score: item.score ?? 0,
      citations: uniqueCitations([
        ...provenanceEntries(item.document),
        ...(item.claims ?? []).flatMap(provenanceEntries),
      ]),
    })),
    ...unifiedDocuments
      .filter((item) => item?.source === "qa-brain")
      .map((item) => ({
        id: item.id,
        title: item.title,
        path: item.claims?.find((claim) => claim.attribute === "path")?.value ?? "",
        content: item.claims?.find((claim) => claim.attribute === "content")?.value ?? "",
        score: 1,
        citations: [],
      })),
  ].filter((item) =>
    typeof item.id === "string"
    && typeof item.title === "string"
    && typeof item.content === "string");
  return normalized.filter((item, index) =>
    normalized.findIndex((candidate) => candidate.id === item.id) === index);
}

function extractQaOracleChecks(documents, focusText) {
  const focusTokens = tokenSet(focusText);
  const issueKey = String(focusText).match(/\b[A-Z][A-Z0-9]+-\d+\b/i)?.[0];
  const exactIssueDocuments = issueKey
    ? documents.filter((document) =>
        document.title.toUpperCase().includes(issueKey.toUpperCase()))
    : [];
  const scopedDocuments = exactIssueDocuments.length > 0 ? exactIssueDocuments : documents;
  const genericTokens = new Set([
    "available", "behavior", "create", "creating", "deal", "expected", "field",
    "required", "requirement", "test", "transaction", "validate", "verify",
  ]);
  const distinctiveTokens = new Set(
    [...focusTokens].filter((token) =>
      token.length >= 4
      && !/\d/.test(token)
      && !genericTokens.has(token)),
  );
  return scopedDocuments
    .flatMap((document) => markdownBlocks(document.content).map((block) => ({
      block,
      document,
      score: overlapScore(focusTokens, tokenSet(block)),
      documentDistinctiveMatches: intersectionSize(
        tokenSet(document.title),
        distinctiveTokens,
      ),
      blockDistinctiveMatches: intersectionSize(tokenSet(block), distinctiveTokens),
    })))
    .filter(({ block, score, documentDistinctiveMatches, blockDistinctiveMatches }) =>
      score >= 0.12
      && (documentDistinctiveMatches >= 1 || blockDistinctiveMatches >= 2)
      && block.length <= 700
      && !/\|\s*[-:]{3,}\s*\|/.test(block)
      && !/(?:^|\s)\|\s*(?:STT-\d+|Ticket|Status|Defect)\s*\|/i.test(block)
      && !/(?:playwright|page\.evaluate|locator|mcp browser|select technique)/i.test(block)
      && (
        /(?:pass oracle|required|must|shown|appear|absent|hide|disable|enable|validation|either-or|not both|→)/i
          .test(block)
      ))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(({ block, document }, index) => oracleCheckFromBlock(block, document, index));
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function markdownBlocks(content) {
  const blocks = [];
  let current = "";
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line)) {
      if (current) blocks.push(current);
      current = "";
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (current) blocks.push(current);
      current = line;
    } else if (/^\d+[.)]\s+/.test(line)) {
      if (current) blocks.push(current);
      current = line;
    } else if (/^```/.test(line) || /^\|/.test(line)) {
      if (current) blocks.push(current);
      current = "";
    } else {
      current = current ? `${current} ${line}` : line;
    }
  }
  if (current) blocks.push(current);
  return blocks.map((block) =>
    block
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .trim());
}

function oracleCheckFromBlock(block, document, index) {
  const arrowIndex = block.indexOf("→");
  const colonIndex = block.indexOf(":");
  const label = colonIndex > 0 && colonIndex < 80
    ? block.slice(0, colonIndex).replace(/\([^)]*\)/g, "").trim()
    : "";
  if (arrowIndex > 0) {
    return {
      id: `qa-oracle:${document.id}:${index + 1}`,
      action: conciseStep(block.slice(0, arrowIndex)),
      expectedResult: block.slice(arrowIndex + 1).trim(),
      sourceDocumentId: document.id,
    };
  }
  return {
    id: `qa-oracle:${document.id}:${index + 1}`,
    action: label ? `Validate ${label}` : `Validate ${conciseStep(block)}`,
    expectedResult: label ? block.slice(colonIndex + 1).trim() : block,
    sourceDocumentId: document.id,
  };
}

function appendOracleChecks(steps, checks) {
  const result = steps.map((step, index) => ({ ...step, order: index + 1 }));
  const additions = [];
  for (const check of checks) {
    const normalized = `${check.action} ${check.expectedResult}`.toLowerCase();
    const duplicate = result.some((step) =>
      titleSimilarity(normalized, `${step.action} ${step.expectedResult}`) >= 0.8);
    if (!duplicate) {
      additions.push({
        order: 0,
        action: check.action,
        expectedResult: check.expectedResult,
      });
    }
  }
  if (additions.length === 0) return result;
  const additionText = additions
    .map((addition) => `${addition.action} ${addition.expectedResult}`)
    .join(" ")
    .toLowerCase();
  const explicitSection = [
    "purchase vehicle",
    "general section",
    "insurance section",
    "plate section",
  ].find((section) => additionText.includes(section));
  const explicitSectionIndex = explicitSection
    ? result.findIndex((step) =>
        `${step.action} ${step.expectedResult}`.toLowerCase().includes(explicitSection))
    : -1;
  const anchor = additions
    .flatMap((addition) => result.map((step, index) => ({
      index,
      score: titleSimilarity(
        `${addition.action} ${addition.expectedResult}`,
        `${step.action} ${step.expectedResult}`,
      ),
    })))
    .sort((left, right) => right.score - left.score)[0];
  const insertionIndex = explicitSectionIndex >= 0
    ? explicitSectionIndex
    : anchor?.score >= 0.1 ? anchor.index : result.length;
  result.splice(insertionIndex, 0, ...additions);
  return result.map((step, index) => ({ ...step, order: index + 1 }));
}

function conciseStep(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= 180 ? text : `${text.slice(0, 177)}...`;
}

function overlapScore(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / Math.min(left.size, right.size);
}

function confidenceRationale({ criteriaCount, existingManualCount, qaBrainCount }) {
  if (criteriaCount > 0 && existingManualCount > 0) {
    return "Explicit acceptance criteria and existing TestRail cases were available.";
  }
  if (existingManualCount > 0 && qaBrainCount > 0) {
    return "Existing TestRail workflows and curated QA product oracles were both available.";
  }
  if (criteriaCount > 0) {
    return "Explicit acceptance criteria were available, but TestRail duplicate coverage is incomplete.";
  }
  if (existingManualCount > 0) {
    return "Existing TestRail cases were available, but Jira acceptance criteria are missing.";
  }
  return "Neither explicit acceptance criteria nor synchronized TestRail cases are complete.";
}

function uniqueClaims(values) {
  return values.filter((value, index) =>
    values.findIndex((candidate) =>
      candidate.requirement.id === value.requirement.id
      && candidate.claim.attribute === value.claim.attribute
      && JSON.stringify(candidate.claim.value) === JSON.stringify(value.claim.value)) === index);
}

function selectDesignInputs({ criteria, descriptions }) {
  const requirementIds = unique([
    ...criteria.map(({ requirement }) => requirement.id),
    ...descriptions.map(({ requirement }) => requirement.id),
  ]);
  return requirementIds.flatMap((requirementId) => {
    const requirementCriteria = criteria.filter(({ requirement }) =>
      requirement.id === requirementId);
    if (requirementCriteria.length > 0) return requirementCriteria;
    return descriptions.filter(({ requirement }) =>
      requirement.id === requirementId).slice(0, 1);
  });
}

function provenanceEntries(value) {
  if (!value?.provenance) return [];
  return Array.isArray(value.provenance) ? value.provenance : [value.provenance];
}

function unique(values) {
  return [...new Set(values)];
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
    existingManualTests: [],
    citations: [],
  };
}
