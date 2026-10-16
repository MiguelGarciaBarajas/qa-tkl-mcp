import test from "node:test";
import assert from "node:assert/strict";
import { createAutomationDesignerAgent } from "../src/agents/automation-designer-agent.js";

const jiraProvenance = provenance("jira", "STT-100");
const testRailProvenance = provenance("testrail", "42");
const githubProvenance = provenance("github", "org/repo#7");

test("proposes a grounded file plan while abstaining from code without file contents", async () => {
  const agent = createAutomationDesignerAgent({
    knowledgeService: {
      async getAutomationDesignContext() {
        return contextFixture({
          repositoryFiles: [
            repositoryFile("org/repo#7:tests/e2e/title.spec.ts", "tests/e2e/title.spec.ts"),
            repositoryFile("org/repo#8:tests/pages/title.page.ts", "tests/pages/title.page.ts"),
            repositoryFile("org/repo#8:tests/fixtures/title.ts", "tests/fixtures/title.ts"),
            repositoryFile("org/repo#8:tests/support/session.ts", "tests/support/session.ts"),
          ],
        });
      },
    },
    testDesignerAgent: {
      async execute() {
        return {
          status: "ready-for-review",
          proposals: [{
            id: "test-draft:requirement:STT-100:1",
            title: "Verify valid VIN",
            requirementIds: ["requirement:STT-100"],
            preconditions: ["Reviewer confirms an eligible title application."],
            steps: [{
              order: 1,
              action: "Submit a valid VIN.",
              expectedResult: "The application is accepted.",
            }],
            expectedResult: "The application is accepted.",
            citations: [jiraProvenance],
          }],
        };
      },
    },
    createRunId: () => "automation-run-1",
    now: () => "2026-09-14T03:00:00.000Z",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.deepEqual(Object.keys(agent).sort(), ["execute", "manifest"]);
  assert.equal(result.status, "ready-for-review");
  assert.equal(result.agent.mode, "proposal-only");
  assert.equal(result.proposal.codeGeneration.status, "abstained");
  assert.equal(result.proposal.filePlan[0].action, "extend");
  assert.equal(result.proposal.filePlan[0].targetPath, "tests/e2e/title.spec.ts");
  assert.deepEqual(
    result.proposal.reusableComponents.map((item) => item.role).sort(),
    ["fixture", "page-object", "utility"],
  );
  assert.deepEqual(result.proposal.validationCommands, []);
  assert.ok(result.proposal.discoveryTasks.some((item) =>
    item.id === "collect-repository-file-contents"));
  assert.ok(result.limitations.some((item) => item.includes("proposal-only")));
});

test("uses only commands declared by collected repository manifest content", async () => {
  const packageFile = repositoryFile(
    "org/repo#7:package.json",
    "package.json",
    JSON.stringify({
      scripts: {
        test: "vitest run",
        typecheck: "tsc --noEmit",
        deploy: "do-not-propose",
      },
      devDependencies: { vitest: "5.0.0" },
    }),
  );
  const agent = createAutomationDesignerAgent({
    knowledgeService: {
      async getAutomationDesignContext() {
        return contextFixture({
          repositoryFiles: [
            repositoryFile(
              "org/repo#7:tests/e2e/title.spec.ts",
              "tests/e2e/title.spec.ts",
              "test('title', async () => {});",
            ),
            packageFile,
          ],
        });
      },
    },
    testDesignerAgent: { execute: async () => ({ status: "ready-for-review", proposals: [] }) },
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.deepEqual(
    result.proposal.validationCommands.map((item) => item.command),
    ["npm run test", "npm run typecheck"],
  );
  assert.deepEqual(result.proposal.conventions.frameworkSignals, ["vitest"]);
  assert.ok(!result.proposal.validationCommands.some((item) => item.command.includes("deploy")));
});

test("returns not-found without invoking proposal generation when Jira scope is absent", async () => {
  let designerCalled = false;
  const agent = createAutomationDesignerAgent({
    knowledgeService: {
      async getAutomationDesignContext() {
        return { trace: undefined };
      },
    },
    testDesignerAgent: {
      async execute() {
        designerCalled = true;
      },
    },
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-404" });

  assert.equal(result.status, "not-found");
  assert.equal(result.proposal.codeGeneration.status, "abstained");
  assert.equal(designerCalled, false);
});

function contextFixture({ repositoryFiles }) {
  const requirement = {
    id: "requirement:STT-100",
    type: "requirement",
    title: "Validate VIN",
    provenance: jiraProvenance,
  };
  const manualTest = {
    id: "manual-test:testrail:42",
    type: "manual-test",
    title: "Submit application with valid VIN",
    provenance: testRailProvenance,
  };
  const automatedTest = {
    id: "test:github:7",
    type: "test",
    title: "Automate valid VIN",
    provenance: githubProvenance,
  };
  return {
    rootRequirementId: requirement.id,
    trace: {
      requirements: [requirement],
      tests: [manualTest, automatedTest],
      relationships: [],
    },
    requirementClaims: [],
    manualCaseContexts: [{
      testCase: manualTest,
      claims: [{
        attribute: "custom_preconds",
        value: "Use an eligible title application.",
        status: "approved",
        provenance: testRailProvenance,
      }, {
        attribute: "custom_steps_separated",
        value: [{ content: "Submit a valid VIN.", expected: "The application is accepted." }],
        status: "approved",
        provenance: testRailProvenance,
      }],
      relationships: [],
      requirementIds: [requirement.id],
      conflictedClaimCount: 0,
    }],
    githubAutomation: [automatedTest],
    scopeRepositoryFiles: repositoryFiles.filter((item) =>
      item.pullRequestSourceId === "org/repo#7"),
    repositoryFiles,
  };
}

function repositoryFile(sourceId, path, content) {
  return {
    id: `repository-file:${sourceId}@1`,
    repository: "org/repo",
    pullRequestSourceId: sourceId.slice(0, sourceId.indexOf(":")),
    path,
    contentAvailable: content !== undefined,
    ...(content !== undefined ? { content } : {}),
    provenance: provenance("github", sourceId),
  };
}

function provenance(source, sourceId) {
  return {
    source,
    sourceId,
    sourceVersion: "1",
    contentHash: `${source}-${sourceId}`,
    observedAt: "2026-09-14T00:00:00.000Z",
    normalizerId: `${source}-normalizer`,
    normalizerVersion: "1",
  };
}
