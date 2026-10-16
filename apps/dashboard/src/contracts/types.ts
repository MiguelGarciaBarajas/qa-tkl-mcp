/**
 * Local stand-in types for the shared contracts owned by the Architecture and Contracts
 * workstream (Miguel Barajas), defined in `packages/contracts` and described in
 * `docs/team/TKL-Team-Work-Plan.md` (section 4) and `docs/team/TKL-Team-Onboarding.md`.
 *
 * `packages/contracts` does not exist yet. These types exist ONLY so the dashboard can be
 * built and demoed against realistic shapes today. When `packages/contracts` lands, this
 * file must be deleted and every import switched to the real package — do not let this
 * become a second source of truth for the schema.
 */

export type Classification = "internal" | "confidential" | "restricted";

/**
 * Simplified projection of the real `@tkl/contracts` `Provenance` shape
 * (`source`, `sourceId`, `sourceVersion`, `contentHash`, `observedAt`, `normalizerId`,
 * `normalizerVersion`) down to what the dashboard displays. `classification` is not yet
 * surfaced at the canonical-entity layer by the real API, so the HTTP client defaults it
 * to `"internal"` until that's available.
 */
export interface Provenance {
  source: "jira" | "github" | "testrail" | "confluence" | "reportportal";
  sourceVersion: string;
  observedAt: string;
  classification: Classification;
}

export interface RawEvidenceRecord {
  tenantId: string;
  productId: string;
  source: "jira" | "github" | "testrail" | "confluence" | "reportportal";
  sourceId: string;
  sourceVersion: string;
  sourceUrl?: string;
  observedAt: string;
  contentType: string;
  contentHash: string;
  classification: Classification;
}

export type ArtifactSource =
  | "jira"
  | "testrail"
  | "github"
  | "reportportal"
  | "confluence";

export type ArtifactType =
  | "requirement"
  | "defect"
  | "test-case"
  | "automated-test"
  | "execution"
  | "document";

export interface ArtifactRef {
  source: ArtifactSource;
  type: ArtifactType;
  externalId: string;
}

export interface ArtifactCandidate {
  ref: ArtifactRef;
  canonicalId: string;
  title: string;
  match: "exact-id" | "exact-title" | "partial-title";
  confidence: number;
  matchedIdentity?: string;
  observedAt: string | null;
  sourceUrl: string | null;
}

export interface ArtifactResolution {
  productId: string;
  query: string;
  detected: {
    kind: "jira-key" | "testrail-case-id" | "reportportal-identity" | "text";
    source: ArtifactSource | null;
    lookupValue: string;
    exact: boolean;
  };
  status: "resolved" | "ambiguous" | "not-found";
  selected: ArtifactCandidate | null;
  candidates: ArtifactCandidate[];
}

export interface EvidenceGraph {
  productId: string;
  anchorId: string;
  nodes: Array<{
    id: string;
    type: string;
    title: string;
    source: ArtifactSource | null;
    externalId: string | null;
    observedAt: string | null;
    claims: Array<{ attribute: string; value: unknown; confidence: number }>;
  }>;
  edges: Array<{
    id: string;
    type: string;
    from: string;
    to: string;
    confidence: number | null;
  }>;
  truncated: boolean;
}

export type ConnectorStatus =
  | "healthy"
  | "validating"
  | "syncing"
  | "degraded"
  | "failing"
  | "disabled"
  | "pending-configuration";

export interface ConnectorHealth {
  connectorId: string;
  source: "jira" | "github" | "testrail" | "confluence" | "reportportal";
  status: ConnectorStatus;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  recordsSyncedLast24h: number;
  errorRateLast24h: number;
  /**
   * Credential reference/status only — never a token value. `not_configured` applies to
   * connectors awaiting product configuration/credential setup (see `pending-configuration`
   * status).
   */
  credentialStatus: "valid" | "expiring" | "invalid" | "missing" | "not_configured";
  message?: string;
}

export interface RequirementRef {
  id: string;
  title: string;
  source: "jira";
  /** Not always available from the real API yet (no per-entity URL surfaced today). */
  url?: string;
  provenance: Provenance;
}

export type TestType = "manual" | "automated";

export interface TestRef {
  id: string;
  title: string;
  source: "github" | "testrail";
  type: TestType;
  /** Not always available from the real API yet (no per-entity URL surfaced today). */
  url?: string;
  /**
   * The real API does not yet expose per-test execution status directly on the entity
   * (only aggregate coverage/freshness per requirement) — defaults to `"unknown"` when
   * backed by the HTTP client.
   */
  status: "passing" | "failing" | "missing" | "unknown";
  /**
   * ISO timestamp of the latest execution; `null` means confirmed not executed, while
   * `undefined` means the API does not expose per-test execution evidence.
   */
  lastExecutedAt?: string | null;
  provenance: Provenance;
}

export type LinkConfidence = "explicit" | "inferred-high" | "inferred-low";

export interface TraceLink {
  requirementId: string;
  testId: string;
  confidence: LinkConfidence;
  /** Human-review state; `null` means the API has not supplied review evidence. */
  reviewed: boolean | null;
}

export interface StoryTraceability {
  storyId: string;
  storyTitle: string;
  productId: string;
  issueType?: string;
  status?: string;
  relatedRequirementCount?: number;
  returnedRequirementCount?: number;
  truncated?: boolean;
  requirements: RequirementRef[];
  tests: TestRef[];
  links: TraceLink[];
}

export type TicketContextJobState =
  | "pending"
  | "running"
  | "complete"
  | "partial"
  | "unavailable"
  | "cancelled";

export type TicketContextSourceState =
  | "local"
  | "refreshed"
  | "pending"
  | "running"
  | "complete"
  | "partial"
  | "unavailable"
  | "not-connected"
  | "cancelled";

export interface TicketContextSourceStatus {
  state: TicketContextSourceState;
  startedAt: string | null;
  completedAt: string | null;
  attemptCount: number;
  recordsCollected: number;
  truncated: boolean;
  error: { code: string; message: string } | null;
}

export interface TicketContextCompleteness {
  status: "pending" | "complete" | "partial" | "unavailable" | "cancelled";
  complete: boolean;
  reasons: string[];
}

export interface TicketContextJob {
  productId: string;
  issueKey: string;
  state: TicketContextJobState;
  createdAt: string;
  updatedAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  attemptCount: number;
  nextRetryAt: string | null;
  sources: {
    jira: TicketContextSourceStatus;
    testrail: TicketContextSourceStatus;
    github: TicketContextSourceStatus;
  };
  completeness: TicketContextCompleteness;
}

export interface TicketContextOperationJobStates {
  pending: number;
  running: number;
  complete: number;
  partial: number;
  unavailable: number;
  cancelled: number;
}

export type TicketContextInvalidationDisposition =
  | "accepted"
  | "duplicate"
  | "obsolete"
  | "not-hot"
  | "rejected";

export interface TicketContextOperationFailure {
  at: string;
  code: string;
}

export interface TicketContextOperations {
  health: {
    status: "healthy" | "degraded";
    reasons: string[];
  };
  durable: {
    jobStates: TicketContextOperationJobStates;
    totalJobs: number;
    deliveryReceipts: number;
  };
  memory: {
    queued: number;
    active: number;
    delayedRetry: number;
    paused: boolean;
    oldestQueuedAgeMs: number | null;
  };
  attempts: number;
  retries: number;
  capacity: {
    used: number;
    max: number;
    percent: number;
  };
  lastSuccessfulCompletion: string | null;
  lastWorkerFailure: TicketContextOperationFailure | null;
  lastPersistenceFailure: TicketContextOperationFailure | null;
  invalidations: {
    dispositions: Record<TicketContextInvalidationDisposition, number>;
    last: {
      source: string;
      observedAt: string | null;
      receivedAt: string;
      disposition: TicketContextInvalidationDisposition;
    } | null;
  };
  lastRetentionSweep: {
    startedAt: string;
    completedAt: string;
    jobsDeleted: number;
    receiptsDeleted: number;
  } | null;
}

export interface CoverageGap {
  requirementId: string;
  requirementTitle: string;
  storyId: string;
  numerator: number;
  denominator: number;
  /**
   * The real coverage endpoint returns a numeric `linkConfidence` (0-1), not a labeled
   * bucket. The HTTP client buckets it: `>=0.9` → `explicit`, `>=0.5` → `inferred-high`,
   * otherwise `inferred-low`; `none` when there is nothing to cover (`denominator === 0`).
   */
  linkConfidence: LinkConfidence | "none";
}

/** Mirrors the real API's `ConflictRecord` (`packages/contracts`), which does not yet
 * expose expanded claim values through `/v1/knowledge/conflicts` — only the reason,
 * detection time, and open/reviewed status. */
export type ConflictStatus = "open" | "reviewed";

export interface KnowledgeConflict {
  id: string;
  entityId: string;
  /** Falls back to `entityId` when the real API doesn't resolve a human-readable title. */
  entityTitle: string;
  description: string;
  detectedAt: string;
  status: ConflictStatus;
  /**
   * Raw claim IDs referenced by the conflict, from the real API's `ConflictRecord.claimIds`.
   * The API does not expose expanded claim content, so the review UI can only let a
   * reviewer choose which claim ID(s) to approve, not compare claim values.
   */
  claimIds: string[];
}

/**
 * Request body for the approved TKL review endpoint
 * (`POST /v1/knowledge/conflicts/review`, UI-104). `reviewerId`/`reviewedAt` are derived
 * server-side from the authenticated subject and are never supplied by the client.
 */
export interface ConflictReviewRequest {
  conflictId: string;
  approvedClaimIds: string[];
  note?: string;
}

export type ApprovedActionType =
  | "testrail.case.create"
  | "testrail.case.update"
  | "github.branch.create"
  | "github.pull-request.create";

export interface ApprovedActionSourceVersion {
  source: "jira" | "testrail" | "github";
  sourceId: string;
  sourceVersion: string;
}

export interface ApprovedActionPreviewRequest {
  actionType: ApprovedActionType;
  target: Record<string, unknown>;
  changes: Record<string, unknown>;
  sourceVersions: ApprovedActionSourceVersion[];
  idempotencyKey: string;
}

export interface ApprovedActionPreview {
  id: string;
  productId: string;
  subject: string;
  actionType: ApprovedActionType;
  target: Record<string, unknown>;
  changes: Record<string, unknown>;
  sourceVersions: ApprovedActionSourceVersion[];
  requiredPermission: string;
  previewHash: string;
  risk: "medium" | "high";
  summary: string;
  executable: boolean;
  executionStatus: "ready" | "blocked";
  blockReason: { code: string; message: string } | null;
  createdAt: string;
  expiresAt: string;
}

export interface ApprovedActionApproval {
  id: string;
  previewId: string;
  previewHash: string;
  productId: string;
  subject: string;
  actionType: ApprovedActionType;
  requiredPermission: string;
  status: "approved" | "consumed";
  approvedAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface ApprovedActionExecution {
  id: string;
  approvalId: string;
  previewId: string;
  previewHash: string;
  productId: string;
  subject: string;
  actionType: ApprovedActionType;
  status: "blocked" | "succeeded" | "failed";
  externalCallMade: boolean;
  reason: { code: string; message: string } | null;
  result?: {
    source: string;
    externalId: string;
    url: string;
    title: string;
  };
  attemptedAt: string;
  completedAt: string | null;
  recovery: { required: boolean; instructions: string };
}

export interface EvaluationMetrics {
  datasetVersion: string;
  ticketCount: number;
  precision: number;
  recall: number;
  provenanceCompleteness: number;
  freshnessHours: number;
  latencyMsP50: number;
  latencyMsP95: number;
  qaAcceptanceRate: number;
}

export interface AgentFinding {
  id: string;
  severity: "low" | "medium" | "high";
  category: "knowledge-gap" | "coverage-gap" | "freshness-gap";
  title: string;
  detail: string;
  evidenceIds: string[];
}

export interface AgentRecommendation {
  id: string;
  priority: "low" | "medium" | "high";
  action: string;
  rationale: string;
}

export interface CoverageContextAgentRun {
  runId: string;
  agent: {
    id: "agent.coverage-context";
    version: string;
    capabilities?: string[];
    mode?: "read-only";
  };
  productId: string;
  workItemId: string;
  generatedAt: string;
  status: "not-found" | "insufficient-context" | "ready-for-review";
  confidence: {
    level: "none" | "low" | "medium" | "high";
    rationale: string;
  };
  summary: string;
  findings: AgentFinding[];
  recommendations: AgentRecommendation[];
  evidence: {
    sources: string[];
    requirements: Array<{ id: string; title: string }>;
    tests: Array<{ id: string; title: string; type: string }>;
    relationships: Array<{ id: string; fromEntityId: string; toEntityId: string; type: string }>;
    citations: Array<{
      source: string;
      sourceId: string;
      sourceVersion: string;
      observedAt: string;
    }>;
  };
  limitations: string[];
}

export interface TestDesignerAgentRun {
  runId: string;
  agent: {
    id: "agent.test-designer";
    version: string;
    capabilities?: string[];
    mode?: "proposal-only";
  };
  productId: string;
  workItemId: string;
  generatedAt: string;
  status: "not-found" | "insufficient-context" | "ready-for-review";
  confidence: {
    level: "none" | "low" | "medium" | "high";
    rationale: string;
  };
  summary: string;
  proposals: Array<{
    id: string;
    disposition: "propose-new" | "review-existing";
    title: string;
    objective: string;
    preconditions: string[];
    steps: Array<{ order: number; action: string; expectedResult: string }>;
    expectedResult: string;
    requirementIds: string[];
    duplicateCandidates: Array<{
      id: string;
      title: string;
      similarity: number;
      preconditions?: string;
      steps?: Array<{ action: string; expectedResult: string }>;
    }>;
    referenceCases?: Array<{
      id: string;
      title: string;
      similarity: number;
      preconditions?: string;
      steps?: Array<{ action: string; expectedResult: string }>;
    }>;
    automationSuitability?: {
      status: "candidate" | "needs-details";
      rationale: string;
      blockers: string[];
      reusedCaseId: string | null;
    };
    confidence: { level: "low" | "high"; rationale: string };
    citations: Array<{
      source: string;
      sourceId: string;
      sourceVersion: string;
      observedAt: string;
    }>;
  }>;
  evidence: {
    sources: string[];
    requirements: Array<{ id: string; title: string }>;
    existingManualTests: Array<{ id: string; title: string }>;
    citations: Array<{
      source: string;
      sourceId: string;
      sourceVersion: string;
      observedAt: string;
    }>;
  };
  limitations: string[];
}

export interface TestRailImprovementAgentRun {
  runId: string;
  agent: {
    id: "agent.testrail-improvement";
    version: string;
    capabilities?: string[];
    mode?: "proposal-only";
  };
  productId: string;
  workItemId: string;
  caseId?: string;
  generatedAt: string;
  status: "not-found" | "insufficient-context" | "ready-for-review";
  confidence: {
    level: "none" | "low" | "medium" | "high";
    rationale: string;
  };
  summary: string;
  proposals: Array<{
    id: string;
    caseId: string;
    title: string;
    disposition: "propose-edit" | "review-duplicate";
    requirementIds: string[];
    findings: Array<{
      id: string;
      category:
        | "missing-preconditions"
        | "missing-steps"
        | "missing-expected-results"
        | "missing-requirement-mapping"
        | "duplicate-intent";
      severity: "low" | "medium" | "high";
      detail: string;
      evidenceIds: string[];
    }>;
    fieldDiffs: Array<{
      field: string;
      before: unknown;
      after: unknown;
      rationale: string;
      confidence: {
        level: "low" | "medium";
        rationale: string;
      };
      citations: AgentCitation[];
    }>;
    duplicateCandidates: Array<{
      id: string;
      title: string;
      similarity: number;
      citations: AgentCitation[];
    }>;
    confidence: {
      level: "low" | "medium";
      rationale: string;
    };
    citations: AgentCitation[];
  }>;
  evidence: {
    sources: string[];
    requirements: Array<{ id: string; title: string }>;
    manualTests: Array<{ id: string; title: string }>;
    relationships: Array<{ id: string; fromEntityId: string; toEntityId: string; type: string }>;
    candidateRelationships?: Array<{
      id: string;
      fromEntityId: string;
      toEntityId: string;
      type: "similar_to";
      origin: "inferred";
      confidence: number;
      status: "review-required";
      rationale: string;
    }>;
    sourceStatus?: Record<string, {
      state: string;
      connected: boolean;
      hydrated: boolean;
      linked: boolean;
      recordsCollected: number;
      truncated: boolean;
      detail: string;
    }>;
    retrievals?: Array<{
      source: string;
      status?: string;
      recordsCollected?: number;
      truncated?: boolean;
    }>;
    citations: AgentCitation[];
  };
  limitations: string[];
}

export interface AutomationDesignerAgentRun {
  runId: string;
  agent: {
    id: "agent.automation-designer";
    version: string;
    capabilities?: string[];
    mode?: "proposal-only";
  };
  productId: string;
  workItemId: string;
  generatedAt: string;
  status: "not-found" | "insufficient-context" | "ready-for-review";
  confidence: {
    level: "none" | "low" | "medium" | "high";
    rationale: string;
  };
  summary: string;
  proposal: {
    delivery: "review-only";
    codeGeneration: {
      status: "abstained" | "not-requested";
      rationale: string;
    };
    filePlan: Array<{
      id: string;
      action: "extend" | "discover-before-create";
      targetPath: string;
      sourceCaseIds: string[];
      requirementIds: string[];
      rationale: string;
      evidenceIds: string[];
      citations: AgentCitation[];
    }>;
    codeOutline: Array<{
      sourceCaseId: string;
      title: string;
      requirementIds: string[];
      sections: {
        setup: string[];
        actions: string[];
        assertions: string[];
      };
      implementationNote: string;
      citations: AgentCitation[];
    }>;
    reusableComponents: Array<{
      path: string;
      role: "page-object" | "fixture" | "utility";
      confidence: { level: "low" | "medium" | "high"; rationale: string };
      rationale: string;
      citations: AgentCitation[];
    }>;
    requiredTestData: Array<{
      id: string;
      description: string;
      sourceCaseId: string;
      status: "review-required";
      citations: AgentCitation[];
    }>;
    validationCommands: Array<{
      command: string;
      workingDirectory: string;
      rationale: string;
      citations: AgentCitation[];
    }>;
    conventions: {
      testDirectories: string[];
      testFileSuffixes: string[];
      fileExtensions: string[];
      frameworkSignals: string[];
    };
    discoveryTasks: Array<{
      id: string;
      action: string;
      rationale: string;
      evidenceIds: string[];
    }>;
  };
  evidence: {
    sources: string[];
    requirements: Array<{ id: string; title: string }>;
    manualCases: Array<{
      id: string;
      title: string;
      origin: "approved" | "proposed";
      source: "testrail" | "test-designer";
      requirementIds: string[];
      citations: AgentCitation[];
    }>;
    automatedTests: Array<{ id: string; title: string }>;
    repositoryFiles: Array<{
      id: string;
      repository?: string;
      path: string;
      role: "test" | "page-object" | "fixture" | "utility" | "configuration" | "other";
      contentAvailable: boolean;
      provenance: AgentCitation;
    }>;
    citations: AgentCitation[];
  };
  limitations: string[];
}

export type ReliabilityClassification =
  | "insufficient-history"
  | "likely-flaky"
  | "consistently-failing-product-risk"
  | "environment-infrastructure-signal"
  | "healthy";

export interface ReliabilityDefectIntelligenceAgentRun {
  runId: string;
  agent: {
    id: "agent.reliability-defect-intelligence";
    version: string;
    capabilities?: string[];
    mode?: "proposal-only";
  };
  productId: string;
  workItemId: string;
  identity?: string;
  generatedAt: string;
  status: "not-found" | "insufficient-context" | "ready-for-review";
  confidence: {
    level: "none" | "low" | "medium" | "high";
    rationale: string;
  };
  summary: string;
  analyses: Array<{
    identity: {
      type: "codeRef" | "name";
      value: string;
      key: string;
    };
    title: string;
    classification: ReliabilityClassification;
    confidence: {
      level: "low" | "medium" | "high";
      rationale: string;
    };
    rationale: string;
    aggregates: {
      independentRuns: number;
      observedAttempts: number;
      passedRuns: number;
      failedRuns: number;
      otherRuns: number;
      failureRate: number | null;
      transitions: number;
      retryRuns: number;
      environmentFailureRuns: number;
      unknownStatusCounts: Record<string, number>;
      durationMs: {
        minimum: number | null;
        maximum: number | null;
        average: number | null;
      };
      firstSeenAt: string | null;
      lastSeenAt: string | null;
      statusSequence: Array<"passed" | "failed" | "other">;
      trend: {
        direction: "regression" | "improving" | "stable" | "insufficient-history";
        delta: number | null;
        earlierFailureRate: number | null;
        recentFailureRate: number | null;
      };
    };
    timeline: Array<{
      launchId: string;
      startedAt: string | null;
      endedAt: string | null;
      status: string;
      outcome: "passed" | "failed" | "other";
      durationMs: number | null;
      attempts: Array<{
        executionId: string;
        status: string;
        retry: boolean | number;
        startedAt: string | null;
        durationMs: number | null;
      }>;
      retryAttemptCount: number;
      issueTypes: string[];
      environmentSignals: string[];
      environmentAttributes: string[];
      externalIssueKeys: string[];
      evidenceIds: string[];
      citations: AgentCitation[];
    }>;
    linkedJiraDefects: Array<{
      id: string;
      title: string;
      issueType?: string;
      status?: string;
      citations: AgentCitation[];
    }>;
    recommendations: ReliabilityRecommendation[];
    citations: AgentCitation[];
    limitations: string[];
  }>;
  recommendations: ReliabilityRecommendation[];
  evidence: {
    sources: string[];
    requirements: Array<{ id: string; title: string }>;
    reportPortalExecutions: Array<{
      execution: { id: string; title: string };
      launchId: string;
      status: string;
      startedAt?: string;
      endedAt?: string;
      duration?: number;
      codeRef?: string;
      retry?: boolean | number;
      issueType?: string;
      attributes: Array<{ key?: string; value: string }>;
      externalIssueKeys: string[];
      stableIdentity: { type: "codeRef" | "name"; value: string; key: string };
    }>;
    jiraDefects: Array<{ id: string; title: string }>;
    citations: AgentCitation[];
  };
  limitations: string[];
}

export interface ReliabilityRecommendation {
  id: string;
  testIdentity: string;
  kind: "improvement" | "regression-prevention";
  priority: "low" | "medium" | "high";
  action: string;
  rationale: string;
  citations: AgentCitation[];
}

export interface AgentCitation {
  source: string;
  sourceId: string;
  sourceVersion: string;
  observedAt: string;
  contentHash?: string;
  normalizerId?: string;
  normalizerVersion?: string;
}

export type KnowledgeCurationCategory =
  | "open-conflict"
  | "duplicate-entity"
  | "duplicate-intent"
  | "missing-trace-link"
  | "stale-claim"
  | "stale-business-rule";

export interface KnowledgeCuratorAgentRun {
  runId: string;
  agent: {
    id: "agent.knowledge-curator";
    version: string;
    capabilities?: string[];
    mode?: "proposal-only";
  };
  productId: string;
  workItemId: string;
  generatedAt: string;
  scope: {
    rootRequirementId: string;
    requirementIds: string[];
    productId: string;
  };
  status: "not-found" | "insufficient-context" | "ready-for-review";
  confidence: {
    level: "none" | "low" | "medium" | "high";
    rationale: string;
  };
  summary: string;
  findings: Array<{
    id: string;
    category: KnowledgeCurationCategory;
    severity: "low" | "medium" | "high";
    title: string;
    detail: string;
    entityIds: string[];
    claimIds: string[];
    evidenceIds: string[];
    confidence: {
      level: "low" | "medium" | "high";
      rationale: string;
    };
    citations: AgentCitation[];
    preview: {
      before: unknown;
      action: string;
      after: unknown;
    };
    disposition: "propose-review" | "abstain";
    limitations: string[];
  }>;
  proposals: Array<{
    id: string;
    findingId: string;
    kind:
      | "conflict-resolution"
      | "entity-merge"
      | "intent-merge"
      | "trace-mapping"
      | "stale-claim-review"
      | "business-rule-review";
    disposition: "propose-review" | "abstain";
    title: string;
    rationale: string;
    confidence: {
      level: "low" | "medium" | "high";
      rationale: string;
    };
    evidenceIds: string[];
    citations: AgentCitation[];
    preview: {
      before: unknown;
      action: string;
      after: unknown;
    };
    limitations: string[];
    approval: KnowledgeCuratorApproval;
  }>;
  evidence: {
    sources: string[];
    requirements: Array<{
      id: string;
      title: string;
      provenance?: AgentCitation | AgentCitation[];
    }>;
    entities: Array<{
      id: string;
      type: string;
      title: string;
      provenance?: AgentCitation | AgentCitation[];
    }>;
    claims: Array<{
      id: string;
      entityId: string;
      attribute: string;
      value: unknown;
      confidence: number;
      status: string;
      provenance?: AgentCitation | AgentCitation[];
    }>;
    traceLinks: Array<{
      id: string;
      fromEntityId: string;
      toEntityId: string;
      type: string;
      confidence: number;
      provenance?: AgentCitation | AgentCitation[];
    }>;
    openConflicts: Array<{
      id: string;
      entityId: string;
      claimIds: string[];
      reason: string;
    }>;
    unresolvedTraceLinks: Array<{
      id: string;
      fromEntityId: string;
      toEntityId: string;
      type: string;
    }>;
    citations: AgentCitation[];
  };
  limitations: string[];
  approval: KnowledgeCuratorApproval;
}

export type AskTklIntent =
  | "coverage-context"
  | "test-design"
  | "testrail-improvement"
  | "automation-design"
  | "reliability"
  | "knowledge-curation"
  | "knowledge-search"
  | "unsupported";

export interface AskTklRequest {
  question: string;
  workItemId?: string;
}

export interface AskTklRun {
  runId: string;
  agent: {
    id: "agent.ask-tkl";
    version: string;
    capabilities?: string[];
    mode?: "read-only";
  };
  productId: string;
  question: string;
  workItemId?: string;
  generatedAt: string;
  intent: {
    primary: AskTklIntent;
    matched: AskTklIntent[];
  };
  scope: {
    productId: string;
    workItemId?: string;
    interpretation: string;
  };
  status: "answered" | "insufficient-context" | "not-found" | "abstained";
  answer: string;
  citations: Array<{
    id: string;
    source: string;
    sourceId: string;
    sourceVersion: string;
    observedAt: string;
    sourceUrl?: string;
    resourceUri: string;
    href: string;
  }>;
  freshness: {
    status: "current" | "mixed" | "stale" | "unknown";
    asOf: string;
    newestObservedAt: string | null;
    oldestObservedAt: string | null;
    staleCitationCount: number;
    thresholdDays: number;
  };
  confidence: {
    level: "none" | "low" | "medium" | "high";
    rationale: string;
  };
  conflicts: Array<{
    id: string;
    entityId: string;
    reason: string;
  }>;
  limitations: string[];
  nextActions: string[];
  toolCalls: Array<{
    capability: string;
    status: string;
    summary: string;
  }>;
  evidenceMode?: "documented" | "code" | "live-observed" | "combined";
  investigation?: {
    required: boolean;
    status: "planned" | "completed" | "not-enabled" | "not-required";
    stopReason: string | null;
    steps: string[];
    scope: {
      workItemId?: string;
      caseId?: string;
    };
  };
  claims?: Array<{
    type: "fact" | "finding" | "inference";
    text: string;
    evidence: string | null;
  }>;
}

export interface KnowledgeCuratorApproval {
  required: true;
  role: "knowledge-reviewer";
  allowedActions?: Array<"approve" | "reject" | "request-evidence">;
  statement?: string;
}

export type SourceConnectionId =
  | "jira"
  | "github"
  | "testrail"
  | "confluence"
  | "reportportal";

export type SourceConnectionStatus =
  | "not-connected"
  | "validating"
  | "connected"
  | "syncing"
  | "stale"
  | "authorization-expired"
  | "error"
  | "disabled";

export interface SourceConnectionError {
  code: string;
  category: "authorization" | "configuration" | "network" | "provider" | "internal";
  message: string;
}

export type GitHubRepositoryPurpose =
  | "application"
  | "test-automation"
  | "quality-evidence"
  | "documentation"
  | "shared-library"
  | "other";

export type GitHubRepositoryLifecycle =
  | "active"
  | "maintenance"
  | "deprecated"
  | "archived";

export type GitHubRepositoryValidationStatus =
  | "pending"
  | "validating"
  | "valid"
  | "failed";

export type GitHubRepositorySyncStatus =
  | "idle"
  | "syncing"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface GitHubRepository {
  id: string;
  repository: string;
  url: string;
  purpose: GitHubRepositoryPurpose;
  lifecycle: GitHubRepositoryLifecycle;
  enabled: boolean;
  validationStatus: GitHubRepositoryValidationStatus;
  syncStatus: GitHubRepositorySyncStatus;
  lastValidatedAt: string | null;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  recordsCollected: number;
  error: SourceConnectionError | null;
}

export interface SourceConnection {
  source: SourceConnectionId;
  displayName: string;
  status: SourceConnectionStatus;
  ownerSubject: string | null;
  configured: boolean;
  ingestionSupported: boolean;
  config: Record<string, string | string[]>;
  connectedAt: string | null;
  lastValidatedAt: string | null;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  error: SourceConnectionError | null;
  repositories?: GitHubRepository[];
}

export interface SaveSourceConnectionRequest {
  credential: string;
  config: Record<string, string | string[]>;
}

export interface CreateGitHubRepositoryRequest {
  id?: string;
  repository: string;
  url?: string;
  purpose?: GitHubRepositoryPurpose;
  lifecycle?: GitHubRepositoryLifecycle;
  enabled?: boolean;
}

export interface UpdateGitHubRepositoryRequest {
  repository?: string;
  url?: string;
  purpose?: GitHubRepositoryPurpose;
  lifecycle?: GitHubRepositoryLifecycle;
  enabled?: boolean;
}

export interface TestRailSuite {
  id: string;
  name: string;
  isCompleted: boolean;
}

export interface TestRailSection {
  id: string;
  suiteId: string;
  parentId: string | null;
  depth: number;
  name: string;
}

export interface DiscoverTestRailSuitesRequest {
  credential: string;
  config: {
    baseUrl: string;
    username: string;
    projectId: string;
  };
}

export interface ConfluenceRootPage {
  id: string;
  title: string;
  spaceKey: string;
  url: string;
}

export interface ConfluencePageDiscovery {
  baseUrl: string;
  authMode: "basic" | "bearer";
  roots: ConfluenceRootPage[];
}

export interface DiscoverConfluencePagesRequest {
  credential: string;
  config: {
    username: string;
    rootPageUrls: string[];
    authMode?: "basic" | "bearer";
  };
}

/**
 * Knowledge Inventory / Quality Overview (UI-105) — dashboard projection of the API
 * `GET /v1/intelligence/knowledge-inventory` aggregate. Every tier carries an
 * `available` flag; counts are `null` (not fabricated zeros) when a tier is unavailable.
 */
export type KnowledgeInventorySourceId =
  | "jira"
  | "github"
  | "testrail"
  | "confluence"
  | "reportportal";

export interface KnowledgeInventorySourceRow {
  source: string;
  retainedRecords: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  connectorIds: string[];
}

export interface KnowledgeInventoryCollectedEvidence {
  available: boolean;
  totalRetainedRecords: number | null;
  bySource: KnowledgeInventorySourceRow[];
  pendingProjection: { total: number | null; attributable: boolean };
  deadLetter: { total: number | null; bySource: Array<{ source: string; count: number }> };
  filteredSource?: string;
}

export interface KnowledgeInventoryCanonical {
  available: boolean;
  entities: { total: number | null; byType: Record<string, number> };
  claims: { total: number | null; byStatus: Record<string, number> };
  traceLinks: { total: number | null; deferred: number | null; byType: Record<string, number> };
  conflicts: { total: number | null; open: number | null };
  reviews: { total: number | null };
  bySource: Array<{ source: string; entityCount: number }>;
}

export interface KnowledgeInventoryCoverage {
  available: boolean;
  requirementTotal: number | null;
  withManual: number | null;
  withAutomation: number | null;
  withBoth: number | null;
  withNeither: number | null;
  unmappedTests: number | null;
  verifyLinkTotal: number | null;
  averageVerifyLinkConfidence: number | null;
  manualCoverageRatio: number | null;
  automationCoverageRatio: number | null;
  mappedCoverageRatio: number | null;
  model: {
    numerator: string;
    denominator: string;
    trustSignal: string;
    confidenceThreshold: number | null;
    confidenceThresholdNote?: string;
  };
}

export interface KnowledgeInventoryPipeline {
  available: boolean;
  servingProjectionBacklog: number | null;
  servingCurrent: boolean | null;
  rawProjectionBacklog: number | null;
  rawDeadLetterBacklog: number | null;
}

export interface KnowledgeInventorySyncSource {
  source: string;
  displayName: string;
  status: string;
  configured: boolean;
  connected: boolean;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  error: { code?: string; message?: string } | null;
}

export interface KnowledgeInventorySyncStatus {
  available: boolean;
  sources: KnowledgeInventorySyncSource[];
  note: string;
}

export type KnowledgeInventoryGapSeverity = "high" | "medium" | "low";

export interface KnowledgeInventoryGap {
  id: string;
  category: string;
  severity: KnowledgeInventoryGapSeverity;
  count: number;
  title: string;
  recommendedAction: string;
}

export interface KnowledgeInventory {
  productId: string;
  generatedAt: string;
  source: string | null;
  collectedEvidence: KnowledgeInventoryCollectedEvidence;
  canonicalKnowledge: KnowledgeInventoryCanonical;
  coverage: KnowledgeInventoryCoverage;
  pipeline: KnowledgeInventoryPipeline;
  syncStatus: KnowledgeInventorySyncStatus;
  actionableGaps: KnowledgeInventoryGap[];
  freshness: { newestObservedAt: string | null; oldestObservedAt: string | null };
  meta: {
    generatedAt: string;
    partial: boolean;
    truncated: boolean;
    notes: string[];
    limitations: string[];
  };
}
