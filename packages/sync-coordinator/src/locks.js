/**
 * Process-wide run locks for OPS-101.
 *
 * A scheduled sync is expected to be invoked by an external cron/job runner
 * (see `./schedule.js`), and a slow run can still be in flight when the next
 * tick fires. Two overlapping runs against the same
 * tenant/product/connector would re-read the same source pages, race their
 * checkpoint commits, and make a run summary disagree with what the durable
 * store actually holds, so they are prevented here.
 *
 * Scope of this guarantee -- deliberately narrow and stated exactly:
 *
 * - **Within one process** (including two different coordinator instances
 *   built in the same process), the registry below is authoritative: a
 *   second run for a locked scope never starts.
 * - **Across processes**, this registry proves nothing: it is plain
 *   in-memory state. `@tkl/raw-evidence-store` has no cross-process lock or
 *   database transaction either (its `PersistentRawEvidenceStore`
 *   serializes commits per *instance* only), so two ingestion *processes*
 *   writing the same tenant/product scope directory can still race the
 *   atomic rename. A deployment must therefore run one ingestion process
 *   per tenant/product scope. For deployments that can provide a real
 *   mutual-exclusion primitive (a lease in a database, a cloud blob lease,
 *   a job runner's own "no concurrent runs" setting), the coordinator
 *   accepts an `externalLock` seam with the small interface documented in
 *   the package README; it is never emulated with a lock file here, because
 *   an advisory lock file on a network filesystem would imply a guarantee
 *   this package cannot actually make.
 */

/** key -> owner token. Module-level on purpose: the guarantee is per process, not per instance. */
const activeRuns = new Map();

export function runLockKey({ tenantId, productId, connectorId }) {
  return `${tenantId}/${productId}/${connectorId}`;
}

/** True when a run currently holds the in-process lock for this scope. */
export function isRunInProgress(scope) {
  return activeRuns.has(runLockKey(scope));
}

/** Sanitized snapshot of in-flight runs: identifiers and timestamps only. */
export function listActiveRuns() {
  return [...activeRuns.entries()].map(([key, owner]) => ({
    scope: key,
    runId: owner.runId,
    connectorId: owner.connectorId,
    startedAt: owner.startedAt,
  }));
}

/**
 * Attempts to take the in-process lock for a scope. Returns `null` when the
 * scope is already locked (the caller decides whether that is a skip or a
 * failure, per its overlap policy) and a release handle otherwise. Release
 * is idempotent and only ever clears an entry this handle still owns, so a
 * late double-release can never free a lock that a subsequent run has since
 * acquired.
 */
export function acquireRunLock(scope, { runId, startedAt }) {
  const key = runLockKey(scope);
  if (activeRuns.has(key)) return null;
  const owner = { runId, connectorId: scope.connectorId, startedAt };
  activeRuns.set(key, owner);
  let released = false;
  return {
    key,
    release() {
      if (released) return;
      released = true;
      if (activeRuns.get(key) === owner) activeRuns.delete(key);
    },
  };
}
