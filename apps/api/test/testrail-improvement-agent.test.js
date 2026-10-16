import test from "node:test";
import assert from "node:assert/strict";
import { createTestRailImprovementAgent } from "../src/agents/testrail-improvement-agent.js";

const jiraProvenance = {
  source: "jira",
  sourceId: "STT-100",
  sourceVersion: "1",
  contentHash: "jira-hash",
  observedAt: "2026-09-14T00:00:00.000Z",
  normalizerId: "jira-normalizer",
  normalizerVersion: "1",
};
const testRailProvenance = {
  ...jiraProvenance,
  source: "testrail",
  sourceId: "42",
  contentHash: "testrail-hash",
  normalizerId: "testrail-normalizer",
};

test("returns not-found without fabricating a TestRail assessment", async () => {
  const agent = createTestRailImprovementAgent({
    knowledgeService: {
      async getTestRailImprovementContext() {
        return {
          trace: undefined,
          rootRequirementId: "requirement:STT-404",
          scopeRequirementIds: ["requirement:STT-404"],
          caseContexts: [],
          allManualTestContexts: [],
        };
      },
    },
    createRunId: () => "improvement-run-not-found",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-404" });

  assert.equal(result.status, "not-found");
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.evidence.citations, []);
});

test("assesses one exact TestRail case without requiring Jira", async () => {
  const testCase = {
    id: "manual-test:testrail:42",
    type: "manual-test",
    title: "Verify valid VIN",
    provenance: testRailProvenance,
  };
  const caseContext = {
    testCase,
    claims: [],
    relationships: [],
    requirementIds: [],
    conflictedClaimCount: 0,
  };
  const agent = createTestRailImprovementAgent({
    knowledgeService: {
      async getTestRailCaseImprovementContext({ caseId }) {
        assert.equal(caseId, "42");
        return {
          rootRequirementId: null,
          scopeRequirementIds: [],
          trace: {
            requirements: [],
            relationships: [],
            context: { truncated: false },
          },
          caseContexts: [caseContext],
          allManualTestContexts: [caseContext],
        };
      },
    },
    createRunId: () => "case-improvement-run",
  });

  const result = await agent.execute({
    productId: "fl-titling",
    caseId: "C0042",
  });

  assert.equal(result.caseId, "42");
  assert.equal(result.workItemId, "C42");
  assert.equal(result.status, "ready-for-review");
  assert.deepEqual(
    result.proposals[0].findings.map((finding) => finding.category),
    [
      "missing-preconditions",
      "missing-steps",
      "missing-expected-results",
    ],
  );
});

test("proposes field-level TestRail improvements without inventing product actions", async () => {
  const requirement = {
    id: "requirement:STT-100",
    type: "requirement",
    title: "Submit a title application",
    provenance: jiraProvenance,
  };
  const testCase = {
    id: "manual-test:testrail:42",
    type: "manual-test",
    title: "Verify valid VIN title application",
    provenance: testRailProvenance,
  };
  const relationship = {
    id: "link:42:STT-100",
    fromEntityId: testCase.id,
    toEntityId: requirement.id,
    type: "verifies",
    provenance: testRailProvenance,
  };
  const agent = createTestRailImprovementAgent({
    knowledgeService: {
      async getTestRailImprovementContext() {
        return {
          rootRequirementId: requirement.id,
          scopeRequirementIds: [requirement.id],
          trace: {
            requirements: [requirement],
            relationships: [relationship],
            context: { truncated: false },
          },
          caseContexts: [{
            testCase,
            claims: [{
              attribute: "custom_steps_separated",
              value: [{ content: "Enter the valid VIN.", expected: "" }],
              provenance: testRailProvenance,
            }],
            relationships: [relationship],
            requirementIds: [requirement.id],
            conflictedClaimCount: 0,
          }],
          allManualTestContexts: [{
            testCase,
            claims: [],
            relationships: [relationship],
            requirementIds: [requirement.id],
            conflictedClaimCount: 0,
          }],
        };
      },
    },
    now: () => "2026-09-14T01:00:00.000Z",
    createRunId: () => "improvement-run-1",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.equal(result.status, "ready-for-review");
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(
    result.proposals[0].findings.map(({ category }) => category),
    ["missing-preconditions", "missing-expected-results"],
  );
  assert.deepEqual(
    result.proposals[0].fieldDiffs.map(({ field }) => field),
    ["custom_preconds", "custom_steps_separated"],
  );
  assert.equal(
    result.proposals[0].fieldDiffs[1].after[0].content,
    "Enter the valid VIN.",
  );
  assert.match(
    result.proposals[0].fieldDiffs[1].after[0].expected,
    /Reviewer input required/,
  );
  assert.ok(result.limitations.some((item) => item.includes("does not invent product actions")));
  assert.deepEqual(result.evidence.sources.sort(), ["jira", "testrail"]);
});

test("flags broad requirement mappings and duplicate intent for human review", async () => {
  const root = {
    id: "requirement:STT-100",
    title: "Title application epic",
    provenance: jiraProvenance,
  };
  const child = {
    id: "requirement:STT-101",
    title: "Validate VIN",
    provenance: { ...jiraProvenance, sourceId: "STT-101" },
  };
  const completeClaims = [
    {
      attribute: "custom_jira_references",
      value: ["STT-100"],
      provenance: testRailProvenance,
    },
    {
      attribute: "custom_preconds",
      value: "A title application exists.",
      provenance: testRailProvenance,
    },
    {
      attribute: "custom_steps_separated",
      value: [{
        content: "Review the valid VIN title application.",
        expected: "The title application details are displayed.",
      }],
      provenance: testRailProvenance,
    },
  ];
  const linkedCase = {
    id: "manual-test:testrail:42",
    title: "Verify valid VIN title application",
    provenance: testRailProvenance,
  };
  const duplicateCase = {
    id: "manual-test:testrail:43",
    title: "Validate valid VIN title application",
    provenance: { ...testRailProvenance, sourceId: "43" },
  };
  const agent = createTestRailImprovementAgent({
    knowledgeService: {
      async getTestRailImprovementContext() {
        return {
          rootRequirementId: root.id,
          scopeRequirementIds: [root.id, child.id],
          trace: {
            requirements: [root, child],
            relationships: [],
            context: { truncated: false },
          },
          caseContexts: [{
            testCase: linkedCase,
            claims: completeClaims,
            relationships: [],
            requirementIds: [root.id],
            conflictedClaimCount: 0,
          }],
          allManualTestContexts: [
            {
              testCase: linkedCase,
              claims: completeClaims,
              relationships: [],
              requirementIds: [root.id],
              conflictedClaimCount: 0,
            },
            {
              testCase: duplicateCase,
              claims: completeClaims.map((claim) => ({
                ...claim,
                provenance: duplicateCase.provenance,
              })),
              relationships: [],
              requirementIds: [],
              conflictedClaimCount: 0,
            },
          ],
        };
      },
    },
    createRunId: () => "improvement-run-2",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.ok(result.proposals[0].findings.some(
    ({ category }) => category === "missing-requirement-mapping",
  ));
  assert.equal(result.proposals[0].fieldDiffs[0].field, "custom_jira_references");
  assert.deepEqual(result.proposals[0].fieldDiffs[0].before, ["STT-100"]);
  assert.match(result.proposals[0].fieldDiffs[0].after[1], /Reviewer selection required/);
  assert.equal(result.proposals[0].duplicateCandidates[0].id, duplicateCase.id);
  assert.ok(result.evidence.citations.some(({ sourceId }) => sourceId === "43"));
});

test("returns insufficient context when no TestRail case is linked", async () => {
  const agent = createTestRailImprovementAgent({
    knowledgeService: {
      async getTestRailImprovementContext() {
        return {
          rootRequirementId: "requirement:STT-100",
          scopeRequirementIds: ["requirement:STT-100"],
          trace: {
            requirements: [{
              id: "requirement:STT-100",
              title: "Title application",
              provenance: jiraProvenance,
            }],
            relationships: [],
            context: { truncated: false },
          },
          caseContexts: [],
          allManualTestContexts: [],
        };
      },
    },
    createRunId: () => "improvement-run-3",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.equal(result.status, "insufficient-context");
  assert.deepEqual(result.proposals, []);
  assert.ok(result.limitations.some((item) => item.includes("explicitly linked")));
});

test("preserves plain-text TestRail steps instead of proposing a destructive replacement", async () => {
  const requirement = {
    id: "requirement:STT-100",
    title: "Title application",
    provenance: jiraProvenance,
  };
  const testCase = {
    id: "manual-test:testrail:42",
    title: "Submit a valid VIN",
    provenance: testRailProvenance,
  };
  const agent = createTestRailImprovementAgent({
    knowledgeService: {
      async getTestRailImprovementContext() {
        return {
          rootRequirementId: requirement.id,
          scopeRequirementIds: [requirement.id],
          trace: {
            requirements: [requirement],
            relationships: [],
            context: { truncated: false },
          },
          caseContexts: [{
            testCase,
            claims: [
              { attribute: "custom_preconds", value: "A user is signed in.", provenance: testRailProvenance },
              { attribute: "custom_steps", value: "1. Enter VIN\n2. Submit", provenance: testRailProvenance },
              { attribute: "custom_expected", value: "The VIN is accepted.", provenance: testRailProvenance },
            ],
            relationships: [],
            requirementIds: [requirement.id],
            conflictedClaimCount: 0,
          }],
          allManualTestContexts: [],
        };
      },
    },
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.deepEqual(result.proposals, []);
});
