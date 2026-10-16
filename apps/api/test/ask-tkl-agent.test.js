import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyQuestion,
  createAskTklAgent,
} from "../src/agents/ask-tkl-agent.js";

const citation = {
  source: "jira",
  sourceId: "STT-3731",
  sourceVersion: "7",
  observedAt: "2026-09-13T12:00:00.000Z",
};

function dependencies(overrides = {}) {
  const calls = [];
  const coverageContextAgent = {
    manifest: { id: "agent.coverage-context" },
    async execute(request) {
      calls.push(["coverage", request]);
      return {
        status: "ready-for-review",
        summary: "STT-3731 has one covered requirement and one unverified requirement.",
        confidence: { level: "high", rationale: "Jira and test evidence are linked." },
        findings: [{
          title: "One requirement remains unverified",
          detail: "No trusted test link covers requirement:STT-3731-2.",
        }],
        recommendations: [{ action: "Review the uncovered acceptance criterion." }],
        evidence: {
          requirements: [
            { id: "requirement:STT-3731", title: "Title application" },
          ],
          tests: [{ id: "test:github:happy-path", title: "Happy path" }],
          citations: [citation],
        },
        limitations: [],
      };
    },
  };
  const knowledgeService = {
    async getRequirementSummaryContext(request) {
      calls.push(["summary", request]);
      return {
        requirement: {
          id: "requirement:STT-3731",
          type: "requirement",
          title: "Title application",
          provenance: [citation],
        },
        claims: [{
          id: "claim:STT-3731:description",
          attribute: "description",
          value: "Allows users to submit a title application.",
          provenance: [citation],
        }, {
          id: "claim:STT-3731:type:1",
          attribute: "issueType",
          value: "Story",
          provenance: [citation],
        }, {
          id: "claim:STT-3731:type:2",
          attribute: "issueType",
          value: "Story",
          provenance: [citation],
        }],
      };
    },
    async search(request) {
      calls.push(["search", request]);
      return {
        items: [{
          id: "requirement:STT-99",
          type: "requirement",
          title: "Title application validation",
          provenance: citation,
        }],
      };
    },
    async listKnowledgeConflicts(request) {
      calls.push(["conflicts", request]);
      return {
        conflicts: [{
          id: "conflict:1",
          entityId: "requirement:STT-3731",
          reason: "Jira and Confluence disagree on the rule.",
        }],
      };
    },
  };
  const unusedAgent = {
    manifest: { id: "agent.unused" },
    async execute() {
      throw new Error("Unexpected agent call");
    },
  };
  return {
    calls,
    options: {
      knowledgeService,
      coverageContextAgent,
      testDesignerAgent: unusedAgent,
      testRailImprovementAgent: unusedAgent,
      automationDesignerAgent: unusedAgent,
      reliabilityDefectIntelligenceAgent: unusedAgent,
      knowledgeCuratorAgent: unusedAgent,
      now: () => "2026-09-14T12:00:00.000Z",
      createRunId: () => "ask-run-1",
      ...overrides,
    },
  };
}

test("classifies supported Ask TKL intents deterministically", () => {
  assert.equal(
    classifyQuestion("What changed under STT-3731 and what remains unverified?").primary,
    "coverage-context",
  );
  assert.equal(
    classifyQuestion("Propose negative test cases for STT-3731.").primary,
    "test-design",
  );
  assert.equal(
    classifyQuestion("Why are the STT-3731 ReportPortal failures inconsistent?").primary,
    "reliability",
  );
  assert.equal(
    classifyQuestion("De qué trata STT-3731?").primary,
    "ticket-summary",
  );
  assert.equal(
    classifyQuestion("What should QA know about STT-3731?").primary,
    "ticket-intelligence",
  );
  assert.equal(classifyQuestion("What is the capital of France?").primary, "unsupported");
});

test("routes an exact TestRail case question through bounded case intelligence", async () => {
  const calls = [];
  const unifiedContext = {
    sourceStatus: {
      testrail: {
        state: "complete",
        detail: "The bounded query collected 10 record(s).",
      },
    },
    citations: [{
      source: "testrail",
      sourceId: "26485503",
      sourceVersion: "1",
      observedAt: "2026-09-17T12:00:00.000Z",
    }],
  };
  const { options } = dependencies({
    testRailImprovementAgent: {
      manifest: { id: "agent.testrail-improvement" },
      async execute(request) {
        calls.push(request);
        return {
          status: "ready-for-review",
          summary: "Exact case and its neighborhood were inspected.",
          confidence: { level: "medium", rationale: "Bounded source evidence." },
          proposals: [],
          evidence: {
            sources: ["testrail"],
            sourceStatus: unifiedContext.sourceStatus,
            citations: unifiedContext.citations,
          },
          limitations: [],
        };
      },
    },
  });

  const result = await createAskTklAgent(options).execute({
    productId: "fl-titling",
    question: "What should QA know about C26485503?",
    unifiedContext,
  });

  assert.equal(result.intent.primary, "testrail-improvement");
  assert.equal(result.caseId, "26485503");
  assert.deepEqual(calls, [{
    productId: "fl-titling",
    workItemId: undefined,
    caseId: "26485503",
    unifiedContext,
  }]);
  assert.match(result.answer, /testrail: complete/i);
});

test("does not extract non-Jira hyphenated terms as Jira keys", async () => {
  for (const term of ["top-10", "utf-8", "Q3-2026"]) {
    assert.equal(classifyQuestion(term).primary, "unsupported");

    const { calls, options } = dependencies();
    const result = await createAskTklAgent(options).execute({
      productId: "fl-titling",
      question: `Explain ${term}.`,
    });

    assert.equal(result.status, "abstained");
    assert.equal(result.workItemId, undefined);
    assert.equal(calls.length, 0);
  }

  assert.equal(classifyQuestion("What covers STT-3731?").primary, "coverage-context");
});

test("orchestrates the scoped read-only agent and returns cited freshness and conflicts", async () => {
  const { calls, options } = dependencies();
  const agent = createAskTklAgent(options);

  const result = await agent.execute({
    productId: "fl-titling",
    question: "What changed under STT-3731, which tests cover it, and what remains unverified?",
  });

  assert.equal(result.status, "answered");
  assert.equal(result.intent.primary, "coverage-context");
  assert.equal(result.workItemId, "STT-3731");
  assert.match(result.answer, /\[S1\]/);
  assert.match(result.answer, /remains unverified/i);
  assert.equal(result.citations[0].resourceUri,
    "tkl://products/fl-titling/sources/jira/STT-3731/provenance");
  assert.match(result.citations[0].href, /^\/v1\/resources\/read\?/);
  assert.equal(result.freshness.status, "current");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.confidence.level, "medium");
  assert.deepEqual(calls.map(([name]) => name), ["coverage", "conflicts"]);
});

test("uses an explicitly supplied Jira key to ground an otherwise general question", async () => {
  const { calls, options } = dependencies();
  const result = await createAskTklAgent(options).execute({
    productId: "fl-titling",
    question: "Explain this workflow.",
    workItemId: "STT-3731",
  });

  assert.equal(result.intent.primary, "ticket-summary");
  assert.equal(result.status, "answered");
  assert.deepEqual(calls.map(([name]) => name), ["summary", "conflicts"]);
});

test("summarizes an exact Jira ticket instead of running coverage analysis", async () => {
  const { calls, options } = dependencies();
  const result = await createAskTklAgent(options).execute({
    productId: "fl-titling",
    question: "De qué trata STT-3731?",
  });

  assert.equal(result.intent.primary, "ticket-summary");
  assert.equal(result.status, "answered");
  assert.match(result.answer, /Title application/);
  assert.match(result.answer, /submit a title application/);
  assert.deepEqual(calls.map(([name]) => name), ["summary", "conflicts"]);
});

test("combines the Jira summary with cross-platform quality context for broad QA questions", async () => {
  const { calls, options } = dependencies();
  const result = await createAskTklAgent(options).execute({
    productId: "fl-titling",
    question: "What should QA know about STT-3731?",
  });

  assert.equal(result.intent.primary, "ticket-intelligence");
  assert.equal(result.status, "answered");
  assert.match(result.answer, /Description: Allows users to submit a title application/i);
  assert.match(result.answer, /Cross-platform evidence:/i);
  assert.match(result.answer, /TestRail/i);
  assert.match(result.answer, /GitHub/i);
  assert.match(result.answer, /One requirement remains unverified/i);
  assert.equal([...result.answer.matchAll(/Type: Story/g)].length, 1);
  assert.deepEqual(calls.map(([name]) => name), ["summary", "coverage", "conflicts"]);
});

test("uses bounded canonical search for a product question without a Jira key", async () => {
  const { calls, options } = dependencies();
  const agent = createAskTklAgent(options);

  const result = await agent.execute({
    productId: "fl-titling",
    question: "Explain the title application workflow.",
  });

  assert.equal(result.intent.primary, "knowledge-search");
  assert.equal(result.status, "answered");
  assert.match(result.answer, /Title application validation/);
  const searchCalls = calls.filter(([name]) => name === "search");
  assert.ok(searchCalls.length > 0);
  assert.ok(searchCalls.length <= 4);
  assert.ok(searchCalls.every(([, request]) => request.limit === 12));
});

test("abstains without calling tools for unsupported or conflicting scope", async () => {
  const first = dependencies();
  const unsupported = await createAskTklAgent(first.options).execute({
    productId: "fl-titling",
    question: "What is the capital of France?",
  });
  assert.equal(unsupported.status, "abstained");
  assert.equal(unsupported.citations.length, 0);
  assert.equal(first.calls.length, 0);

  const second = dependencies();
  const conflict = await createAskTklAgent(second.options).execute({
    productId: "fl-titling",
    question: "What covers STT-100?",
    workItemId: "STT-200",
  });
  assert.equal(conflict.status, "abstained");
  assert.match(conflict.limitations[0], /conflicts with/i);
  assert.equal(second.calls.length, 0);
});

test("abstains when a specialized capability lacks a Jira scope", async () => {
  const { calls, options } = dependencies();
  const result = await createAskTklAgent(options).execute({
    productId: "fl-titling",
    question: "Which automation has repeated inconsistent failures?",
  });

  assert.equal(result.intent.primary, "reliability");
  assert.equal(result.status, "abstained");
  assert.match(result.nextActions[0], /Jira key/i);
  assert.equal(calls.length, 0);
});
