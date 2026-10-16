import test from "node:test";
import assert from "node:assert/strict";
import { createTestDesignerAgent } from "../src/agents/test-designer-agent.js";

const jiraProvenance = {
  source: "jira",
  sourceId: "STT-100",
  sourceVersion: "1",
  contentHash: "jira-hash",
  observedAt: "2026-09-14T00:00:00.000Z",
  normalizerId: "jira-normalizer",
  normalizerVersion: "1",
};

test("creates reviewable drafts from explicit acceptance criteria", async () => {
  const agent = createTestDesignerAgent({
    knowledgeService: {
      async getTestDesignContext() {
        const requirement = {
          id: "requirement:STT-100",
          type: "requirement",
          title: "Submit a title application",
          provenance: jiraProvenance,
        };
        return {
          rootRequirementId: requirement.id,
          trace: {
            requirements: [requirement],
            tests: [],
          },
          existingManualTests: [{
            id: "manual-test:testrail:84",
            type: "manual-test",
            title: "Verify a linked title workflow",
            provenance: { ...jiraProvenance, source: "testrail", sourceId: "84" },
          }],
          excludedConflictedClaimCount: 0,
          skippedNonTextClaimCount: 0,
          requirementClaims: [{
            requirement,
            claim: {
              attribute: "acceptanceCriteria",
              value: "The application is accepted when the VIN is valid.",
              provenance: jiraProvenance,
            },
          }],
        };
      },
    },
    now: () => "2026-09-14T01:00:00.000Z",
    createRunId: () => "test-design-run-1",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.equal(result.status, "ready-for-review");
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].disposition, "propose-new");
  assert.deepEqual(result.proposals[0].duplicateCandidates, []);
  assert.equal(
    result.proposals[0].expectedResult,
    "The application is accepted when the VIN is valid.",
  );
  assert.equal(result.proposals[0].citations[0].sourceId, "STT-100");
  assert.match(result.confidence.rationale, /existing TestRail cases were available/i);
});

test("flags likely duplicates instead of proposing blind TestRail creation", async () => {
  const agent = createTestDesignerAgent({
    knowledgeService: {
      async getTestDesignContext() {
        const requirement = {
          id: "requirement:STT-100",
          title: "Submit a title application",
          provenance: jiraProvenance,
        };
        return {
          rootRequirementId: requirement.id,
          trace: {
            requirements: [requirement],
            tests: [],
          },
          existingManualTests: [{
              id: "manual-test:testrail:42",
              type: "manual-test",
              title: "Submit application with valid VIN",
              provenance: { ...jiraProvenance, source: "testrail", sourceId: "42" },
            }],
          existingManualTestContexts: [{
            testCase: {
              id: "manual-test:testrail:42",
              type: "manual-test",
              title: "Submit application with valid VIN",
              provenance: { ...jiraProvenance, source: "testrail", sourceId: "42" },
            },
            claims: [
              {
                attribute: "custom_preconds",
                value: "An eligible title application exists.",
                provenance: { ...jiraProvenance, source: "testrail", sourceId: "42" },
              },
              {
                attribute: "custom_steps_separated",
                value: [{
                  content: "Submit a valid VIN.",
                  expected: "The application is accepted.",
                }],
                provenance: { ...jiraProvenance, source: "testrail", sourceId: "42" },
              },
            ],
          }],
          excludedConflictedClaimCount: 0,
          skippedNonTextClaimCount: 0,
          requirementClaims: [{
            requirement,
            claim: {
              attribute: "acceptanceCriteria",
              value: "Application is accepted when VIN is valid",
              provenance: jiraProvenance,
            },
          }],
        };
      },
    },
    createRunId: () => "test-design-run-2",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.equal(result.proposals[0].disposition, "review-existing");
  assert.equal(result.proposals[0].duplicateCandidates[0].id, "manual-test:testrail:42");
  assert.equal(result.proposals[0].preconditions[0], "An eligible title application exists.");
  assert.equal(result.proposals[0].steps[0].action, "Submit a valid VIN.");
  assert.equal(result.proposals[0].automationSuitability.reusedCaseId, "manual-test:testrail:42");
});

test("turns Jira issue, acceptance criteria, and repro steps into a readable draft", async () => {
  const agent = createTestDesignerAgent({
    knowledgeService: {
      async getTestDesignContext() {
        const requirement = {
          id: "requirement:STT-4656",
          title: "Missing motorcycle fields",
          provenance: { ...jiraProvenance, sourceId: "STT-4656" },
        };
        return {
          rootRequirementId: requirement.id,
          trace: { requirements: [requirement], tests: [] },
          existingManualTests: [],
          excludedConflictedClaimCount: 0,
          skippedNonTextClaimCount: 0,
          requirementClaims: [{
            requirement,
            claim: {
              attribute: "description",
              value: [
                "*Issue*",
                "When creating a transaction for a motorcycle, it's missing the following fields Brake Horsepower and Cubic Centimeter.",
                "*Acceptance Criteria*",
                "Both fields are shown when Motorcycle is selected.",
                "*Repro Steps*",
                "1- Login on FL new UI",
                "2- Go to Create new deal",
                "3- Select vehicle type Motorcycle",
                "4- Verify both motorcycle fields",
              ].join("\n"),
              provenance: { ...jiraProvenance, sourceId: "STT-4656" },
            },
          }],
        };
      },
    },
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-4656" });
  const proposal = result.proposals[0];

  assert.equal(
    proposal.title,
    "Verify Brake Horsepower and Cubic Centimeter are available when creating a transaction for a motorcycle",
  );
  assert.deepEqual(
    proposal.steps.map((step) => step.action),
    [
      "Login on FL new UI",
      "Go to Create new deal",
      "Select vehicle type Motorcycle",
      "Verify both motorcycle fields",
    ],
  );
  assert.equal(
    proposal.steps.at(-1).expectedResult,
    "Both fields are shown when Motorcycle is selected.",
  );
});

test("uses each contained requirement's own grounded claims without importing parent claims", async () => {
  const agent = createTestDesignerAgent({
    knowledgeService: {
      async getTestDesignContext() {
        const epic = {
          id: "requirement:STT-100",
          title: "Modernization epic",
          provenance: jiraProvenance,
        };
        const child = {
          id: "requirement:STT-101",
          title: "Validate VIN",
          provenance: { ...jiraProvenance, sourceId: "STT-101" },
        };
        return {
          rootRequirementId: epic.id,
          trace: { requirements: [epic, child], tests: [] },
          existingManualTests: [],
          excludedConflictedClaimCount: 0,
          skippedNonTextClaimCount: 0,
          requirementClaims: [{
            requirement: child,
            claim: {
              attribute: "acceptanceCriteria",
              value: "A valid VIN is accepted.",
              provenance: child.provenance,
            },
          }],
        };
      },
    },
    createRunId: () => "test-design-run-3",
  });

  test("uses QA brain oracle guidance and a name-matched TestRail workflow before Jira repro steps", async () => {
    const testRailProvenance = {
      ...jiraProvenance,
      source: "testrail",
      sourceId: "7623169",
    };
    const qaBrainProvenance = {
      ...jiraProvenance,
      source: "qa-brain",
      sourceId: "skills/features/create-deal.md#L334-L346",
    };
    const agent = createTestDesignerAgent({
      knowledgeService: {
        async getTestDesignContext() {
          const requirement = {
            id: "requirement:STT-4656",
            title: "Create deal motorcycle power fields",
            provenance: jiraProvenance,
          };
          const testCase = {
            id: "manual-test:testrail:7623169",
            type: "manual-test",
            title: "Create Title and Registration Finance Deal",
            provenance: testRailProvenance,
          };
          return {
            rootRequirementId: requirement.id,
            trace: { requirements: [requirement], tests: [] },
            existingManualTests: [testCase],
            existingManualTestContexts: [{
              testCase,
              claims: [{
                attribute: "custom_steps_separated",
                value: [{
                  content: "Select Create Deal.",
                  expected: "The Start a Deal window opens.",
                }, {
                  content: "Complete the Purchase Vehicle section.",
                  expected: "The Purchase Vehicle section turns green.",
                }, {
                  content: "Finalize the deal.",
                  expected: "The deal is complete.",
                }],
                provenance: testRailProvenance,
              }],
            }],
            qaBrainDocuments: [{
              document: {
                id: "documentation:qa-brain:motorcycle",
                title: "Motorcycle deals",
                metadata: { path: "skills/features/create-deal.md" },
                provenance: qaBrainProvenance,
              },
              claims: [{
                attribute: "content",
                value: [
                  "STT-4656 Motorcycle deals.",
                  "Set Vehicle Type = Motorcycle in Purchase Vehicle → Brake Horsepower and Cubic Centimeter are shown.",
                  "- **Either-or rule (PASS oracle):** exactly one power field is required; both are rejected.",
                ].join("\n"),
                provenance: qaBrainProvenance,
              }],
              score: 1,
            }],
            excludedConflictedClaimCount: 0,
            skippedNonTextClaimCount: 0,
            requirementClaims: [{
              requirement,
              claim: {
                attribute: "description",
                value: [
                  "*Issue*",
                  "Motorcycle power fields are missing.",
                  "*Repro Steps*",
                  "1- Login",
                  "2- Select Motorcycle",
                ].join("\n"),
                provenance: jiraProvenance,
              },
            }],
          };
        },
      },
    });

    const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-4656" });
    const proposal = result.proposals[0];

    assert.equal(proposal.automationSuitability.reusedCaseId, "manual-test:testrail:7623169");
    assert.equal(proposal.steps[0].action, "Select Create Deal.");
    assert.ok(proposal.steps.some((step) => /Vehicle Type = Motorcycle/i.test(step.action)));
    assert.ok(proposal.steps.some((step) => /exactly one power field/i.test(step.expectedResult)));
    assert.ok(
      proposal.steps.findIndex((step) => /Vehicle Type = Motorcycle/i.test(step.action))
      < proposal.steps.findIndex((step) => /Complete the Purchase Vehicle/i.test(step.action)),
    );
    assert.ok(
      proposal.steps.findIndex((step) => /Complete the Purchase Vehicle/i.test(step.action))
      < proposal.steps.findIndex((step) => /Finalize the deal/i.test(step.action)),
    );
    assert.equal(proposal.qaBrainGuidance.documents[0].title, "Motorcycle deals");
    assert.ok(proposal.citations.some((citation) => citation.source === "qa-brain"));
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.deepEqual(result.proposals[0].requirementIds, ["requirement:STT-101"]);
  assert.match(result.proposals[0].objective, /contained by requirement:STT-100/);
  assert.match(result.proposals[0].steps[0].action, /Reviewer placeholder/);
});
