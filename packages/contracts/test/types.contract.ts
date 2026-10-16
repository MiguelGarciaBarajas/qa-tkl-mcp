import type {
  ApplicationOperationName,
  ApplicationResultMap,
  CanonicalEntity,
  Claim,
  ConnectorHealth,
  NormalizationResult,
  RawEvidenceRecord,
  ProductConfiguration,
  StoryTestContextResult,
  SyncCheckpoint,
  TraceLink,
  ToolName,
} from "../src/index.js";
import {
  API_RESPONSE_SCHEMAS,
  TOOL_INPUT_SCHEMAS,
  stableJson,
} from "../src/index.js";

type TestRailCheckpoint = SyncCheckpoint<{
  phase: "suites" | "cases" | "runs" | "results" | "complete";
  suiteId?: string;
  casePage?: number;
  runId?: string;
  resultPage?: number;
}>;

const provenance = {
  source: "testrail",
  sourceId: "1201",
  sourceVersion: "1",
  contentHash: "a".repeat(64),
  observedAt: "2026-09-10T16:00:00.000Z",
  normalizerId: "normalizer.testrail",
  normalizerVersion: "0.1.0",
};

const entity = {
  id: "manual-test:1201",
  tenantId: "tenant-test",
  productId: "fl-titling",
  type: "manual-test",
  title: "Verify title workflow",
  provenance,
} satisfies CanonicalEntity;

const claim = {
  id: "claim:1201:title",
  entityId: entity.id,
  attribute: "title",
  value: entity.title,
  origin: "explicit",
  confidence: 1,
  status: "approved",
  provenance,
} satisfies Claim<string>;

const traceLink = {
  id: "link:STT-100:1201",
  fromEntityId: "requirement:STT-100",
  toEntityId: entity.id,
  type: "verifies",
  origin: "explicit",
  confidence: 1,
  provenance,
} satisfies TraceLink;

const evidence = {
  tenantId: "tenant-test",
  productId: "fl-titling",
  source: "testrail",
  sourceId: "1201",
  sourceVersion: "1",
  observedAt: "2026-09-10T16:00:00.000Z",
  contentType: "testrail.case",
  contentHash: "b".repeat(64),
  payload: { id: 1201 },
  classification: "internal",
} satisfies RawEvidenceRecord<{ id: number }>;

const checkpoint = {
  phase: "cases",
  suiteId: "12",
  casePage: 2,
} satisfies TestRailCheckpoint;

const health = {
  pluginId: "connector.testrail",
  status: "healthy",
  records: 4,
  retries: 0,
  failures: 0,
  lastSyncAt: "2026-09-10T16:00:00.000Z",
  lastCheckpoint: checkpoint,
} satisfies ConnectorHealth<TestRailCheckpoint>;

const normalization = {
  entities: [entity],
  claims: [claim],
  traceLinks: [traceLink],
} satisfies NormalizationResult;

const storyContext = {
  productId: "fl-titling",
  storyId: "STT-100",
  requirements: [],
  tests: [entity],
  defects: [],
  provenance: [provenance],
} satisfies StoryTestContextResult;

const applicationResults = {
  health: { status: "ok", service: "tkl-api" },
  ask_tkl: {
    runId: "ask-run-1",
    agent: { id: "agent.ask-tkl", version: "0.1.0", mode: "read-only" },
    productId: "fl-titling",
    question: "What covers STT-100?",
    workItemId: "STT-100",
    generatedAt: "2026-09-14T00:00:00.000Z",
    intent: { primary: "coverage-context", matched: ["coverage-context"] },
    scope: {
      productId: "fl-titling",
      workItemId: "STT-100",
      interpretation: "coverage context over the exact Jira hierarchy",
    },
    status: "answered",
    answer: "Grounded answer. [S1]",
    citations: [{
      id: "S1",
      source: "jira",
      sourceId: "STT-100",
      sourceVersion: "1",
      observedAt: "2026-09-14T00:00:00.000Z",
      resourceUri: "tkl://products/fl-titling/sources/jira/STT-100/provenance",
      href: "/v1/resources/read?productId=fl-titling",
    }],
    freshness: {
      status: "current",
      asOf: "2026-09-14T00:00:00.000Z",
      newestObservedAt: "2026-09-14T00:00:00.000Z",
      oldestObservedAt: "2026-09-14T00:00:00.000Z",
      staleCitationCount: 0,
      thresholdDays: 30,
    },
    confidence: { level: "high", rationale: "Current cited evidence." },
    conflicts: [],
    limitations: [],
    nextActions: [],
    toolCalls: [],
  },
  approved_action_preview: {
    preview: {
      id: "preview:00000000-0000-4000-8000-000000000001",
      schemaVersion: 1,
      tenantId: "solera",
      productId: "fl-titling",
      subject: "qa-reviewer",
      actionType: "testrail.case.update",
      target: { caseId: "1201" },
      changes: { title: "Verify title workflow" },
      sourceVersions: [{ source: "testrail", sourceId: "1201", sourceVersion: "1" }],
      requiredPermission: "actions:testrail-case-update",
      previewHash: "a".repeat(64),
      idempotencyKey: "preview-1201",
      risk: "high",
      summary: "Update one TestRail case from an approved field-level preview.",
      executable: false,
      executionStatus: "blocked",
      blockReason: {
        code: "external_writes_not_configured",
        message: "External writes are not configured.",
      },
      createdAt: "2026-09-14T00:00:00.000Z",
      expiresAt: "2026-09-14T00:15:00.000Z",
    },
  },
  approved_action_approval: {
    approval: {
      id: "approval:00000000-0000-4000-8000-000000000001",
      previewId: "preview:00000000-0000-4000-8000-000000000001",
      previewHash: "a".repeat(64),
      tenantId: "solera",
      productId: "fl-titling",
      subject: "qa-reviewer",
      actionType: "testrail.case.update",
      requiredPermission: "actions:testrail-case-update",
      idempotencyKey: "approve-1201",
      status: "approved",
      approvedAt: "2026-09-14T00:01:00.000Z",
      expiresAt: "2026-09-14T00:06:00.000Z",
      consumedAt: null,
    },
  },
  approved_action_execution: {
    execution: {
      id: "execution:00000000-0000-4000-8000-000000000001",
      approvalId: "approval:00000000-0000-4000-8000-000000000001",
      previewId: "preview:00000000-0000-4000-8000-000000000001",
      previewHash: "a".repeat(64),
      tenantId: "solera",
      productId: "fl-titling",
      subject: "qa-reviewer",
      actionType: "testrail.case.update",
      idempotencyKey: "execute-1201",
      status: "blocked",
      externalCallMade: false,
      reason: {
        code: "external_writes_not_configured",
        message: "External writes are not configured.",
      },
      attemptedAt: "2026-09-14T00:02:00.000Z",
      completedAt: "2026-09-14T00:02:00.000Z",
      recovery: {
        required: false,
        instructions: "No rollback is required.",
      },
    },
  },
  search_quality_knowledge: {
    productId: "fl-titling",
    query: "title",
    items: [entity],
    limit: 10,
  },
  get_story_test_context: storyContext,
  analyze_requirement_coverage: {
    productId: "fl-titling",
    requirementId: "requirement:STT-100",
    findings: [],
    provenance: [provenance],
  },
  explain_traceability: {
    productId: "fl-titling",
    requirementId: "requirement:STT-100",
    relationships: [traceLink],
    provenance: [provenance],
  },
  list_knowledge_conflicts: {
    productId: "fl-titling",
    conflicts: [],
    provenance: [provenance],
  },
  read_resource: {
    productId: "fl-titling",
    uri: "tkl://fl-titling/stories/STT-100",
    contents: [],
  },
} satisfies ApplicationResultMap;

const productConfiguration = {
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
    testrail: {
      enabled: false,
      configurationStatus: "pending-external-input",
      baseUrlEnv: "TESTRAIL_BASE_URL",
    },
  },
} satisfies ProductConfiguration;

const toolName: ToolName = "get_story_test_context";
const operationName: ApplicationOperationName = "health";
const serialized: string = stableJson({ operationName, toolName });

void API_RESPONSE_SCHEMAS[operationName];
void TOOL_INPUT_SCHEMAS[toolName];
void evidence;
void health;
void normalization;
void applicationResults;
void productConfiguration;
void serialized;
