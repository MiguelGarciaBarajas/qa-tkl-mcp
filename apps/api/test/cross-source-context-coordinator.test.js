import assert from "node:assert/strict";
import test from "node:test";
import { createCrossSourceContextCoordinator } from "../src/cross-source-context-coordinator.js";

const provenance = (source, sourceId) => [{
  source,
  sourceId,
  sourceVersion: "1",
  contentHash: `${source}-${sourceId}`,
}];

function caseContext(id, title, claims = []) {
  return {
    testCase: {
      id: `manual-test:testrail:${id}`,
      productId: "fl",
      type: "manual-test",
      title,
      provenance: provenance("testrail", id),
    },
    claims: [
      {
        id: `claim:${id}:title`,
        attribute: "title",
        value: title,
        provenance: provenance("testrail", id),
      },
      ...claims,
    ],
    relationships: [],
    requirementIds: [],
    conflictedClaimCount: 0,
  };
}

test("enriches an exact TestRail case with bounded cross-source context", async () => {
  let hydrated = false;
  let neighborhoodLoaded = false;
  const calls = [];
  const anchor = caseContext("42", "Create metal plate cash deal", [{
    id: "claim:42:jira",
    attribute: "custom_jira_references",
    value: ["STT-4656"],
    provenance: provenance("testrail", "42"),
  }]);
  const neighbor = caseContext("43", "Create metal plate finance deal");
  const knowledgeService = {
    async getTestRailCaseImprovementContext() {
      if (!hydrated) {
        return {
          trace: null,
          caseContexts: [],
          allManualTestContexts: [],
          scopeRequirementIds: [],
        };
      }
      return {
        trace: {
          requirements: [{
            id: "requirement:STT-4656",
            type: "requirement",
            title: "Motorcycle transaction",
            provenance: provenance("jira", "STT-4656"),
          }],
          relationships: [],
          context: { truncated: false },
        },
        caseContexts: [anchor],
        allManualTestContexts: neighborhoodLoaded ? [anchor, neighbor] : [anchor],
        scopeRequirementIds: ["requirement:STT-4656"],
      };
    },
    async getEvidenceGraph() {
      return {
        nodes: [{
          id: "automated-test:github:metal-plate",
          type: "automated-test",
          title: "metal plate",
          codeRef: "tests/metal-plate.spec.ts::cash deal",
          provenance: provenance("github", "tests/metal-plate.spec.ts"),
        }],
        edges: [],
        truncated: false,
      };
    },
  };
  const sourceConnectionService = {
    async list() {
      return ["jira", "testrail", "github", "reportportal", "confluence"].map((source) => ({
        source,
        status: "connected",
      }));
    },
    async hydrateTestRailCase() {
      calls.push("testrail:exact");
      hydrated = true;
      return { status: "complete", recordsCollected: 1, truncated: false };
    },
    async hydrateTestRailCaseNeighborhood({ maxRecords }) {
      calls.push(`testrail:neighborhood:${maxRecords}`);
      neighborhoodLoaded = true;
      return { status: "complete", recordsCollected: 2, truncated: false };
    },
    async hydrateJiraIssue({ issueKey }) {
      calls.push(`jira:${issueKey}`);
      return { status: "complete", recordsCollected: 1, truncated: false };
    },
    async enrichJiraIssue({ issueKey }) {
      calls.push(`related:${issueKey}`);
      return {
        github: { status: "complete", recordsCollected: 2, truncated: false },
        testrail: { status: "complete", recordsCollected: 1, truncated: false },
      };
    },
    async hydrateReportPortalTestHistory({ identity }) {
      calls.push(`reportportal:${identity}`);
      return { status: "complete", recordsCollected: 3, truncated: false };
    },
    async hydrateConfluenceContext({ query }) {
      calls.push(`confluence:${query}`);
      return { status: "complete", recordsCollected: 1, truncated: false };
    },
  };
  const coordinator = createCrossSourceContextCoordinator({
    knowledgeService,
    sourceConnectionService,
  });

  const result = await coordinator.enrich({
    productId: "fl",
    anchor: { source: "testrail", type: "manual-test", externalId: "C42" },
  });

  assert.equal(result.anchor.id, "manual-test:testrail:42");
  assert.equal(result.manualTests.length, 2);
  assert.equal(result.candidateRelationships.length, 1);
  assert.equal(result.candidateRelationships[0].status, "review-required");
  assert.equal(result.sourceStatus.jira.state, "complete");
  assert.equal(result.sourceStatus.github.recordsCollected, 2);
  assert.equal(result.sourceStatus.reportportal.recordsCollected, 3);
  assert.ok(calls.includes("testrail:neighborhood:100"));
  assert.ok(calls.includes("jira:STT-4656"));
  assert.ok(calls.includes("reportportal:tests/metal-plate.spec.ts::cash deal"));

  const callCount = calls.length;
  const cached = await coordinator.enrich({
    productId: "fl",
    anchor: { source: "testrail", type: "manual-test", externalId: "42" },
    intent: "ask-tkl",
  });
  assert.equal(cached.cache.hit, true);
  assert.equal(cached.intent, "ask-tkl");
  assert.equal(calls.length, callCount);
});

test("clamps TestRail retrieval to the hard 100-case ceiling", async () => {
  const coordinator = createCrossSourceContextCoordinator({
    knowledgeService: {
      async getTestRailCaseImprovementContext() {
        return { trace: null, caseContexts: [], allManualTestContexts: [] };
      },
    },
    sourceConnectionService: {
      async list() {
        return [];
      },
    },
  });

  const result = await coordinator.enrich({
    productId: "fl",
    anchor: { source: "testrail", type: "manual-test", externalId: "42" },
    budgets: { testRailCases: 500 },
  });

  assert.equal(result.budgets.testRailCases, 100);
});

test("uses the same bounded coordinator for Jira-anchored agents", async () => {
  const calls = [];
  const requirement = {
    id: "requirement:STT-4656",
    type: "requirement",
    title: "Motorcycle transaction",
    provenance: provenance("jira", "STT-4656"),
  };
  const coordinator = createCrossSourceContextCoordinator({
    knowledgeService: {
      async getTestRailCaseImprovementContext() {
        throw new Error("Unexpected TestRail context read");
      },
      async getCoverageContext() {
        return {
          trace: {
            story: requirement,
            requirements: [requirement],
            tests: [],
            relationships: [],
            context: { truncated: false },
          },
        };
      },
      async getEvidenceGraph({ entityId }) {
        assert.equal(entityId, requirement.id);
        return { nodes: [requirement], edges: [], truncated: false };
      },
    },
    sourceConnectionService: {
      async list() {
        return ["jira", "testrail", "github", "reportportal", "confluence"].map((source) => ({
          source,
          status: source === "github" ? "disconnected" : "connected",
        }));
      },
      async hydrateJiraIssue({ issueKey }) {
        calls.push(`jira:${issueKey}`);
        return { status: "complete", recordsCollected: 1 };
      },
      async enrichJiraIssue({ issueKey }) {
        calls.push(`related:${issueKey}`);
        return {
          testrail: { status: "complete", recordsCollected: 2 },
          github: { status: "not-connected", recordsCollected: 0 },
        };
      },
      async hydrateConfluenceContext({ query }) {
        calls.push(`confluence:${query}`);
        return { status: "complete", recordsCollected: 1 };
      },
    },
  });

  const result = await coordinator.enrich({
    productId: "fl",
    anchor: { source: "jira", type: "requirement", externalId: "stt-4656" },
    intent: "automation-design",
  });

  assert.equal(result.anchor.id, requirement.id);
  assert.equal(result.sourceStatus.testrail.state, "complete");
  assert.equal(result.sourceStatus.github.state, "not-connected");
  assert.equal(result.sourceStatus.reportportal.state, "not-linked");
  assert.ok(calls.includes("jira:STT-4656"));
  assert.ok(calls.includes("related:STT-4656"));
  assert.ok(calls.includes("confluence:STT-4656"));
});
