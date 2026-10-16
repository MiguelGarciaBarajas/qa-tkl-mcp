/**
 * Real HTTP-backed `TklApiClient` calling the TKL Application API (`apps/api`, `API-102`).
 *
 * Field-mapping notes (why some dashboard fields are best-effort/defaulted):
 * - Intelligence views use bounded aggregate endpoints. They never enumerate the
 *   complete product library or fan out one HTTP request per entity.
 * - `RequirementRef`/`TestRef.url` are optional: the canonical-entity contract does not
 *   surface a source URL at this layer yet.
 * - `TestRef.status` defaults to `"unknown"` and `lastExecutedAt` remains undefined: per-test execution
 *   status/timestamps are not returned by `get_story_test_context` (only aggregate
 *   coverage/freshness per requirement, via `analyze_requirement_coverage`).
 * - `Provenance.classification` defaults to `"internal"`: not surfaced by the real
 *   `Provenance` contract at the canonical-entity layer.
 * - `CoverageGap.linkConfidence` buckets the real numeric `linkConfidence` (0-1) into the
 *   dashboard's labeled scale (see `bucketLinkConfidence` below).
 * - Evaluation metrics come from the committed golden dataset and real normalization /
 *   analysis pipeline. They measure model behavior, not live-source synchronization.
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
  ConnectorStatus,
  ConfluencePageDiscovery,
  CreateGitHubRepositoryRequest,
  CoverageGap,
  DiscoverConfluencePagesRequest,
  DiscoverTestRailSuitesRequest,
  EvaluationMetrics,
  KnowledgeConflict,
  KnowledgeInventory,
  KnowledgeCuratorAgentRun,
  GitHubRepository,
  LinkConfidence,
  Provenance,
  RequirementRef,
  ReliabilityDefectIntelligenceAgentRun,
  EvidenceGraph,
  SaveSourceConnectionRequest,
  SourceConnection,
  SourceConnectionId,
  StoryTraceability,
  TestRailSuite,
  TestRailSection,
  TicketContextJob,
  TicketContextInvalidationDisposition,
  TicketContextOperations,
  TestDesignerAgentRun,
  TestRailImprovementAgentRun,
  TestRef,
  TestType,
  UpdateGitHubRepositoryRequest,
} from "../contracts/types";
import type { TklApiClient } from "./client";

export interface HttpTklApiClientConfig {
  /** Base URL of the TKL Application API, e.g. `https://tkl-api.example.com`. */
  baseUrl: string;
  /** Bearer token resolved by the host app; never a raw source-system credential. */
  token?: string;
  productId: string;
  fetchImpl?: typeof fetch;
  /** Injected by tests; production uses a real timer for rate-limit backoff. */
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

interface CanonicalEntityLike {
  id: string;
  type: string;
  title: string;
  provenance?: unknown;
  metadata?: {
    issueType?: string;
    status?: string;
  };
}

interface TraceLinkLike {
  fromEntityId: string;
  toEntityId: string;
  type?: string;
  origin: "explicit" | "inferred";
  confidence: number;
}

interface CoverageFindingLike {
  requirementId: string;
  numerator: number;
  denominator: number;
  linkConfidence: number;
}

const INTELLIGENCE_PAGE_SIZE = 8;
const INVALIDATION_DISPOSITIONS = [
  "accepted",
  "duplicate",
  "obsolete",
  "not-hot",
  "rejected",
] as const satisfies readonly TicketContextInvalidationDisposition[];

function contextOperationsShapeError(path: string): Error {
  return new Error(`Invalid context operations response at ${path}.`);
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contextOperationsShapeError(path);
  }
  return value as Record<string, unknown>;
}

function nonNegativeNumberAt(value: unknown, path: string, integer = true): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || (integer && !Number.isInteger(value))
  ) {
    throw contextOperationsShapeError(path);
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw contextOperationsShapeError(path);
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw contextOperationsShapeError(path);
  }
  return value;
}

function stringArrayAt(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value)
    || value.some((item) =>
      typeof item !== "string" || !/^[a-z0-9_]{1,64}$/.test(item)
    )
  ) {
    throw contextOperationsShapeError(path);
  }
  return [...value];
}

function timestampAt(value: unknown, path: string): string {
  const timestamp = stringAt(value, path);
  if (!Number.isFinite(Date.parse(timestamp))) throw contextOperationsShapeError(path);
  return timestamp;
}

function nullableTimestampAt(value: unknown, path: string): string | null {
  return value === null ? null : timestampAt(value, path);
}

function dispositionAt(
  value: unknown,
  path: string,
): TicketContextInvalidationDisposition {
  if (
    typeof value !== "string"
    || !INVALIDATION_DISPOSITIONS.includes(value as TicketContextInvalidationDisposition)
  ) {
    throw contextOperationsShapeError(path);
  }
  return value as TicketContextInvalidationDisposition;
}

function failureAt(
  value: unknown,
  path: string,
): TicketContextOperations["lastWorkerFailure"] {
  if (value === null) return null;
  const failure = recordAt(value, path);
  return {
    at: timestampAt(failure.at, `${path}.at`),
    code: stringAt(failure.code, `${path}.code`),
  };
}

function mapTicketContextOperations(response: unknown): TicketContextOperations {
  const root = recordAt(response, "root");
  const operations = recordAt(root.operations, "operations");
  const durable = recordAt(operations.durable, "operations.durable");
  const health = recordAt(operations.health, "operations.health");
  const jobStates = recordAt(durable.jobStates, "operations.durable.jobStates");
  const memory = recordAt(operations.memory, "operations.memory");
  const capacity = recordAt(operations.capacity, "operations.capacity");
  const invalidations = recordAt(operations.invalidations, "operations.invalidations");
  const dispositions = recordAt(
    invalidations.dispositions,
    "operations.invalidations.dispositions",
  );
  const lastInvalidation = invalidations.last === null
    ? null
    : recordAt(invalidations.last, "operations.invalidations.last");
  const lastRetentionSweep = operations.lastRetentionSweep === null
    ? null
    : recordAt(operations.lastRetentionSweep, "operations.lastRetentionSweep");

  return {
    health: {
      status: health.status === "healthy" || health.status === "degraded"
        ? health.status
        : (() => { throw contextOperationsShapeError("operations.health.status"); })(),
      reasons: stringArrayAt(health.reasons, "operations.health.reasons"),
    },
    durable: {
      jobStates: {
        pending: nonNegativeNumberAt(jobStates.pending, "operations.durable.jobStates.pending"),
        running: nonNegativeNumberAt(jobStates.running, "operations.durable.jobStates.running"),
        complete: nonNegativeNumberAt(jobStates.complete, "operations.durable.jobStates.complete"),
        partial: nonNegativeNumberAt(jobStates.partial, "operations.durable.jobStates.partial"),
        unavailable: nonNegativeNumberAt(
          jobStates.unavailable,
          "operations.durable.jobStates.unavailable",
        ),
        cancelled: nonNegativeNumberAt(
          jobStates.cancelled,
          "operations.durable.jobStates.cancelled",
        ),
      },
      totalJobs: nonNegativeNumberAt(durable.totalJobs, "operations.durable.totalJobs"),
      deliveryReceipts: nonNegativeNumberAt(
        durable.deliveryReceipts,
        "operations.durable.deliveryReceipts",
      ),
    },
    memory: {
      queued: nonNegativeNumberAt(memory.queued, "operations.memory.queued"),
      active: nonNegativeNumberAt(memory.active, "operations.memory.active"),
      delayedRetry: nonNegativeNumberAt(
        memory.delayedRetry,
        "operations.memory.delayedRetry",
      ),
      paused: booleanAt(memory.paused, "operations.memory.paused"),
      oldestQueuedAgeMs: memory.oldestQueuedAgeMs === null
        ? null
        : nonNegativeNumberAt(
            memory.oldestQueuedAgeMs,
            "operations.memory.oldestQueuedAgeMs",
          ),
    },
    attempts: nonNegativeNumberAt(operations.attempts, "operations.attempts"),
    retries: nonNegativeNumberAt(operations.retries, "operations.retries"),
    capacity: {
      used: nonNegativeNumberAt(capacity.used, "operations.capacity.used"),
      max: nonNegativeNumberAt(capacity.max, "operations.capacity.max"),
      percent: nonNegativeNumberAt(capacity.percent, "operations.capacity.percent", false),
    },
    lastSuccessfulCompletion: nullableTimestampAt(
      operations.lastSuccessfulCompletion,
      "operations.lastSuccessfulCompletion",
    ),
    lastWorkerFailure: failureAt(
      operations.lastWorkerFailure,
      "operations.lastWorkerFailure",
    ),
    lastPersistenceFailure: failureAt(
      operations.lastPersistenceFailure,
      "operations.lastPersistenceFailure",
    ),
    invalidations: {
      dispositions: {
        accepted: nonNegativeNumberAt(
          dispositions.accepted,
          "operations.invalidations.dispositions.accepted",
        ),
        duplicate: nonNegativeNumberAt(
          dispositions.duplicate,
          "operations.invalidations.dispositions.duplicate",
        ),
        obsolete: nonNegativeNumberAt(
          dispositions.obsolete,
          "operations.invalidations.dispositions.obsolete",
        ),
        "not-hot": nonNegativeNumberAt(
          dispositions["not-hot"],
          "operations.invalidations.dispositions.not-hot",
        ),
        rejected: nonNegativeNumberAt(
          dispositions.rejected,
          "operations.invalidations.dispositions.rejected",
        ),
      },
      last: lastInvalidation
        ? {
            source: stringAt(
              lastInvalidation.source,
              "operations.invalidations.last.source",
            ),
            observedAt: nullableTimestampAt(
              lastInvalidation.observedAt,
              "operations.invalidations.last.observedAt",
            ),
            receivedAt: timestampAt(
              lastInvalidation.receivedAt,
              "operations.invalidations.last.receivedAt",
            ),
            disposition: dispositionAt(
              lastInvalidation.disposition,
              "operations.invalidations.last.disposition",
            ),
          }
        : null,
    },
    lastRetentionSweep: lastRetentionSweep
      ? {
          startedAt: timestampAt(
            lastRetentionSweep.startedAt,
            "operations.lastRetentionSweep.startedAt",
          ),
          completedAt: timestampAt(
            lastRetentionSweep.completedAt,
            "operations.lastRetentionSweep.completedAt",
          ),
          jobsDeleted: nonNegativeNumberAt(
            lastRetentionSweep.jobsDeleted,
            "operations.lastRetentionSweep.jobsDeleted",
          ),
          receiptsDeleted: nonNegativeNumberAt(
            lastRetentionSweep.receiptsDeleted,
            "operations.lastRetentionSweep.receiptsDeleted",
          ),
        }
      : null,
  };
}

function firstProvenance(entity: CanonicalEntityLike): Provenance {
  const raw = Array.isArray(entity.provenance) ? entity.provenance[0] : entity.provenance;
  const source = (raw as { source?: string } | undefined)?.source;
  return {
    source:
      source === "github"
      || source === "testrail"
      || source === "confluence"
      || source === "reportportal"
        ? source
        : "jira",
    sourceVersion: (raw as { sourceVersion?: string } | undefined)?.sourceVersion ?? "unknown",
    observedAt: (raw as { observedAt?: string } | undefined)?.observedAt ?? new Date(0).toISOString(),
    classification: "internal",
  };
}

function testTypeFor(entity: CanonicalEntityLike): TestType {
  return entity.type === "manual-test" ? "manual" : "automated";
}

function testSourceFor(entity: CanonicalEntityLike): TestRef["source"] {
  const provenance = firstProvenance(entity);
  return provenance.source === "testrail" ? "testrail" : "github";
}

function bucketLinkConfidence(linkConfidence: number, denominator: number): LinkConfidence | "none" {
  if (denominator === 0) return "none";
  if (linkConfidence >= 0.9) return "explicit";
  if (linkConfidence >= 0.5) return "inferred-high";
  return "inferred-low";
}

function linkConfidenceFromLink(link: TraceLinkLike): LinkConfidence {
  if (link.origin === "explicit") return "explicit";
  return link.confidence >= 0.5 ? "inferred-high" : "inferred-low";
}

class RateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, message: string) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

class HttpRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
  }
}

export class HttpTklApiClient implements TklApiClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly productId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (milliseconds: number) => Promise<void>;

  constructor(config: HttpTklApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.productId = config.productId;
    // `fetch` must stay bound to the global object: calling an unbound reference through
    // `this.fetchImpl` throws "Illegal invocation" in browsers (caught by the INT-102
    // browser end-to-end run; jsdom-based unit tests do not reproduce it). Resolving it
    // lazily also keeps construction working in environments without a global `fetch`.
    this.fetchImpl = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.sleepImpl = config.sleepImpl
      ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private authorizationHeader(): string {
    return `Bearer ${this.token}`;
  }

  private async request<T>(
    path: string,
    params: Record<string, string | undefined>,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce<T>(path, params, init);
      } catch (error) {
        if (!(error instanceof RateLimitError) || attempt >= 20) throw error;
        await this.sleepImpl(error.retryAfterMs);
      }
    }
  }

  private async requestOnce<T>(
    path: string,
    params: Record<string, string | undefined>,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = this.authorizationHeader();
    let requestBody: string | undefined;
    if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
      requestBody = JSON.stringify(init.body);
    }

    const response = await this.fetchImpl(url.toString(), {
      method: init?.method ?? "GET",
      headers,
      body: requestBody,
    });

    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const apiError = (body as {
        error?: { code?: string; message?: string; details?: { retryAfterMs?: number } };
      } | undefined)?.error;
      const message = apiError?.message
        ?? `Request to ${path} failed with status ${response.status}.`;
      if (response.status === 429 && apiError?.code === "rate_limit_exceeded") {
        const retryAfterMs = Number(apiError.details?.retryAfterMs);
        throw new RateLimitError(
          Number.isFinite(retryAfterMs)
            ? Math.min(Math.max(retryAfterMs, 0), 60_000)
            : 1_000,
          message,
        );
      }
      throw new HttpRequestError(response.status, message);
    }
    return body as T;
  }

  async getConnectorHealth(): Promise<ConnectorHealth[]> {
    const health = await this.request<{
      dependencies: { components: Array<Record<string, unknown>> };
    }>("/health", {});

    return health.dependencies.components.map((component) => {
      const connectorId = String(component.component ?? "unknown").replace(/^connector:/, "");
      const rawStatus = String(component.status ?? "unknown");
      const status: ConnectorStatus =
        rawStatus === "healthy" || rawStatus === "ok" ? "healthy"
          : rawStatus === "validating" ? "validating"
          : rawStatus === "syncing" ? "syncing"
          : rawStatus === "disabled" ? "disabled"
          : rawStatus === "down" || rawStatus === "failing" ? "failing"
          : "degraded";
      const source: ConnectorHealth["source"] =
        connectorId.includes("github") ? "github"
          : connectorId.includes("testrail") ? "testrail"
          : connectorId.includes("confluence") ? "confluence"
          : connectorId.includes("reportportal") ? "reportportal"
          : "jira";

      return {
        connectorId,
        source,
        status,
        lastSyncAt: (component.lastSyncAt as string | null | undefined) ?? null,
        lastSuccessfulSyncAt: (component.lastSuccessfulSyncAt as string | null | undefined) ?? null,
        recordsSyncedLast24h: Number(component.records ?? 0),
        errorRateLast24h:
          Number(component.records ?? 0) > 0
            ? Number(component.failures ?? 0) / Number(component.records)
            : 0,
        credentialStatus: component.credentialRef ? "valid" : "missing",
        message: component.message as string | undefined,
      };
    });
  }

  async getTicketContextOperations(): Promise<TicketContextOperations> {
    const response = await this.request<unknown>(
      "/v1/context-operations",
      { productId: this.productId },
    );
    return mapTicketContextOperations(response);
  }

  async resolveArtifacts(query: string): Promise<ArtifactResolution> {
    return this.request<ArtifactResolution>("/v1/artifacts/resolve", {
      productId: this.productId,
      query,
      limit: "8",
    });
  }

  getEvidenceGraph(entityId: string): Promise<EvidenceGraph> {
    return this.request<EvidenceGraph>(
      "/v1/evidence-graph",
      { productId: this.productId, entityId },
    );
  }

  async getStoryTraceability(query = ""): Promise<StoryTraceability[]> {
    const response = await this.request<{
      items: Array<{
        story: CanonicalEntityLike;
        requirements: CanonicalEntityLike[];
        tests: CanonicalEntityLike[];
        relationships: TraceLinkLike[];
        context?: {
          issueType?: string;
          status?: string;
          relatedRequirementCount?: number;
          returnedRequirementCount?: number;
          truncated?: boolean;
        };
      }>;
    }>("/v1/intelligence/traceability", {
      productId: this.productId,
      source: "jira",
      query,
      limit: String(INTELLIGENCE_PAGE_SIZE),
      offset: "0",
    });

    return response.items.map(({ story, requirements: rawRequirements, tests: rawTests, relationships, context }) => {
        const requirements: RequirementRef[] = rawRequirements.map((req) => ({
          id: req.id,
          title: req.title,
          source: "jira",
          provenance: firstProvenance(req),
        }));

        const tests: TestRef[] = rawTests.map((test) => ({
          id: test.id,
          title: test.title,
          source: testSourceFor(test),
          type: testTypeFor(test),
          status: "unknown",
          lastExecutedAt: undefined,
          provenance: firstProvenance(test),
        }));
        const requirementIds = new Set(requirements.map((requirement) => requirement.id));
        const testIds = new Set(tests.map((test) => test.id));

        return {
          storyId: story.id,
          storyTitle: story.title,
          productId: this.productId,
          issueType: context?.issueType ?? story.metadata?.issueType,
          status: context?.status ?? story.metadata?.status,
          relatedRequirementCount: context?.relatedRequirementCount ?? 0,
          returnedRequirementCount: context?.returnedRequirementCount ?? 0,
          truncated: context?.truncated ?? false,
          requirements,
          tests,
          links: relationships.flatMap((link) => {
            if (requirementIds.has(link.toEntityId) && testIds.has(link.fromEntityId)) {
              return [{
                requirementId: link.toEntityId,
                testId: link.fromEntityId,
                confidence: linkConfidenceFromLink(link),
                reviewed: null,
              }];
            }
            if (requirementIds.has(link.fromEntityId) && testIds.has(link.toEntityId)) {
              return [{
                requirementId: link.fromEntityId,
                testId: link.toEntityId,
                confidence: linkConfidenceFromLink(link),
                reviewed: null,
              }];
            }
            return [];
          }),
        };
      });
  }

  async getTicketContextJob(issueKey: string): Promise<TicketContextJob | null> {
    try {
      const response = await this.request<{ job: TicketContextJob }>(
        `/v1/context-jobs/${encodeURIComponent(issueKey.trim().toUpperCase())}`,
        { productId: this.productId },
      );
      return response.job;
    } catch (error) {
      if (error instanceof HttpRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async refreshTicketContext(issueKey: string): Promise<TicketContextJob> {
    const response = await this.request<{ job: TicketContextJob }>(
      `/v1/context-jobs/${encodeURIComponent(issueKey.trim().toUpperCase())}/refresh`,
      { productId: this.productId },
      { method: "POST" },
    );
    return response.job;
  }

  async cancelTicketContext(issueKey: string): Promise<TicketContextJob> {
    const response = await this.request<{ job: TicketContextJob }>(
      `/v1/context-jobs/${encodeURIComponent(issueKey.trim().toUpperCase())}`,
      { productId: this.productId },
      { method: "DELETE" },
    );
    return response.job;
  }

  async getCoverageGaps(query = ""): Promise<CoverageGap[]> {
    const response = await this.request<{
      items: Array<{
        requirement: CanonicalEntityLike;
        finding: CoverageFindingLike | null;
      }>;
    }>("/v1/intelligence/coverage", {
      productId: this.productId,
      source: "jira",
      query,
      limit: String(INTELLIGENCE_PAGE_SIZE),
      offset: "0",
    });

    const gaps = response.items.map(({ requirement, finding }): CoverageGap | null => {
        if (!finding) return null;

        return {
          requirementId: requirement.id,
          requirementTitle: requirement.title,
          storyId: requirement.id,
          numerator: finding.numerator,
          denominator: finding.denominator,
          linkConfidence: bucketLinkConfidence(finding.linkConfidence, finding.denominator),
        };
      });

    return gaps.filter((gap): gap is CoverageGap => gap !== null);
  }

  async getKnowledgeInventory(source?: string): Promise<KnowledgeInventory> {
    return this.request<KnowledgeInventory>("/v1/intelligence/knowledge-inventory", {
      productId: this.productId,
      ...(source ? { source } : {}),
    });
  }

  async getKnowledgeConflicts(): Promise<KnowledgeConflict[]> {
    const { conflicts } = await this.request<{
      conflicts: Array<{
        id: string;
        entityId: string;
        claimIds: string[];
        reason: string;
        detectedAt: string;
        status: "open" | "reviewed";
      }>;
    }>("/v1/knowledge/conflicts", { productId: this.productId });

    return conflicts.map((conflict) => ({
      id: conflict.id,
      entityId: conflict.entityId,
      entityTitle: conflict.entityId,
      description: conflict.reason,
      detectedAt: conflict.detectedAt,
      status: conflict.status,
      claimIds: conflict.claimIds,
    }));
  }

  async reviewKnowledgeConflict(request: ConflictReviewRequest): Promise<KnowledgeConflict> {
    const { conflict } = await this.request<{
      conflict: {
        id: string;
        entityId: string;
        claimIds: string[];
        reason: string;
        detectedAt: string;
        status: "open" | "reviewed";
      };
    }>(
      "/v1/knowledge/conflicts/review",
      { productId: this.productId },
      { method: "POST", body: request },
    );

    return {
      id: conflict.id,
      entityId: conflict.entityId,
      entityTitle: conflict.entityId,
      description: conflict.reason,
      detectedAt: conflict.detectedAt,
      status: conflict.status,
      claimIds: conflict.claimIds,
    };
  }

  getEvaluationMetrics(): Promise<EvaluationMetrics> {
    return this.request<EvaluationMetrics>(
      "/v1/evaluation/metrics",
      { productId: this.productId },
    );
  }

  async askTkl(request: AskTklRequest): Promise<AskTklRun> {
    const result = await this.request<AskTklRun>(
      "/v1/ask",
      { productId: this.productId },
      { method: "POST", body: request },
    );
    return {
      ...result,
      citations: result.citations.map((citation) => ({
        ...citation,
        href: citation.href.startsWith("/")
          ? `${this.baseUrl}${citation.href}`
          : citation.href,
      })),
    };
  }

  async previewApprovedAction(
    request: ApprovedActionPreviewRequest,
  ): Promise<ApprovedActionPreview> {
    const response = await this.request<{ preview: ApprovedActionPreview }>(
      "/v1/actions/previews",
      { productId: this.productId },
      { method: "POST", body: request },
    );
    return response.preview;
  }

  async approveAction(preview: ApprovedActionPreview): Promise<ApprovedActionApproval> {
    const response = await this.request<{ approval: ApprovedActionApproval }>(
      "/v1/actions/approvals",
      { productId: this.productId },
      {
        method: "POST",
        body: {
          actionType: preview.actionType,
          previewId: preview.id,
          previewHash: preview.previewHash,
          idempotencyKey: `approve:${preview.id}`,
        },
      },
    );
    return response.approval;
  }

  async executeApprovedAction(
    preview: ApprovedActionPreview,
    approval: ApprovedActionApproval,
  ): Promise<ApprovedActionExecution> {
    const response = await this.request<{ execution: ApprovedActionExecution }>(
      "/v1/actions/executions",
      { productId: this.productId },
      {
        method: "POST",
        body: {
          actionType: preview.actionType,
          approvalId: approval.id,
          previewHash: preview.previewHash,
          sourceVersions: preview.sourceVersions,
          idempotencyKey: `execute:${approval.id}`,
        },
      },
    );
    return response.execution;
  }

  runCoverageContextAgent(workItemId: string): Promise<CoverageContextAgentRun> {
    return this.request<CoverageContextAgentRun>(
      "/v1/agents/coverage-context/runs",
      { productId: this.productId },
      { method: "POST", body: { workItemId } },
    );
  }

  runTestDesignerAgent(
    workItemId: string,
    target?: { suiteId: string; sectionId: string },
  ): Promise<TestDesignerAgentRun> {
    return this.request<TestDesignerAgentRun>(
      "/v1/agents/test-designer/runs",
      { productId: this.productId },
      {
        method: "POST",
        body: {
          workItemId,
          ...target,
          ...(target ? { designMode: "automation-ready" } : {}),
        },
      },
    );
  }

  runTestRailImprovementAgent(workItemId: string): Promise<TestRailImprovementAgentRun> {
    return this.request<TestRailImprovementAgentRun>(
      "/v1/agents/testrail-improvement/runs",
      { productId: this.productId },
      { method: "POST", body: { workItemId } },
    );
  }

  runTestRailCaseImprovementAgent(caseId: string): Promise<TestRailImprovementAgentRun> {
    const normalized = caseId.trim().replace(/^C/i, "");
    return this.request<TestRailImprovementAgentRun>(
      `/v1/agents/testrail-improvement/cases/${encodeURIComponent(normalized)}/runs`,
      { productId: this.productId },
      { method: "POST", body: {} },
    );
  }

  runAutomationDesignerAgent(workItemId: string): Promise<AutomationDesignerAgentRun> {
    return this.request<AutomationDesignerAgentRun>(
      "/v1/agents/automation-designer/runs",
      { productId: this.productId },
      { method: "POST", body: { workItemId } },
    );
  }

  runReliabilityDefectIntelligenceAgent(
    workItemId: string,
  ): Promise<ReliabilityDefectIntelligenceAgentRun> {
    return this.request<ReliabilityDefectIntelligenceAgentRun>(
      "/v1/agents/reliability-defect-intelligence/runs",
      { productId: this.productId },
      { method: "POST", body: { workItemId } },
    );
  }

  runReportPortalReliabilityAgent(
    identity: string,
  ): Promise<ReliabilityDefectIntelligenceAgentRun> {
    return this.request<ReliabilityDefectIntelligenceAgentRun>(
      "/v1/agents/reliability-defect-intelligence/reportportal/runs",
      { productId: this.productId },
      { method: "POST", body: { identity } },
    );
  }

  runKnowledgeCuratorAgent(workItemId: string): Promise<KnowledgeCuratorAgentRun> {
    return this.request<KnowledgeCuratorAgentRun>(
      "/v1/agents/knowledge-curator/runs",
      { productId: this.productId },
      { method: "POST", body: { workItemId } },
    );
  }

  async getSourceConnections(): Promise<SourceConnection[]> {
    const response = await this.request<{ connections: SourceConnection[] }>(
      "/v1/source-connections",
      { productId: this.productId },
    );
    return response.connections;
  }

  async getGitHubRepositories(): Promise<GitHubRepository[]> {
    const response = await this.request<{ repositories: GitHubRepository[] }>(
      "/v1/source-connections/github/repositories",
      { productId: this.productId },
    );
    return response.repositories;
  }

  async getGitHubRepository(repositoryId: string): Promise<GitHubRepository> {
    const response = await this.request<{ repository: GitHubRepository }>(
      `/v1/source-connections/github/repositories/${encodeURIComponent(repositoryId)}`,
      { productId: this.productId },
    );
    return response.repository;
  }

  async createGitHubRepository(
    request: CreateGitHubRepositoryRequest,
  ): Promise<GitHubRepository> {
    const response = await this.request<{ repository: GitHubRepository }>(
      "/v1/source-connections/github/repositories",
      { productId: this.productId },
      { method: "POST", body: request },
    );
    return response.repository;
  }

  async updateGitHubRepository(
    repositoryId: string,
    request: UpdateGitHubRepositoryRequest,
  ): Promise<GitHubRepository> {
    const response = await this.request<{ repository: GitHubRepository }>(
      `/v1/source-connections/github/repositories/${encodeURIComponent(repositoryId)}`,
      { productId: this.productId },
      { method: "PATCH", body: request },
    );
    return response.repository;
  }

  async deleteGitHubRepository(repositoryId: string): Promise<GitHubRepository> {
    const response = await this.request<{ repository: GitHubRepository }>(
      `/v1/source-connections/github/repositories/${encodeURIComponent(repositoryId)}`,
      { productId: this.productId },
      { method: "DELETE" },
    );
    return response.repository;
  }

  async testGitHubRepository(repositoryId: string): Promise<GitHubRepository> {
    const response = await this.request<{ repository: GitHubRepository }>(
      `/v1/source-connections/github/repositories/${encodeURIComponent(repositoryId)}/test`,
      { productId: this.productId },
      { method: "POST" },
    );
    return response.repository;
  }

  async syncGitHubRepository(repositoryId: string): Promise<GitHubRepository> {
    const response = await this.request<{ repository: GitHubRepository }>(
      `/v1/source-connections/github/repositories/${encodeURIComponent(repositoryId)}/sync`,
      { productId: this.productId },
      { method: "POST" },
    );
    return response.repository;
  }

  async cancelGitHubRepositorySync(repositoryId: string): Promise<GitHubRepository> {
    const response = await this.request<{ repository: GitHubRepository }>(
      `/v1/source-connections/github/repositories/${encodeURIComponent(repositoryId)}/sync`,
      { productId: this.productId },
      { method: "DELETE" },
    );
    return response.repository;
  }

  async discoverTestRailSuites(
    request: DiscoverTestRailSuitesRequest,
  ): Promise<TestRailSuite[]> {
    const response = await this.request<{ suites: TestRailSuite[] }>(
      "/v1/source-connections/testrail/discover",
      { productId: this.productId },
      { method: "POST", body: request },
    );
    return response.suites;
  }

  async discoverTestRailSections(suiteId: string): Promise<TestRailSection[]> {
    const response = await this.request<{ sections: TestRailSection[] }>(
      "/v1/source-connections/testrail/sections",
      { productId: this.productId },
      { method: "POST", body: { suiteId } },
    );
    return response.sections;
  }

  async discoverConfluencePages(
    request: DiscoverConfluencePagesRequest,
  ): Promise<ConfluencePageDiscovery> {
    const response = await this.request<{ discovery: ConfluencePageDiscovery }>(
      "/v1/source-connections/confluence/discover",
      { productId: this.productId },
      { method: "POST", body: request },
    );
    return response.discovery;
  }

  async saveSourceConnection(
    source: SourceConnectionId,
    request: SaveSourceConnectionRequest,
  ): Promise<SourceConnection> {
    const response = await this.request<{ connection: SourceConnection }>(
      `/v1/source-connections/${source}`,
      { productId: this.productId },
      { method: "PUT", body: request },
    );
    return response.connection;
  }

  async testSourceConnection(source: SourceConnectionId): Promise<SourceConnection> {
    const response = await this.request<{ connection: SourceConnection }>(
      `/v1/source-connections/${source}/test`,
      { productId: this.productId },
      { method: "POST" },
    );
    return response.connection;
  }

  async syncSourceConnection(source: SourceConnectionId): Promise<SourceConnection> {
    const response = await this.request<{ connection: SourceConnection }>(
      `/v1/source-connections/${source}/sync`,
      { productId: this.productId },
      { method: "POST" },
    );
    return response.connection;
  }

  async cancelSourceConnectionSync(source: SourceConnectionId): Promise<SourceConnection> {
    const response = await this.request<{ connection: SourceConnection }>(
      `/v1/source-connections/${source}/sync`,
      { productId: this.productId },
      { method: "DELETE" },
    );
    return response.connection;
  }

  async disconnectSourceConnection(source: SourceConnectionId): Promise<SourceConnection> {
    const response = await this.request<{ connection: SourceConnection }>(
      `/v1/source-connections/${source}`,
      { productId: this.productId },
      { method: "DELETE" },
    );
    return response.connection;
  }
}
