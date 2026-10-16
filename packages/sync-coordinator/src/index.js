/**
 * `@tkl/sync-coordinator` (OPS-101): scheduled incremental sync, durable
 * checkpoint recovery, replay procedures, and non-destructive retention
 * reporting for a single tenant/product scope.
 *
 * Source-neutral by construction: connectors come from `@tkl/ingestion`
 * composition of validated product configuration, and evidence/checkpoints
 * go through the `@tkl/raw-evidence-store` contract. Nothing here knows
 * about Jira, GitHub, or TestRail.
 */
export { createSyncCoordinator, SYNC_MODES, CHECKPOINT_POLICIES } from "./coordinator.js";
export {
  assertCronExpression,
  assertScheduleApproved,
  describeSchedule,
  resolveSyncSettings,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  OVERLAP_POLICIES,
  SCHEDULE_CADENCES,
  SCHEDULE_STATUSES,
} from "./schedule.js";
export { planRetention, RETENTION_MODES } from "./retention.js";
export {
  reconcileEvidence,
  applyReconciliationRepairs,
  selectRawRecords,
  rawEvidenceChecksum,
} from "./reconcile.js";
export {
  planSilverRebuild,
  rebuildSilverFromRawEvidence,
  rebuildGoldProjections,
} from "./rebuild.js";
export { acquireRunLock, isRunInProgress, listActiveRuns, runLockKey } from "./locks.js";
export { sanitizeOperationsData, SanitizationError } from "./sanitize.js";
export {
  CheckpointValidationError,
  MaintenanceConfirmationRequiredError,
  MaintenanceLockError,
  ReplayConfirmationRequiredError,
  RetentionPolicyError,
  SyncConfigurationError,
  SyncRunConflictError,
  describeError,
} from "./errors.js";
