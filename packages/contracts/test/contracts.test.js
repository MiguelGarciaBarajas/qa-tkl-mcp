import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  assertIncrementalLookbackSeconds,
  assertProductConfiguration,
  sourceTimestampIso,
  validateApiResponse,
  validateProductConfiguration,
  validateToolArguments,
} from "../src/index.js";

test("validates bounded lookback configuration and normalizes source timestamps", () => {
  assert.equal(assertIncrementalLookbackSeconds(undefined), undefined);
  assert.equal(assertIncrementalLookbackSeconds(0), 0);
  assert.equal(assertIncrementalLookbackSeconds(60), 60);
  assert.throws(() => assertIncrementalLookbackSeconds(-1), /between 0 and/);
  assert.throws(() => assertIncrementalLookbackSeconds(31_536_001), /between 0 and/);
  assert.equal(sourceTimestampIso(1_757_000_000), "2025-09-04T15:33:20.000Z");
  assert.equal(sourceTimestampIso("not-a-timestamp"), undefined);
});

test("accepts valid tool arguments and rejects undeclared fields", () => {
  assert.equal(
    validateToolArguments("get_story_test_context", {
      productId: "fl-titling",
      storyId: "STT-123"
    }).valid,
    true
  );
  assert.equal(
    validateToolArguments("get_story_test_context", {
      productId: "fl-titling",
      storyId: "STT-123",
      token: "secret"
    }).valid,
    false
  );
});

test("validates search offset independently from the page limit", () => {
  assert.deepEqual(
    validateToolArguments("search_quality_knowledge", {
      productId: "fl-titling",
      offset: 0,
    }),
    { valid: true },
  );
  assert.deepEqual(
    validateToolArguments("search_quality_knowledge", {
      productId: "fl-titling",
      offset: 101,
    }),
    { valid: true },
  );
  assert.equal(
    validateToolArguments("search_quality_knowledge", {
      productId: "fl-titling",
      offset: -1,
    }).valid,
    false,
  );
});

test("validates the required shape of API responses", () => {
  assert.equal(
    validateApiResponse("list_knowledge_conflicts", {
      productId: "fl-titling",
      conflicts: [],
      provenance: []
    }).valid,
    true
  );
  assert.equal(
    validateApiResponse("list_knowledge_conflicts", {
      productId: "fl-titling",
      conflicts: []
    }).valid,
    false
  );
});

test("validates the grounded Ask TKL response contract", () => {
  const response = {
    runId: "ask-run-1",
    agent: { id: "agent.ask-tkl", version: "0.1.0", mode: "read-only" },
    productId: "fl-titling",
    question: "What covers STT-3731?",
    generatedAt: "2026-09-14T12:00:00.000Z",
    intent: { primary: "coverage-context", matched: ["coverage-context"] },
    scope: { productId: "fl-titling", workItemId: "STT-3731", interpretation: "exact scope" },
    status: "answered",
    answer: "Grounded answer. [S1]",
    citations: [],
    freshness: { status: "unknown", asOf: "2026-09-14T12:00:00.000Z" },
    confidence: { level: "medium", rationale: "Cited evidence." },
    conflicts: [],
    limitations: [],
    nextActions: [],
    toolCalls: [],
  };

  assert.equal(validateApiResponse("ask_tkl", response).valid, true);
  assert.equal(validateApiResponse("ask_tkl", { ...response, citations: undefined }).valid, false);
});

test("validates the Automation Designer API response contract", () => {
  const response = {
    runId: "automation-run-1",
    agent: { id: "agent.automation-designer", version: "0.1.0" },
    productId: "fl-titling",
    workItemId: "STT-100",
    generatedAt: "2026-09-14T03:00:00.000Z",
    status: "ready-for-review",
    confidence: { level: "medium", rationale: "Grounded repository paths." },
    summary: "One file plan proposed.",
    proposal: {
      delivery: "review-only",
      codeGeneration: { status: "abstained", rationale: "No file contents." },
      filePlan: [],
      codeOutline: [],
      reusableComponents: [],
      requiredTestData: [],
      validationCommands: [],
      conventions: {},
      discoveryTasks: [],
    },
    evidence: {
      sources: ["jira", "testrail", "github"],
      requirements: [],
      manualCases: [],
      automatedTests: [],
      repositoryFiles: [],
      citations: [],
    },
    limitations: [],
  };

  assert.equal(validateApiResponse("automation_designer_agent_run", response).valid, true);
  assert.equal(
    validateApiResponse("automation_designer_agent_run", {
      ...response,
      proposal: undefined,
    }).valid,
    false,
  );
});

test("validates the Reliability and Defect Intelligence API response contract", () => {
  const response = {
    runId: "reliability-run-1",
    agent: { id: "agent.reliability-defect-intelligence", version: "0.1.0" },
    productId: "fl-titling",
    workItemId: "STT-100",
    generatedAt: "2026-09-14T04:00:00.000Z",
    status: "ready-for-review",
    confidence: { level: "medium", rationale: "Multi-run history is available." },
    summary: "One stable test identity was analyzed.",
    analyses: [],
    recommendations: [],
    evidence: {
      sources: ["jira", "reportportal"],
      requirements: [],
      reportPortalExecutions: [],
      jiraDefects: [],
      citations: [],
    },
    limitations: [],
  };

  assert.equal(
    validateApiResponse("reliability_defect_intelligence_agent_run", response).valid,
    true,
  );
  assert.equal(
    validateApiResponse("reliability_defect_intelligence_agent_run", {
      ...response,
      analyses: undefined,
    }).valid,
    false,
  );
});

test("validates the Knowledge Curator API response contract", () => {
  const response = {
    runId: "curator-run-1",
    agent: { id: "agent.knowledge-curator", version: "0.1.0" },
    productId: "fl-titling",
    workItemId: "STT-100",
    generatedAt: "2026-09-14T05:00:00.000Z",
    scope: {
      rootRequirementId: "requirement:STT-100",
      requirementIds: ["requirement:STT-100"],
      productId: "fl-titling",
    },
    status: "ready-for-review",
    confidence: { level: "medium", rationale: "Scoped evidence is available." },
    summary: "One curation proposal is ready for review.",
    findings: [],
    proposals: [],
    evidence: {
      sources: ["jira"],
      requirements: [],
      entities: [],
      claims: [],
      traceLinks: [],
      openConflicts: [],
      unresolvedTraceLinks: [],
      citations: [],
    },
    limitations: ["Proposal only."],
    approval: { required: true, role: "knowledge-reviewer" },
  };

  assert.equal(validateApiResponse("knowledge_curator_agent_run", response).valid, true);
  assert.equal(
    validateApiResponse("knowledge_curator_agent_run", {
      ...response,
      approval: undefined,
    }).valid,
    false,
  );
});

test("validates the complete coverage analysis finding shape", () => {
  const response = {
    productId: "fl-titling",
    requirementId: "STT-1234",
    findings: [{
      requirementId: "requirement:STT-1234",
      numerator: 1,
      denominator: 1,
      linkConfidence: 1,
      uncovered: [],
      policy: { version: "fixture-v1", provisional: true },
      manualCoverage: {
        status: "evaluated",
        basis: "requirement-link",
        numerator: 1,
        denominator: 1,
        ratio: 1,
        evidenceEntityIds: ["manual-test:testrail:1"]
      },
      automatedCoverage: {
        status: "evaluated",
        basis: "requirement-link",
        numerator: 0,
        denominator: 1,
        ratio: 0,
        evidenceEntityIds: []
      },
      executionFreshness: {
        status: "evaluated",
        numerator: 0,
        denominator: 1,
        ratio: 0,
        coveredEntityIds: [],
        uncoveredEntityIds: ["manual-test:testrail:1"],
        staleEntityIds: [],
        nonQualifyingEntityIds: ["manual-test:testrail:1"],
        missingExecutionEntityIds: []
      },
      combinedCoverage: {
        status: "evaluated",
        score: 0.4,
        weights: { manual: 0.4, automated: 0.4, executionFreshness: 0.2 }
      }
    }],
    provenance: []
  };

  assert.equal(validateApiResponse("analyze_requirement_coverage", response).valid, true);
  assert.equal(
    validateApiResponse("analyze_requirement_coverage", {
      productId: "fl-titling",
      requirementId: "STT-1234",
      findings: [{
        requirementId: "requirement:STT-1234",
        numerator: 1,
        denominator: 1,
        linkConfidence: 1,
        uncovered: []
      }],
      provenance: []
    }).valid,
    true
  );
  assert.equal(
    validateApiResponse("analyze_requirement_coverage", {
      ...response,
      findings: [{ requirementId: "requirement:STT-1234" }]
    }).valid,
    false
  );
  assert.equal(
    validateApiResponse("analyze_requirement_coverage", {
      ...response,
      findings: [{
        ...response.findings[0],
        combinedCoverage: {
          status: "evaluated",
          score: null,
          weights: null
        }
      }]
    }).valid,
    false
  );
});

test("validates non-secret product configuration and connector credential references", () => {
  const configuration = {
    configVersion: "0.1",
    tenantId: "solera",
    productId: "fl-titling",
    enabledPlugins: ["connector.jira", "connector.github"],
    plannedPlugins: ["connector.testrail"],
    credentialRefs: {
      "connector.jira": "secret://jira/fl-titling",
      "connector.github": "secret://github/fl-titling",
      "connector.testrail": "secret://testrail/fl-titling",
    },
    sources: {
      jira: {
        enabled: true,
        configurationStatus: "ready",
        baseUrl: "https://jira.example.test",
      },
      github: {
        enabled: true,
        configurationStatus: "ready",
        repository: "example/repository",
      },
      testrail: { enabled: false, configurationStatus: "pending-external-input" },
    },
  };

  assert.equal(validateProductConfiguration(configuration).valid, true);
  assert.equal(assertProductConfiguration(configuration), configuration);
});

test("validates every checked-in product configuration", async () => {
  const configurationDirectory = new URL("../../../config/products/", import.meta.url);
  const configurationFiles = (await readdir(configurationDirectory))
    .filter((fileName) => fileName.endsWith(".json"));

  assert.ok(configurationFiles.length > 0, "At least one product configuration is required");

  for (const fileName of configurationFiles) {
    const configuration = JSON.parse(
      await readFile(new URL(fileName, configurationDirectory), "utf8"),
    );
    const validation = validateProductConfiguration(configuration);

    assert.deepEqual(validation.errors, [], `${fileName} must satisfy the product configuration contract`);
  }
});

test("rejects conflicting plugins, missing references, and unknown sources", () => {
  const validation = validateProductConfiguration({
    configVersion: "0.1",
    tenantId: "solera",
    productId: "fl-titling",
    enabledPlugins: ["connector.jira"],
    plannedPlugins: ["connector.jira", "connector.testrail"],
    credentialRefs: {
      "connector.jira": "token-value",
    },
    sources: {
      unknown: {},
    },
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('Plugin "connector.jira" cannot be both enabled and planned'));
  assert.ok(validation.errors.includes('Credential reference for "connector.jira" is invalid'));
  assert.ok(validation.errors.includes('Credential reference for "connector.testrail" is required'));
  assert.ok(validation.errors.includes('Source "unknown" is not registered'));
});

test("rejects enabled connector plugins whose source is disabled", () => {
  const validation = validateProductConfiguration({
    configVersion: "0.1",
    tenantId: "solera",
    productId: "fl-titling",
    enabledPlugins: ["connector.jira"],
    plannedPlugins: [],
    credentialRefs: {
      "connector.jira": "secret://jira/fl-titling",
    },
    sources: {
      jira: {
        enabled: false,
        configurationStatus: "disabled",
      },
    },
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes(
    'Enabled plugin "connector.jira" requires a ready source',
  ));
});

test("rejects unknown fields, malformed optional lists, pending sources, and credential-like source fields", () => {
  const validation = validateProductConfiguration({
    configVersion: "0.1",
    tenantId: "solera",
    productId: "fl-titling",
    enabledPlugins: ["connector.jira"],
    plannedPlugins: null,
    credentialRefs: {
      "connector.jira": "secret://jira/fl-titling",
    },
    sources: {
      jira: {
        enabled: true,
        configurationStatus: "pending-external-input",
        nested: {
          apiToken: "must-not-be-stored-here",
        },
      },
    },
    token: "must-not-be-stored-here",
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('Product configuration field "token" is not allowed'));
  assert.ok(validation.errors.includes("plannedPlugins must be an array"));
  assert.ok(validation.errors.includes('Enabled plugin "connector.jira" requires a ready source'));
  assert.ok(validation.errors.includes(
    "sources.jira.nested.apiToken is credential-like; use credentialRefs instead",
  ));
});
