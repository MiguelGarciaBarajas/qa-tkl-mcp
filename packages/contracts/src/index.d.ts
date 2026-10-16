export const CONTRACT_VERSION: "0.1";
export const PRODUCT_CONFIG_VERSION: "0.1";
export const PRODUCT_ID_PATTERN: RegExp;
export const RESOURCE_ID_PATTERN: RegExp;
export const PLUGIN_ID_PATTERN: RegExp;
export const CREDENTIAL_REF_PATTERN: RegExp;
export const SOURCE_IDS: readonly SourceId[];
export const RAW_EVIDENCE_CLASSIFICATIONS: readonly DataClassification[];
export const SOURCE_CONFIGURATION_STATUSES: readonly SourceConfigurationStatus[];
export const MAX_INCREMENTAL_LOOKBACK_SECONDS: number;

export type SourceId =
  | "jira"
  | "github"
  | "testrail"
  | "confluence"
  | "reportportal"
  | "qa-brain";

export type DataClassification = "internal" | "confidential" | "restricted";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PluginManifest {
  id: string;
  version: string;
  contractVersion: string;
  capabilities: string[];
  requiredPermissions: string[];
}

export interface PluginFactoryContext<
  TConfiguration extends SourceConfiguration = SourceConfiguration,
  TDependencies extends Record<string, unknown> = Record<string, unknown>,
> {
  tenantId: string;
  productId: string;
  credentialRef?: CredentialReference;
  configuration: TConfiguration;
  dependencies: TDependencies;
}

export interface PluginRegistration<
  TPlugin = unknown,
  TContext extends PluginFactoryContext = PluginFactoryContext,
> {
  manifest: PluginManifest;
  create(context: TContext): TPlugin;
}

export interface RawEvidenceRecord<TPayload = unknown> {
  tenantId: string;
  productId: string;
  source: SourceId | (string & {});
  sourceId: string;
  sourceVersion: string;
  sourceUrl?: string;
  observedAt: string;
  contentType: string;
  contentHash: string;
  payload: TPayload;
  classification: DataClassification;
  idempotencyKey?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export type CredentialReference = `secret://${string}` | `env://${string}`;
export type SourceConfigurationStatus = "ready" | "pending-external-input" | "disabled";

export interface SourceConfiguration {
  enabled?: boolean;
  configurationStatus?: SourceConfigurationStatus;
  [key: string]: JsonValue | undefined;
}

export interface ProductConfiguration {
  configVersion: typeof PRODUCT_CONFIG_VERSION;
  tenantId: string;
  productId: string;
  enabledPlugins: string[];
  plannedPlugins?: string[];
  credentialRefs: Record<string, CredentialReference>;
  sources: Partial<Record<SourceId, SourceConfiguration>>;
}

export type SyncCheckpoint<TState extends Record<string, unknown> = Record<string, unknown>> = {
  observedAt?: string;
  cursor?: string;
} & TState;

export type ConnectorStatus = "healthy" | "degraded" | "down" | "disabled";

export interface ConnectorHealth<
  TCheckpoint extends SyncCheckpoint = SyncCheckpoint,
> {
  pluginId: string;
  status: ConnectorStatus;
  credentialRef?: string;
  records?: number;
  retries?: number;
  failures?: number;
  lastSyncAt?: string | null;
  lastSuccessfulSyncAt?: string;
  lastCheckpoint?: TCheckpoint | null;
  message?: string;
}

export interface SourceConnector<
  TPayload = unknown,
  TCheckpoint extends SyncCheckpoint = SyncCheckpoint,
> {
  manifest?: PluginManifest;
  validateConfiguration(): Promise<ValidationResult>;
  collect(checkpoint?: TCheckpoint): AsyncIterable<RawEvidenceRecord<TPayload>>;
  health(): Promise<ConnectorHealth<TCheckpoint>>;
}

export interface Provenance {
  source: string;
  sourceId: string;
  sourceVersion: string;
  contentHash: string;
  observedAt: string;
  normalizerId: string;
  normalizerVersion: string;
}

export type ProvenanceCollection = Provenance | Provenance[];

export type CanonicalEntityType =
  | "requirement"
  | "story"
  | "test"
  | "manual-test"
  | "test-suite"
  | "test-execution"
  | "defect"
  | "documentation";

export interface CanonicalEntity<TMetadata = Record<string, unknown>> {
  id: string;
  tenantId: string;
  productId: string;
  type: CanonicalEntityType;
  title: string;
  provenance: ProvenanceCollection;
  metadata?: TMetadata;
}

export type ClaimOrigin = "explicit" | "inferred";
export type ClaimStatus = "pending" | "approved" | "rejected" | "conflict";

export interface Claim<TValue = unknown> {
  id: string;
  entityId: string;
  attribute: string;
  value: TValue;
  origin: ClaimOrigin;
  confidence: number;
  status: ClaimStatus;
  provenance: ProvenanceCollection;
}

export type TraceLinkType =
  | "verifies"
  | "implements"
  | "relates_to"
  | "conflicts_with"
  | "contains"
  | "executed_by";

export interface TraceLink {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  type: TraceLinkType;
  origin: ClaimOrigin;
  confidence: number;
  provenance: ProvenanceCollection;
}

export interface NormalizationResult {
  entities: CanonicalEntity[];
  claims: Claim[];
  traceLinks: TraceLink[];
}

export interface Normalizer {
  supports(record: RawEvidenceRecord): boolean;
  normalize(record: RawEvidenceRecord): Promise<NormalizationResult>;
}

export interface Analyzer<TInput, TOutput> {
  manifest: PluginManifest;
  analyze(input: TInput): Promise<TOutput>;
}

export interface ConflictRecord {
  id: string;
  entityId: string;
  claimIds: string[];
  reason: string;
  detectedAt: string;
  status: "open" | "reviewed";
}

export interface ClaimReviewInput {
  claimId: string;
  decision: "approved" | "rejected";
  reviewerId: string;
  reviewedAt: string;
  note?: string;
}

export interface ConflictReviewInput {
  conflictId: string;
  approvedClaimIds: string[];
  reviewerId: string;
  reviewedAt: string;
  note?: string;
}

export interface KnowledgeReviewRecord {
  id: string;
  entityId: string;
  targetType: "claim" | "conflict";
  targetId: string;
  decision: "approved" | "rejected" | "resolved";
  approvedClaimIds?: string[];
  reviewerId: string;
  reviewedAt: string;
  note?: string;
}

export interface CoverageResult {
  requirementId: string;
  numerator: number;
  denominator: number;
  linkConfidence: number;
  uncovered: string[];
}

export interface CoverageAnalysisResult extends CoverageResult {
  policy: {
    version: string;
    provisional: boolean;
  };
  manualCoverage: RequirementCoverageDimension;
  automatedCoverage: RequirementCoverageDimension;
  executionFreshness: ExecutionFreshnessDimension;
  combinedCoverage: CombinedCoverage;
}

export type CoverageFinding = CoverageResult | CoverageAnalysisResult;

export interface RequirementCoverageDimension {
  status: "evaluated";
  basis: "requirement-link";
  numerator: number;
  denominator: number;
  ratio: number;
  evidenceEntityIds: string[];
}

interface ExecutionFreshnessFields {
  numerator: number;
  denominator: number;
  coveredEntityIds: string[];
  uncoveredEntityIds: string[];
  staleEntityIds: string[];
  nonQualifyingEntityIds: string[];
  missingExecutionEntityIds: string[];
}

export type ExecutionFreshnessDimension =
  | ExecutionFreshnessFields & {
      status: "evaluated";
      ratio: number;
      reason?: never;
    }
  | ExecutionFreshnessFields & {
      status: "not-evaluated";
      ratio: null;
      reason: string;
    };

export interface CoverageWeights {
  manual: number;
  automated: number;
  executionFreshness: number;
}

export type CombinedCoverage =
  | {
      status: "evaluated";
      score: number;
      weights: CoverageWeights;
      reason?: never;
    }
  | {
      status: "not-evaluated";
      score: null;
      weights: CoverageWeights | null;
      reason: string;
    };

export interface SearchQualityKnowledgeResult<TItem = CanonicalEntity> {
  productId: string;
  query: string;
  items: TItem[];
  limit: number;
  offset?: number;
}

export interface StoryTestContextResult<
  TRequirement = CanonicalEntity,
  TTest = CanonicalEntity,
  TDefect = CanonicalEntity,
> {
  productId: string;
  storyId: string;
  requirements: TRequirement[];
  tests: TTest[];
  defects: TDefect[];
  provenance: Provenance[];
}

export interface RequirementCoverageResult<TFinding = CoverageResult> {
  productId: string;
  requirementId: string;
  findings: TFinding[];
  provenance: Provenance[];
}

export interface TraceabilityExplanationResult<TRelationship = TraceLink> {
  productId: string;
  requirementId: string;
  relationships: TRelationship[];
  provenance: Provenance[];
}

export interface KnowledgeConflictsResult<TConflict = ConflictRecord> {
  productId: string;
  conflicts: TConflict[];
  provenance: Provenance[];
}

export interface ResourceReadResult<TContent = unknown> {
  productId: string;
  uri: string;
  contents: TContent[];
}

export interface HealthResult {
  status: string;
  service: string;
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

export interface AskTklResult {
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
  conflicts: Array<{ id: string; entityId: string; reason: string }>;
  limitations: string[];
  nextActions: string[];
  toolCalls: Array<{ capability: string; status: string; summary: string }>;
}

export type ApprovedActionType =
  | "testrail.case.create"
  | "testrail.case.update"
  | "github.branch.create"
  | "github.pull-request.create";

export interface ApprovedActionSourceVersion {
  source: "testrail" | "github";
  sourceId: string;
  sourceVersion: string;
}

export interface ApprovedActionPreview {
  id: string;
  schemaVersion: 1;
  tenantId: string;
  productId: string;
  subject: string;
  actionType: ApprovedActionType;
  target: Record<string, JsonValue>;
  changes: Record<string, JsonValue>;
  sourceVersions: ApprovedActionSourceVersion[];
  requiredPermission: string;
  previewHash: string;
  idempotencyKey: string;
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
  tenantId: string;
  productId: string;
  subject: string;
  actionType: ApprovedActionType;
  requiredPermission: string;
  idempotencyKey: string;
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
  tenantId: string;
  productId: string;
  subject: string;
  actionType: ApprovedActionType;
  idempotencyKey: string;
  status: "blocked";
  externalCallMade: boolean;
  reason: { code: string; message: string } | null;
  attemptedAt: string;
  completedAt: string | null;
  recovery: { required: boolean; instructions: string };
}

export interface ApprovedActionPreviewResult {
  preview: ApprovedActionPreview;
}

export interface ApprovedActionApprovalResult {
  approval: ApprovedActionApproval;
}

export interface ApprovedActionExecutionResult {
  execution: ApprovedActionExecution;
}

export interface ApplicationResultMap {
  health: HealthResult;
  ask_tkl: AskTklResult;
  approved_action_preview: ApprovedActionPreviewResult;
  approved_action_approval: ApprovedActionApprovalResult;
  approved_action_execution: ApprovedActionExecutionResult;
  search_quality_knowledge: SearchQualityKnowledgeResult;
  get_story_test_context: StoryTestContextResult;
  analyze_requirement_coverage: RequirementCoverageResult<CoverageFinding>;
  explain_traceability: TraceabilityExplanationResult;
  list_knowledge_conflicts: KnowledgeConflictsResult;
  read_resource: ResourceReadResult;
}

export type ApplicationOperationName = keyof ApplicationResultMap;
export type ToolName = Exclude<
  ApplicationOperationName,
  | "health"
  | "ask_tkl"
  | "approved_action_preview"
  | "approved_action_approval"
  | "approved_action_execution"
>;

export interface ApplicationError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ToolInputSchema = {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, Record<string, unknown>>;
};

export const TOOL_INPUT_SCHEMAS: { readonly [K in ToolName]: ToolInputSchema };
export const API_RESPONSE_SCHEMAS: { readonly [K in ApplicationOperationName]: {
  required: string[];
  properties: Record<string, string>;
} };

export function canonicalize<T extends JsonValue>(value: T): T;
export function stableJson(value: JsonValue): string;
export function sha256(value: string | JsonValue): string;
export function assertIncrementalLookbackSeconds(value: unknown): number | undefined;
export function sourceTimestampMillis(value: unknown): number | null;
export function sourceTimestampIso(value: unknown): string | undefined;
export function assertPluginManifest<T extends PluginManifest>(manifest: T): T;
export function assertRawEvidenceRecord<T extends RawEvidenceRecord>(record: T): T;
export function createRawEvidenceRecord<TPayload extends JsonValue>(
  input: Omit<RawEvidenceRecord<TPayload>, "contentHash"> & { contentHash?: string },
): RawEvidenceRecord<TPayload>;
export function validateProductConfiguration(value: unknown): ValidationResult;
export function assertProductConfiguration<T extends ProductConfiguration>(value: T): T;
export function validateToolArguments(
  name: string,
  value: unknown,
): { valid: boolean; message?: string; parameter?: string };
export function validateApiResponse(
  name: string,
  value: unknown,
): { valid: boolean; message?: string; parameter?: string };
