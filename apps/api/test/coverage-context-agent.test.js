import test from "node:test";
import assert from "node:assert/strict";
import { createCoverageContextAgent } from "../src/agents/coverage-context-agent.js";

const provenance = (source, sourceId) => ({
  source,
  sourceId,
  sourceVersion: "1",
  contentHash: `${sourceId}-hash`,
  observedAt: "2026-09-13T00:00:00.000Z",
  normalizerId: `${source}-normalizer`,
  normalizerVersion: "1",
});

test("reports insufficient context without inventing missing test evidence", async () => {
  const jira = provenance("jira", "STT-3731");
  const agent = createCoverageContextAgent({
    knowledgeService: {
      async getCoverageContext() {
        return {
          trace: {
            story: {
              id: "requirement:STT-3731",
              type: "requirement",
              title: "FL Modernization",
              metadata: { issueType: "Epic", status: "In Progress" },
              provenance: jira,
            },
            requirements: [{
              id: "requirement:STT-3731",
              type: "requirement",
              title: "FL Modernization",
              provenance: jira,
            }],
            tests: [],
            relationships: [],
            context: {
              issueType: "Epic",
              status: "In Progress",
              relatedRequirementCount: 0,
              returnedRequirementCount: 0,
              truncated: false,
            },
          },
          coverageItems: [{
            requirement: { id: "requirement:STT-3731" },
            finding: { numerator: 0, denominator: 1 },
          }],
        };
      },
    },
    now: () => "2026-09-14T00:00:00.000Z",
    createRunId: () => "run-1",
  });

  const result = await agent.execute({
    productId: "fl-titling",
    workItemId: "STT-3731",
  });

  assert.equal(result.status, "insufficient-context");
  assert.equal(result.confidence.level, "low");
  assert.deepEqual(result.evidence.sources, ["jira"]);
  assert.ok(result.findings.some((finding) => finding.id === "epic-hierarchy-missing"));
  assert.ok(result.findings.some((finding) => finding.id === "manual-coverage-missing"));
  assert.ok(result.findings.some((finding) => finding.id === "automation-coverage-missing"));
  assert.ok(result.limitations.includes("No reportportal evidence is present in this result."));
});

test("returns not-found when the Jira work item is absent", async () => {
  const agent = createCoverageContextAgent({
    knowledgeService: {
      async getCoverageContext() {
        return { trace: undefined, coverageItems: [] };
      },
    },
    now: () => "2026-09-14T00:00:00.000Z",
    createRunId: () => "run-2",
  });

  const result = await agent.execute({
    productId: "fl-titling",
    workItemId: "STT-9999",
  });

  assert.equal(result.status, "not-found");
  assert.equal(result.confidence.level, "none");
  assert.equal(result.evidence.citations.length, 0);
});

test("uses coverage findings for every requirement discovered under an epic", async () => {
  const jiraEpic = provenance("jira", "STT-3731");
  const jiraChild = provenance("jira", "STT-5291");
  const githubTest = provenance("github", "5291");
  const agent = createCoverageContextAgent({
    knowledgeService: {
      async getCoverageContext() {
        return {
          trace: {
            story: {
              id: "requirement:STT-3731",
              type: "requirement",
              title: "FL Modernization",
              metadata: { issueType: "Epic" },
              provenance: jiraEpic,
            },
            requirements: [
              {
                id: "requirement:STT-3731",
                type: "requirement",
                title: "FL Modernization",
                provenance: jiraEpic,
              },
              {
                id: "requirement:STT-5291",
                type: "requirement",
                title: "Billing total is empty",
                provenance: jiraChild,
              },
            ],
            tests: [{
              id: "test:github:5291",
              type: "test",
              title: "Cover billing regression",
              provenance: githubTest,
            }],
            relationships: [{
              id: "link:5291:STT-5291:0",
              fromEntityId: "test:github:5291",
              toEntityId: "requirement:STT-5291",
              type: "verifies",
              provenance: githubTest,
            }],
            context: {
              issueType: "Epic",
              relatedRequirementCount: 1,
              returnedRequirementCount: 1,
              truncated: false,
            },
          },
          coverageItems: [
            {
              requirement: { id: "requirement:STT-3731" },
              finding: { numerator: 1, denominator: 1 },
            },
            {
              requirement: { id: "requirement:STT-5291" },
              finding: { numerator: 1, denominator: 1 },
            },
          ],
        };
      },
    },
    now: () => "2026-09-14T00:00:00.000Z",
    createRunId: () => "run-3",
  });

  const result = await agent.execute({
    productId: "fl-titling",
    workItemId: "STT-3731",
  });

  assert.equal(
    result.findings.some((finding) => finding.id === "requirements-not-fully-covered"),
    false,
  );
  assert.match(result.summary, /0 requirement\(s\) not fully covered/);
});
