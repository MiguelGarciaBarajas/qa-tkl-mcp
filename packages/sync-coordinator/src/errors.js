/**
 * Explicit, sanitized error types for the OPS-101 sync coordinator.
 *
 * Every error raised here carries only identifiers, policy names, and fixed
 * text written in this file. A coordinator error is never built from a
 * connector's or a store's raw error message, because those can embed
 * filesystem paths, source URLs, response bodies, or (for a misbehaving
 * source) credential-shaped strings. Raw errors still propagate to the
 * caller unchanged when a run is invoked directly; what is *reported* in a
 * run summary, audit event, or health snapshot is always the reduced,
 * allowlisted shape produced by {@link describeError}.
 */

const SAFE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Raised when coordinator/schedule/run options fail closed during validation. */
export class SyncConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncConfigurationError";
  }
}

/**
 * Raised when a run for the same tenant/product/connector is already in
 * flight and the configured overlap policy is `"fail"`. Carries only scope
 * identifiers, so it is always safe to log.
 */
export class SyncRunConflictError extends Error {
  constructor({ tenantId, productId, connectorId }) {
    super(
      `A sync run is already in progress for ${tenantId}/${productId}/${connectorId} in this process`,
    );
    this.name = "SyncRunConflictError";
    this.tenantId = tenantId;
    this.productId = productId;
    this.connectorId = connectorId;
  }
}

/**
 * Raised when a replay mode is requested without the explicit confirmation
 * token. Replays re-read a source from an earlier position and are never
 * inferred from a default.
 */
export class ReplayConfirmationRequiredError extends Error {
  constructor(mode) {
    super(
      `Sync mode "${mode}" is a replay and requires an explicit confirmReplay: true option; ` +
        "replays are never started implicitly",
    );
    this.name = "ReplayConfirmationRequiredError";
    this.mode = mode;
  }
}

/** Raised when a retention policy asks for behavior the durable store cannot provide safely. */
export class RetentionPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetentionPolicyError";
  }
}

/**
 * Raised when a mutating maintenance action (a reconciliation repair or a
 * rebuild that would process the full matched set) is requested without the
 * explicit confirmation token. Like replays, these are never inferred from a
 * default: an operator must opt in, or bound the work with an explicit limit.
 */
export class MaintenanceConfirmationRequiredError extends Error {
  constructor(operation) {
    super(
      `Maintenance operation "${operation}" mutates durable state or is unbounded and requires ` +
        "an explicit confirm: true option or a finite limit; it is never started implicitly",
    );
    this.name = "MaintenanceConfirmationRequiredError";
    this.operation = operation;
  }
}

/**
 * Raised when a maintenance operation cannot take the in-process run lock for
 * its scope because a sync run or another maintenance operation is already in
 * flight. Carries only scope identifiers, so it is always safe to log.
 */
export class MaintenanceLockError extends Error {
  constructor({ tenantId, productId, connectorId }) {
    super(
      `A run is already in progress for ${tenantId}/${productId}/${connectorId} in this process; ` +
        "maintenance operations refuse to overlap it",
    );
    this.name = "MaintenanceLockError";
    this.tenantId = tenantId;
    this.productId = productId;
    this.connectorId = connectorId;
  }
}

/**
 * Raised when a connector's proposed checkpoint is not a plain,
 * JSON-serializable object. A checkpoint is committed into durable storage
 * and replayed into the connector on the next run, so an unusable value
 * fails the batch closed instead of being coerced or dropped silently.
 */
export class CheckpointValidationError extends Error {
  constructor(connectorId, reason) {
    super(`Checkpoint proposed by connector "${connectorId}" is invalid: ${reason}`);
    this.name = "CheckpointValidationError";
    this.connectorId = connectorId;
  }
}

/**
 * Reduces an arbitrary thrown value to a sanitized, structured descriptor
 * safe for run summaries, audit events, and health snapshots. The error's
 * message and stack are deliberately dropped: only an allowlisted error
 * name, a short machine code, and an HTTP-shaped status (all of which the
 * connectors already treat as safe to surface) survive.
 */
export function describeError(error, stage) {
  const name = SAFE_NAME_PATTERN.test(error?.name ?? "") ? error.name : "Error";
  const descriptor = { stage, name };
  if (typeof error?.code === "string" && SAFE_CODE_PATTERN.test(error.code)) {
    descriptor.code = error.code;
  }
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    descriptor.status = status;
  }
  return Object.freeze(descriptor);
}
