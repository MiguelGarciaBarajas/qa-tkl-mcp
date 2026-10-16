/**
 * Thin client seam between the dashboard UI and the TKL Application API / MCP gateway.
 *
 * `MockTklApiClient` remains for isolated tests and local dev without a running API.
 * `HttpTklApiClient` (`./httpClient.ts`) is the real client, used whenever
 * `VITE_TKL_API_BASE_URL` is configured (see `./config.ts`). Pages depend on the
 * `TklApiClient` interface, not on either implementation directly, so switching between
 * them requires no page changes — only `getTklApiClient()` below.
 */
import type {
  AskTklRequest,
  AskTklRun,
  ArtifactResolution,
  ApprovedActionApproval,
  ApprovedActionExecution,
  ApprovedActionPreview,
  ApprovedActionPreviewRequest,
  AutomationDesignerAgentRun,
  ConflictReviewRequest,
  CoverageContextAgentRun,
  ConnectorHealth,
  ConfluencePageDiscovery,
  CreateGitHubRepositoryRequest,
  CoverageGap,
  DiscoverConfluencePagesRequest,
  DiscoverTestRailSuitesRequest,
  EvaluationMetrics,
  KnowledgeConflict,
  KnowledgeCuratorAgentRun,
  KnowledgeInventory,
  ReliabilityDefectIntelligenceAgentRun,
  EvidenceGraph,
  GitHubRepository,
  SaveSourceConnectionRequest,
  SourceConnection,
  SourceConnectionId,
  StoryTraceability,
  TestRailSuite,
  TestRailSection,
  TicketContextJob,
  TicketContextOperations,
  TestDesignerAgentRun,
  TestRailImprovementAgentRun,
  UpdateGitHubRepositoryRequest,
} from "../contracts/types";
import {
  mockConnectorHealth,
  mockCoverageGaps,
  mockEvaluationMetrics,
  mockKnowledgeConflicts,
  mockKnowledgeInventory,
  mockSourceConnections,
  mockStoryTraceability,
  mockTicketContextJob,
  mockTicketContextOperations,
} from "../mocks/fixtures";
import { getDashboardApiConfig } from "./config";
import type { DashboardApiConfig } from "./config";
import { HttpTklApiClient } from "./httpClient";

export interface TklApiClient {
  resolveArtifacts(query: string): Promise<ArtifactResolution>;
  getEvidenceGraph?(entityId: string): Promise<EvidenceGraph>;
  askTkl(request: AskTklRequest): Promise<AskTklRun>;
  previewApprovedAction?(request: ApprovedActionPreviewRequest): Promise<ApprovedActionPreview>;
  approveAction?(preview: ApprovedActionPreview): Promise<ApprovedActionApproval>;
  executeApprovedAction?(
    preview: ApprovedActionPreview,
    approval: ApprovedActionApproval,
  ): Promise<ApprovedActionExecution>;
  getConnectorHealth(): Promise<ConnectorHealth[]>;
  getTicketContextOperations(): Promise<TicketContextOperations>;
  getStoryTraceability(query?: string): Promise<StoryTraceability[]>;
  getTicketContextJob(issueKey: string): Promise<TicketContextJob | null>;
  refreshTicketContext(issueKey: string): Promise<TicketContextJob>;
  cancelTicketContext(issueKey: string): Promise<TicketContextJob>;
  getCoverageGaps(query?: string): Promise<CoverageGap[]>;
  getKnowledgeInventory(source?: string): Promise<KnowledgeInventory>;
  getKnowledgeConflicts(): Promise<KnowledgeConflict[]>;
  /**
   * Records a human reviewer's decision on an open conflict via the approved TKL review
   * endpoint (`POST /v1/knowledge/conflicts/review`, UI-104). Returns the updated conflict
   * (`status: "reviewed"`). Rejects if the conflict is unknown or already reviewed.
   */
  reviewKnowledgeConflict(request: ConflictReviewRequest): Promise<KnowledgeConflict>;
  getEvaluationMetrics(): Promise<EvaluationMetrics>;
  runCoverageContextAgent(workItemId: string): Promise<CoverageContextAgentRun>;
  runTestDesignerAgent(
    workItemId: string,
    target?: { suiteId: string; sectionId: string },
  ): Promise<TestDesignerAgentRun>;
  runTestRailImprovementAgent(workItemId: string): Promise<TestRailImprovementAgentRun>;
  runTestRailCaseImprovementAgent?(caseId: string): Promise<TestRailImprovementAgentRun>;
  runAutomationDesignerAgent(workItemId: string): Promise<AutomationDesignerAgentRun>;
  runReliabilityDefectIntelligenceAgent(
    workItemId: string,
  ): Promise<ReliabilityDefectIntelligenceAgentRun>;
  runReportPortalReliabilityAgent?(
    identity: string,
  ): Promise<ReliabilityDefectIntelligenceAgentRun>;
  runKnowledgeCuratorAgent(workItemId: string): Promise<KnowledgeCuratorAgentRun>;
  getSourceConnections(): Promise<SourceConnection[]>;
  getGitHubRepositories(): Promise<GitHubRepository[]>;
  getGitHubRepository(repositoryId: string): Promise<GitHubRepository>;
  createGitHubRepository(request: CreateGitHubRepositoryRequest): Promise<GitHubRepository>;
  updateGitHubRepository(
    repositoryId: string,
    request: UpdateGitHubRepositoryRequest,
  ): Promise<GitHubRepository>;
  deleteGitHubRepository(repositoryId: string): Promise<GitHubRepository>;
  testGitHubRepository(repositoryId: string): Promise<GitHubRepository>;
  syncGitHubRepository(repositoryId: string): Promise<GitHubRepository>;
  cancelGitHubRepositorySync(repositoryId: string): Promise<GitHubRepository>;
  discoverTestRailSuites(request: DiscoverTestRailSuitesRequest): Promise<TestRailSuite[]>;
  discoverTestRailSections?(suiteId: string): Promise<TestRailSection[]>;
  discoverConfluencePages(
    request: DiscoverConfluencePagesRequest,
  ): Promise<ConfluencePageDiscovery>;
  saveSourceConnection(
    source: SourceConnectionId,
    request: SaveSourceConnectionRequest,
  ): Promise<SourceConnection>;
  testSourceConnection(source: SourceConnectionId): Promise<SourceConnection>;
  syncSourceConnection(source: SourceConnectionId): Promise<SourceConnection>;
  cancelSourceConnectionSync(source: SourceConnectionId): Promise<SourceConnection>;
  disconnectSourceConnection(source: SourceConnectionId): Promise<SourceConnection>;
}

/** Simulates network latency so loading states are visible during development. */
function delay<T>(value: T, ms = 150): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function permissionForAction(actionType: ApprovedActionPreviewRequest["actionType"]): string {
  return {
    "testrail.case.create": "actions:testrail-case-create",
    "testrail.case.update": "actions:testrail-case-update",
    "github.branch.create": "actions:github-branch-create",
    "github.pull-request.create": "actions:github-pull-request-create",
  }[actionType];
}

export class MockTklApiClient implements TklApiClient {
  private readonly reviewedConflicts = new Map<string, KnowledgeConflict>();
  private readonly ticketContextJobs = new Map<string, TicketContextJob>([
    [mockTicketContextJob.issueKey, structuredClone(mockTicketContextJob)],
  ]);
  private readonly sourceConnections = new Map<SourceConnectionId, SourceConnection>(
    mockSourceConnections.map((connection) => [
      connection.source,
      {
        ...connection,
        repositories: connection.repositories?.map((repository) => ({ ...repository })),
      },
    ]),
  );
  private readonly githubRepositories = new Map(
    (mockSourceConnections.find((connection) => connection.source === "github")?.repositories ?? [])
      .map((repository) => [repository.id, { ...repository }]),
  );
  private readonly repositorySyncs = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void }
  >();
  private readonly sourceSyncs = new Map<
    SourceConnectionId,
    { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void }
  >();

  resolveArtifacts(query: string): Promise<ArtifactResolution> {
    const trimmed = query.trim();
    const jira = /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(trimmed);
    const testRail = /^C?\d+$/i.test(trimmed);
    return delay({
      productId: "fl-titling",
      query: trimmed,
      detected: {
        kind: jira ? "jira-key" : testRail ? "testrail-case-id" : "text",
        source: jira ? "jira" : testRail ? "testrail" : null,
        lookupValue: jira ? trimmed.toUpperCase() : trimmed.replace(/^C/i, ""),
        exact: jira || testRail,
      },
      status: "not-found",
      selected: null,
      candidates: [],
    });
  }

  getEvidenceGraph(entityId: string): Promise<EvidenceGraph> {
    return delay({
      productId: "fl-titling",
      anchorId: entityId,
      nodes: [],
      edges: [],
      truncated: false,
    });
  }

  askTkl(request: AskTklRequest): Promise<AskTklRun> {
    const generatedAt = new Date().toISOString();
    return delay({
      runId: "mock-ask-tkl-run",
      agent: {
        id: "agent.ask-tkl",
        version: "0.1.0",
        capabilities: ["question.classify", "grounded-answer.synthesize"],
        mode: "read-only",
      },
      productId: "fl-titling",
      question: request.question,
      ...(request.workItemId ? { workItemId: request.workItemId } : {}),
      generatedAt,
      intent: { primary: "knowledge-search", matched: ["knowledge-search"] },
      scope: {
        productId: "fl-titling",
        ...(request.workItemId ? { workItemId: request.workItemId } : {}),
        interpretation: "bounded mock canonical knowledge",
      },
      status: "abstained",
      answer:
        "Mock mode has no citable canonical evidence for this question, so Ask TKL abstained.",
      citations: [],
      freshness: {
        status: "unknown",
        asOf: generatedAt,
        newestObservedAt: null,
        oldestObservedAt: null,
        staleCitationCount: 0,
        thresholdDays: 30,
      },
      confidence: {
        level: "none",
        rationale: "Connect to the TKL API to retrieve grounded evidence.",
      },
      conflicts: [],
      limitations: ["Mock mode does not answer product questions from fixture memory."],
      nextActions: ["Connect the dashboard to the authenticated TKL API."],
      toolCalls: [],
    });
  }

  previewApprovedAction(request: ApprovedActionPreviewRequest): Promise<ApprovedActionPreview> {
    const createdAt = new Date().toISOString();
    return delay({
      id: "preview:00000000-0000-4000-8000-000000000001",
      productId: "fl-titling",
      subject: "demo-reviewer",
      actionType: request.actionType,
      target: request.target,
      changes: request.changes,
      sourceVersions: request.sourceVersions,
      requiredPermission: permissionForAction(request.actionType),
      previewHash: "0".repeat(64),
      risk: request.actionType === "github.branch.create" ? "medium" : "high",
      summary: "Review the immutable proposed external change.",
      executable: false,
      executionStatus: "blocked",
      blockReason: {
        code: "external_writes_not_configured",
        message:
          "External write credentials and execution policy are not configured for this environment.",
      },
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 15 * 60 * 1000).toISOString(),
    });
  }

  approveAction(_preview: ApprovedActionPreview): Promise<ApprovedActionApproval> {
    return Promise.reject(new Error("Blocked previews cannot be approved from the dashboard."));
  }

  executeApprovedAction(
    _preview: ApprovedActionPreview,
    _approval: ApprovedActionApproval,
  ): Promise<ApprovedActionExecution> {
    return Promise.reject(new Error("External action execution is not configured."));
  }

  getConnectorHealth(): Promise<ConnectorHealth[]> {
    return delay(mockConnectorHealth);
  }

  getTicketContextOperations(): Promise<TicketContextOperations> {
    return delay(structuredClone(mockTicketContextOperations));
  }

  getStoryTraceability(_query?: string): Promise<StoryTraceability[]> {
    return delay(mockStoryTraceability);
  }

  getTicketContextJob(issueKey: string): Promise<TicketContextJob | null> {
    const job = this.ticketContextJobs.get(issueKey.trim().toUpperCase());
    return delay(job ? structuredClone(job) : null);
  }

  refreshTicketContext(issueKey: string): Promise<TicketContextJob> {
    const normalizedIssueKey = issueKey.trim().toUpperCase();
    const now = new Date().toISOString();
    const source = (): TicketContextJob["sources"]["jira"] => ({
      state: "pending",
      startedAt: null,
      completedAt: null,
      attemptCount: 0,
      recordsCollected: 0,
      truncated: false,
      error: null,
    });
    const job: TicketContextJob = {
      productId: "fl-titling",
      issueKey: normalizedIssueKey,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      attemptCount: 0,
      nextRetryAt: null,
      sources: {
        jira: source(),
        testrail: source(),
        github: source(),
      },
      completeness: {
        status: "pending",
        complete: false,
        reasons: ["Secondary source enrichment is queued."],
      },
    };
    this.ticketContextJobs.set(normalizedIssueKey, job);
    return delay(structuredClone(job));
  }

  cancelTicketContext(issueKey: string): Promise<TicketContextJob> {
    const normalizedIssueKey = issueKey.trim().toUpperCase();
    const current = this.ticketContextJobs.get(normalizedIssueKey);
    if (!current) {
      return Promise.reject(new Error(`No ticket context job exists for ${normalizedIssueKey}.`));
    }
    const cancelledAt = new Date().toISOString();
    const cancelSource = (
      source: TicketContextJob["sources"]["jira"],
    ): TicketContextJob["sources"]["jira"] => (
      source.state === "pending" || source.state === "running"
        ? { ...source, state: "cancelled", completedAt: cancelledAt }
        : source
    );
    const job: TicketContextJob = {
      ...current,
      state: "cancelled",
      updatedAt: cancelledAt,
      completedAt: cancelledAt,
      cancelledAt,
      nextRetryAt: null,
      sources: {
        jira: cancelSource(current.sources.jira),
        testrail: cancelSource(current.sources.testrail),
        github: cancelSource(current.sources.github),
      },
      completeness: {
        status: "cancelled",
        complete: false,
        reasons: ["Background enrichment was cancelled."],
      },
    };
    this.ticketContextJobs.set(normalizedIssueKey, job);
    return delay(structuredClone(job));
  }

  getCoverageGaps(_query?: string): Promise<CoverageGap[]> {
    return delay(mockCoverageGaps);
  }

  getKnowledgeInventory(_source?: string): Promise<KnowledgeInventory> {
    return delay(mockKnowledgeInventory);
  }

  getKnowledgeConflicts(): Promise<KnowledgeConflict[]> {
    return delay(
      mockKnowledgeConflicts.map((conflict) => this.reviewedConflicts.get(conflict.id) ?? conflict),
    );
  }

  reviewKnowledgeConflict(request: ConflictReviewRequest): Promise<KnowledgeConflict> {
    const conflict =
      this.reviewedConflicts.get(request.conflictId)
      ?? mockKnowledgeConflicts.find((candidate) => candidate.id === request.conflictId);

    if (!conflict) {
      return Promise.reject(new Error(`Open conflict ${request.conflictId} does not exist.`));
    }
    if (conflict.status === "reviewed") {
      return Promise.reject(new Error(`Conflict ${request.conflictId} has already been reviewed.`));
    }
    if (!request.approvedClaimIds.every((claimId) => conflict.claimIds.includes(claimId))) {
      return Promise.reject(
        new Error(`One or more approved claim IDs do not belong to conflict ${request.conflictId}.`),
      );
    }

    const reviewed: KnowledgeConflict = { ...conflict, status: "reviewed" };
    this.reviewedConflicts.set(conflict.id, reviewed);
    return delay(reviewed);
  }

  getEvaluationMetrics(): Promise<EvaluationMetrics> {
    return delay(mockEvaluationMetrics);
  }

  runCoverageContextAgent(workItemId: string): Promise<CoverageContextAgentRun> {
    return delay({
      runId: "mock-agent-run",
      agent: {
        id: "agent.coverage-context",
        version: "0.1.0",
        capabilities: ["quality-context.read", "coverage.analyze"],
        mode: "read-only",
      },
      productId: "fl-titling",
      workItemId,
      generatedAt: new Date().toISOString(),
      status: "insufficient-context",
      confidence: {
        level: "low",
        rationale: "Mock data contains Jira evidence only.",
      },
      summary: `${workItemId}: Jira context is available, but linked test evidence is incomplete.`,
      findings: [],
      recommendations: [],
      evidence: {
        sources: ["jira"],
        requirements: [],
        tests: [],
        relationships: [],
        citations: [],
      },
      limitations: ["Mock response; connect the dashboard to the TKL API for live analysis."],
    });
  }

  runTestDesignerAgent(workItemId: string): Promise<TestDesignerAgentRun> {
    return delay({
      runId: "mock-test-designer-run",
      agent: {
        id: "agent.test-designer",
        version: "0.1.0",
        capabilities: ["test-case.propose"],
        mode: "proposal-only",
      },
      productId: "fl-titling",
      workItemId,
      generatedAt: new Date().toISOString(),
      status: "insufficient-context",
      confidence: {
        level: "low",
        rationale: "Mock data does not contain complete acceptance criteria or TestRail cases.",
      },
      summary: `No grounded test drafts are available for ${workItemId} in mock mode.`,
      proposals: [],
      evidence: {
        sources: ["jira"],
        requirements: [],
        existingManualTests: [],
        citations: [],
      },
      limitations: ["Connect to the TKL API for live proposal generation."],
    });
  }

  runTestRailImprovementAgent(workItemId: string): Promise<TestRailImprovementAgentRun> {
    return delay({
      runId: "mock-testrail-improvement-run",
      agent: {
        id: "agent.testrail-improvement",
        version: "0.1.0",
        capabilities: ["test-case.improvement.propose"],
        mode: "proposal-only",
      },
      productId: "fl-titling",
      workItemId,
      generatedAt: new Date().toISOString(),
      status: "insufficient-context",
      confidence: {
        level: "low",
        rationale: "Mock data has no linked TestRail case fields.",
      },
      summary: `No grounded TestRail improvements are available for ${workItemId} in mock mode.`,
      proposals: [],
      evidence: {
        sources: ["jira"],
        requirements: [],
        manualTests: [],
        relationships: [],
        citations: [],
      },
      limitations: ["Connect to the TKL API for live TestRail case inspection."],
    });
  }

  runTestRailCaseImprovementAgent(caseId: string): Promise<TestRailImprovementAgentRun> {
    return this.runTestRailImprovementAgent(`C${caseId.trim().replace(/^C/i, "")}`);
  }

  runAutomationDesignerAgent(workItemId: string): Promise<AutomationDesignerAgentRun> {
    return delay({
      runId: "mock-automation-designer-run",
      agent: {
        id: "agent.automation-designer",
        version: "0.1.0",
        capabilities: ["automation.plan.propose"],
        mode: "proposal-only",
      },
      productId: "fl-titling",
      workItemId,
      generatedAt: new Date().toISOString(),
      status: "insufficient-context",
      confidence: {
        level: "low",
        rationale: "Mock data has no synchronized repository file evidence.",
      },
      summary: `No grounded automation plan is available for ${workItemId} in mock mode.`,
      proposal: {
        delivery: "review-only",
        codeGeneration: {
          status: "abstained",
          rationale: "Repository file contents are unavailable in mock mode.",
        },
        filePlan: [],
        codeOutline: [],
        reusableComponents: [],
        requiredTestData: [],
        validationCommands: [],
        conventions: {
          testDirectories: [],
          testFileSuffixes: [],
          fileExtensions: [],
          frameworkSignals: [],
        },
        discoveryTasks: [{
          id: "connect-api",
          action: "Connect the dashboard to the TKL API and synchronize GitHub evidence.",
          rationale: "Mock mode does not contain repository evidence.",
          evidenceIds: [],
        }],
      },
      evidence: {
        sources: [],
        requirements: [],
        manualCases: [],
        automatedTests: [],
        repositoryFiles: [],
        citations: [],
      },
      limitations: ["Connect to the TKL API for grounded automation planning."],
    });
  }

  runReliabilityDefectIntelligenceAgent(
    workItemId: string,
  ): Promise<ReliabilityDefectIntelligenceAgentRun> {
    return delay({
      runId: "mock-reliability-run",
      agent: {
        id: "agent.reliability-defect-intelligence",
        version: "0.1.0",
        capabilities: ["test-reliability.classify"],
        mode: "proposal-only",
      },
      productId: "fl-titling",
      workItemId,
      generatedAt: new Date().toISOString(),
      status: "insufficient-context",
      confidence: {
        level: "low",
        rationale: "Mock data has no synchronized ReportPortal run history.",
      },
      summary: `No grounded reliability history is available for ${workItemId} in mock mode.`,
      analyses: [],
      recommendations: [],
      evidence: {
        sources: [],
        requirements: [],
        reportPortalExecutions: [],
        jiraDefects: [],
        citations: [],
      },
      limitations: ["Connect to the TKL API and synchronize ReportPortal history."],
    });
  }

  runReportPortalReliabilityAgent(
    identity: string,
  ): Promise<ReliabilityDefectIntelligenceAgentRun> {
    return this.runReliabilityDefectIntelligenceAgent(`rp:${identity}`);
  }

  runKnowledgeCuratorAgent(workItemId: string): Promise<KnowledgeCuratorAgentRun> {
    return delay({
      runId: "mock-curator-run",
      agent: {
        id: "agent.knowledge-curator",
        version: "0.1.0",
        capabilities: ["knowledge-curation.propose"],
        mode: "proposal-only",
      },
      productId: "fl-titling",
      workItemId,
      generatedAt: new Date().toISOString(),
      scope: {
        rootRequirementId: `requirement:${workItemId}`,
        requirementIds: [`requirement:${workItemId}`],
        productId: "fl-titling",
      },
      status: "insufficient-context",
      confidence: {
        level: "low",
        rationale: "Mock data has no canonical claims or trace-link candidates.",
      },
      summary: `No grounded curation proposals are available for ${workItemId} in mock mode.`,
      findings: [],
      proposals: [],
      evidence: {
        sources: [],
        requirements: [],
        entities: [],
        claims: [],
        traceLinks: [],
        openConflicts: [],
        unresolvedTraceLinks: [],
        citations: [],
      },
      limitations: ["Connect to the TKL API for product-scoped curation inspection."],
      approval: {
        required: true,
        role: "knowledge-reviewer",
        allowedActions: ["approve", "reject", "request-evidence"],
        statement: "Every curation action requires explicit human approval.",
      },
    });
  }

  getSourceConnections(): Promise<SourceConnection[]> {
    return delay([...this.sourceConnections.values()].map((connection) => ({
      ...connection,
      repositories: connection.source === "github"
        ? [...this.githubRepositories.values()].map((repository) => ({ ...repository }))
        : connection.repositories?.map((repository) => ({ ...repository })),
    })));
  }

  getGitHubRepositories(): Promise<GitHubRepository[]> {
    return delay([...this.githubRepositories.values()].map((repository) => ({ ...repository })));
  }

  getGitHubRepository(repositoryId: string): Promise<GitHubRepository> {
    return delay({ ...this.requireGitHubRepository(repositoryId) });
  }

  createGitHubRepository(
    request: CreateGitHubRepositoryRequest,
  ): Promise<GitHubRepository> {
    this.requireConfiguredSourceConnection("github");
    const repositoryName = normalizeMockRepository(request.repository);
    if ([...this.githubRepositories.values()].some(
      (repository) => repository.repository.toLowerCase() === repositoryName.toLowerCase(),
    )) {
      return Promise.reject(new Error("That GitHub repository target already exists."));
    }
    const id = request.id ?? repositoryName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    if (this.githubRepositories.has(id)) {
      return Promise.reject(new Error("That GitHub repository ID already exists."));
    }
    const repository: GitHubRepository = {
      id,
      repository: repositoryName,
      url: request.url ?? `https://github.com/${repositoryName}`,
      purpose: request.purpose ?? "quality-evidence",
      lifecycle: request.lifecycle ?? "active",
      enabled: request.lifecycle === "archived" ? false : request.enabled ?? true,
      validationStatus: "pending",
      syncStatus: "idle",
      lastValidatedAt: null,
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      recordsCollected: 0,
      error: null,
    };
    this.githubRepositories.set(id, repository);
    return delay({ ...repository });
  }

  updateGitHubRepository(
    repositoryId: string,
    request: UpdateGitHubRepositoryRequest,
  ): Promise<GitHubRepository> {
    const current = this.requireGitHubRepository(repositoryId);
    if (current.syncStatus === "syncing") {
      return Promise.reject(new Error("The repository cannot be updated while it is synchronizing."));
    }
    const repositoryName = request.repository
      ? normalizeMockRepository(request.repository)
      : current.repository;
    const changedRepository = repositoryName !== current.repository;
    const lifecycle = request.lifecycle ?? current.lifecycle;
    const updated: GitHubRepository = {
      ...current,
      ...request,
      repository: repositoryName,
      url: request.url ?? (changedRepository
        ? `https://github.com/${repositoryName}`
        : current.url),
      lifecycle,
      enabled: lifecycle === "archived" ? false : request.enabled ?? current.enabled,
      ...(changedRepository ? {
        validationStatus: "pending" as const,
        syncStatus: "idle" as const,
        lastValidatedAt: null,
        lastSyncAt: null,
        lastSuccessfulSyncAt: null,
        recordsCollected: 0,
        error: null,
      } : {}),
    };
    this.githubRepositories.set(repositoryId, updated);
    return delay({ ...updated });
  }

  deleteGitHubRepository(repositoryId: string): Promise<GitHubRepository> {
    const repository = this.requireGitHubRepository(repositoryId);
    if (repository.syncStatus === "syncing") {
      return Promise.reject(new Error("The repository cannot be deleted while it is synchronizing."));
    }
    this.githubRepositories.delete(repositoryId);
    return delay({ ...repository });
  }

  testGitHubRepository(repositoryId: string): Promise<GitHubRepository> {
    const current = this.requireGitHubRepository(repositoryId);
    const updated: GitHubRepository = {
      ...current,
      validationStatus: "valid",
      lastValidatedAt: new Date().toISOString(),
      error: null,
    };
    this.githubRepositories.set(repositoryId, updated);
    return delay({ ...updated });
  }

  syncGitHubRepository(repositoryId: string): Promise<GitHubRepository> {
    const current = this.requireGitHubRepository(repositoryId);
    if (!current.enabled || current.lifecycle === "archived") {
      return Promise.reject(new Error("Enable this repository before synchronizing it."));
    }
    if (this.repositorySyncs.has(repositoryId) || current.syncStatus === "syncing") {
      return Promise.reject(new Error("A synchronization is already in progress for this repository."));
    }
    const startedAt = new Date().toISOString();
    const syncing: GitHubRepository = {
      ...current,
      syncStatus: "syncing",
      lastSyncAt: startedAt,
      error: null,
    };
    this.githubRepositories.set(repositoryId, syncing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.repositorySyncs.delete(repositoryId);
        const completedAt = new Date().toISOString();
        const updated: GitHubRepository = {
          ...syncing,
          validationStatus: "valid",
          syncStatus: "succeeded",
          lastSuccessfulSyncAt: completedAt,
          recordsCollected: syncing.recordsCollected + 24,
          error: null,
        };
        this.githubRepositories.set(repositoryId, updated);
        resolve({ ...updated });
      }, 150);
      this.repositorySyncs.set(repositoryId, { timer, reject });
    });
  }

  cancelGitHubRepositorySync(repositoryId: string): Promise<GitHubRepository> {
    const current = this.requireGitHubRepository(repositoryId);
    const active = this.repositorySyncs.get(repositoryId);
    if (!active && current.syncStatus !== "syncing") {
      return Promise.reject(new Error("No synchronization is in progress for this repository."));
    }
    if (active) {
      clearTimeout(active.timer);
      this.repositorySyncs.delete(repositoryId);
    }
    const updated: GitHubRepository = {
      ...current,
      syncStatus: "cancelled",
      error: {
        code: "sync_cancelled",
        category: "internal",
        message: "The synchronization was cancelled.",
      },
    };
    this.githubRepositories.set(repositoryId, updated);
    active?.reject(new Error("The synchronization was cancelled."));
    return delay({ ...updated });
  }

  discoverTestRailSuites(
    request: DiscoverTestRailSuitesRequest,
  ): Promise<TestRailSuite[]> {
    if (
      !request.credential.trim()
      || !request.config.baseUrl.trim()
      || !request.config.username.trim()
      || !request.config.projectId.trim()
    ) {
      return Promise.reject(new Error("Complete the TestRail connection fields first."));
    }
    return delay([
      { id: "4", name: "Automation Testing", isCompleted: false },
      { id: "8", name: "Regression suite", isCompleted: false },
      { id: "12", name: "Legacy coverage", isCompleted: true },
    ]);
  }

  discoverTestRailSections(suiteId: string): Promise<TestRailSection[]> {
    if (!/^[1-9]\d*$/.test(suiteId.trim())) {
      return Promise.reject(new Error("Enter a valid TestRail suite ID."));
    }
    return delay([
      { id: "1201", suiteId, parentId: null, depth: 0, name: "Regression" },
      { id: "1202", suiteId, parentId: "1201", depth: 1, name: "Core workflows" },
    ]);
  }

  discoverConfluencePages(
    request: DiscoverConfluencePagesRequest,
  ): Promise<ConfluencePageDiscovery> {
    if (
      !request.credential.trim()
      || !request.config.username.trim()
      || request.config.rootPageUrls.length === 0
    ) {
      return Promise.reject(new Error("Complete the Confluence connection fields first."));
    }
    const parsed = request.config.rootPageUrls.map((pageUrl, index) => {
      const url = new URL(pageUrl);
      const segments = url.pathname.split("/").filter(Boolean);
      const displayIndex = segments.findIndex(
        (segment) => segment.toLowerCase() === "display",
      );
      if (displayIndex < 0 || segments.length <= displayIndex + 2) {
        throw new Error("Enter a Confluence page URL, not only the base URL.");
      }
      return {
        baseUrl: `${url.origin}/${segments.slice(0, displayIndex).join("/")}`,
        root: {
          id: String(1000 + index),
          title: decodeURIComponent(
            segments.slice(displayIndex + 2).join("/").replaceAll("+", " "),
          ),
          spaceKey: decodeURIComponent(segments[displayIndex + 1]),
          url: pageUrl,
        },
      };
    });
    return delay({
      baseUrl: parsed[0].baseUrl,
      authMode: request.config.authMode ?? "bearer",
      roots: parsed.map((item) => item.root),
    });
  }

  saveSourceConnection(
    source: SourceConnectionId,
    request: SaveSourceConnectionRequest,
  ): Promise<SourceConnection> {
    if (!request.credential.trim()) return Promise.reject(new Error("A credential is required."));
    const current = this.requireSourceConnection(source);
    const now = new Date().toISOString();
    const updated: SourceConnection = {
      ...current,
      status: "connected",
      configured: true,
      ownerSubject: "local-demo-user",
      config: structuredClone(request.config),
      connectedAt: current.connectedAt ?? now,
      lastValidatedAt: now,
      error: null,
    };
    if (source === "github" && this.githubRepositories.size === 0) {
      const repositories = Array.isArray(request.config.repositories)
        ? request.config.repositories
        : typeof request.config.repositories === "string"
          ? [request.config.repositories]
          : [];
      for (const repositoryName of repositories) {
        const repository = normalizeMockRepository(repositoryName);
        const id = repository.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        this.githubRepositories.set(id, {
          id,
          repository,
          url: `https://github.com/${repository}`,
          purpose: "quality-evidence",
          lifecycle: "active",
          enabled: true,
          validationStatus: "valid",
          syncStatus: "idle",
          lastValidatedAt: now,
          lastSyncAt: null,
          lastSuccessfulSyncAt: null,
          recordsCollected: 0,
          error: null,
        });
      }
    }
    this.sourceConnections.set(source, updated);
    return delay({ ...updated });
  }

  testSourceConnection(source: SourceConnectionId): Promise<SourceConnection> {
    const current = this.requireConfiguredSourceConnection(source);
    const updated: SourceConnection = {
      ...current,
      status: "connected",
      lastValidatedAt: new Date().toISOString(),
      error: null,
    };
    this.sourceConnections.set(source, updated);
    return delay({ ...updated });
  }

  syncSourceConnection(source: SourceConnectionId): Promise<SourceConnection> {
    const current = this.requireConfiguredSourceConnection(source);
    if (!current.ingestionSupported) {
      return Promise.reject(new Error(`${current.displayName} ingestion is not available yet.`));
    }
    const activeSource = this.sourceSyncs.keys().next().value;
    if (activeSource) {
      return Promise.reject(new Error(`A synchronization is already in progress for ${activeSource}.`));
    }
    const startedAt = new Date().toISOString();
    const syncing: SourceConnection = {
      ...current,
      status: "syncing",
      lastSyncAt: startedAt,
      error: null,
    };
    this.sourceConnections.set(source, syncing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sourceSyncs.delete(source);
        const completedAt = new Date().toISOString();
        const updated: SourceConnection = {
          ...syncing,
          status: "connected",
          lastSuccessfulSyncAt: completedAt,
          error: null,
        };
        this.sourceConnections.set(source, updated);
        resolve({ ...updated });
      }, 150);
      this.sourceSyncs.set(source, { timer, reject });
    });
  }

  cancelSourceConnectionSync(source: SourceConnectionId): Promise<SourceConnection> {
    const current = this.requireConfiguredSourceConnection(source);
    const activeSource = this.sourceSyncs.keys().next().value;
    if (activeSource && activeSource !== source) {
      return Promise.reject(new Error(`The active synchronization is for ${activeSource}.`));
    }
    const active = this.sourceSyncs.get(source);
    if (!active && current.status !== "syncing") {
      return Promise.reject(new Error("No synchronization is currently in progress."));
    }
    if (active) {
      clearTimeout(active.timer);
      this.sourceSyncs.delete(source);
    }
    const updated: SourceConnection = {
      ...current,
      status: "error",
      error: {
        code: "sync_cancelled",
        category: "internal",
        message: "The synchronization was cancelled.",
      },
    };
    this.sourceConnections.set(source, updated);
    active?.reject(new Error("The synchronization was cancelled."));
    return delay({ ...updated });
  }

  disconnectSourceConnection(source: SourceConnectionId): Promise<SourceConnection> {
    const current = this.requireSourceConnection(source);
    const updated: SourceConnection = {
      ...current,
      status: "not-connected",
      configured: false,
      ownerSubject: null,
      config: {},
      connectedAt: null,
      lastValidatedAt: null,
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      error: null,
    };
    this.sourceConnections.set(source, updated);
    return delay({ ...updated });
  }

  private requireSourceConnection(source: SourceConnectionId): SourceConnection {
    const connection = this.sourceConnections.get(source);
    if (!connection) throw new Error(`Unknown source connection: ${source}.`);
    return connection;
  }

  private requireConfiguredSourceConnection(source: SourceConnectionId): SourceConnection {
    const connection = this.requireSourceConnection(source);
    if (!connection.configured) throw new Error(`${connection.displayName} is not connected.`);
    return connection;
  }

  private requireGitHubRepository(repositoryId: string): GitHubRepository {
    const repository = this.githubRepositories.get(repositoryId);
    if (!repository) throw new Error("GitHub repository target was not found.");
    return repository;
  }
}

function normalizeMockRepository(value: string): string {
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length !== 2) throw new Error("Enter a repository in owner/repository format.");
  return `${segments[0]}/${segments[1]}`;
}

let client: TklApiClient | null = null;

export class DashboardConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardConfigurationError";
  }
}

export function createDefaultTklApiClient(config: DashboardApiConfig): TklApiClient {
  if (config.baseUrl) {
    return new HttpTklApiClient({
      baseUrl: config.baseUrl,
      token: config.token,
      productId: config.productId,
    });
  }
  if (config.allowMockData) return new MockTklApiClient();
  throw new DashboardConfigurationError(
    "VITE_TKL_API_BASE_URL is required unless explicit development/demo mock mode is enabled.",
  );
}

/**
 * Single point that decides which client backs the dashboard: a real `HttpTklApiClient`
 * when `VITE_TKL_API_BASE_URL` is configured. Fixture data is allowed only in development,
 * tests, or explicit demo mode; production fails closed when API configuration is absent.
 */
export function getTklApiClient(): TklApiClient {
  if (!client) {
    client = createDefaultTklApiClient(getDashboardApiConfig());
  }
  return client;
}

/**
 * Test-only seam: inject a fake `TklApiClient` (or reset to the default mock by passing
 * `null`) so component tests can exercise loading/empty/error/pending-configuration states
 * without depending on the shared fixture data or timers.
 */
export function setTklApiClientForTests(override: TklApiClient | null): void {
  client = override;
}
