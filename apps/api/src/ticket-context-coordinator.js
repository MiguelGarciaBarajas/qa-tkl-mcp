import { ApiError } from "./errors.js";
import { createHash } from "node:crypto";

const JIRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_FRESHNESS_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_JOBS = 10_000;
const DEFAULT_MAX_RECEIPTS = 20_000;
const DEFAULT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_QUEUE_AGE_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_RETRY_BACKLOG = 100;
const SOURCES = ["jira", "testrail", "github"];
const TERMINAL_JOB_STATES = new Set(["complete", "partial", "unavailable", "cancelled"]);
const SUCCESS_SOURCE_STATES = new Set(["local", "refreshed", "complete"]);
const NON_RETRYABLE_CODES = new Set([
  "invalid_issue_key",
  "invalid_request",
  "source_not_connected",
  "retrieval_not_supported",
  "ingestion_not_supported",
  "source_authorization_failed",
  "source_configuration_invalid"
]);

function clone(value) {
  return structuredClone(value);
}

function canonicalIssueKey(value) {
  if (typeof value !== "string" || !JIRA_KEY_PATTERN.test(value)) {
    throw new ApiError(400, "invalid_issue_key", "issueKey must be a Jira key such as STT-3731.");
  }
  return value.toUpperCase();
}

function jobKey(productId, issueKey) {
  return `${productId}:${issueKey}`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function emptyInvalidation() {
  return {
    generation: 0,
    runningGeneration: null,
    refreshAfterRun: false,
    sources: Object.fromEntries(SOURCES.map((source) => [
      source,
      {
        stale: false,
        generation: 0,
        observedAt: null,
        eventIdDigest: null,
        latestSuccessfulCompletionAt: null
      }
    ]))
  };
}

function emptySource(state = "pending") {
  return {
    state,
    startedAt: null,
    completedAt: null,
    attemptCount: 0,
    recordsCollected: 0,
    truncated: false,
    error: null
  };
}

function sanitizeError(error, fallbackCode = "source_unavailable") {
  const code = typeof error?.code === "string" && /^[a-z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === "string" && error.message.length > 0
    ? error.message.slice(0, 300)
    : "The source is temporarily unavailable.";
  return { code, message };
}

function sourceOutcome(result, timestamp, attemptCount, startedAt) {
  const state = [
    "complete",
    "partial",
    "unavailable",
    "not-connected",
    "cancelled"
  ].includes(result?.status)
    ? result.status
    : "unavailable";
  return {
    state,
    startedAt,
    completedAt: timestamp,
    attemptCount,
    recordsCollected: Number.isSafeInteger(result?.recordsCollected)
      ? Math.max(0, result.recordsCollected)
      : 0,
    truncated: result?.truncated === true || state === "partial",
    error: result?.error ? sanitizeError(result.error) : null
  };
}

function completenessFor(job) {
  const secondary = [job.sources.testrail, job.sources.github];
  if (job.state === "cancelled") {
    return { status: "cancelled", complete: false, reasons: ["cancelled"] };
  }
  if (["pending", "running"].includes(job.state)) {
    return { status: "pending", complete: false, reasons: ["secondary_enrichment_pending"] };
  }
  const reasons = [];
  for (const [source, outcome] of Object.entries(job.sources)) {
    if (outcome.truncated) reasons.push(`${source}_budget_exhausted`);
    if (outcome.error) reasons.push(`${source}_refresh_failed`);
    if (["partial", "unavailable", "not-connected", "cancelled"].includes(outcome.state)) {
      reasons.push(`${source}_${outcome.state}`);
    }
  }
  const complete = ["local", "refreshed", "complete"].includes(job.sources.jira.state)
    && !job.sources.jira.truncated
    && !job.sources.jira.error
    && secondary.every((outcome) => outcome.state === "complete" && !outcome.truncated);
  return {
    status: complete
      ? "complete"
      : secondary.some((outcome) => ["complete", "partial"].includes(outcome.state))
        ? "partial"
        : "unavailable",
    complete,
    reasons: [...new Set(reasons)]
  };
}

function publicJob(job) {
  const copy = clone(job);
  delete copy.force;
  delete copy.retryCount;
  delete copy.invalidation;
  return copy;
}

export function createTicketContextCoordinator({
  store,
  sourceConnectionService,
  freshnessMs = DEFAULT_FRESHNESS_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  concurrency = DEFAULT_CONCURRENCY,
  retentionMs = DEFAULT_RETENTION_MS,
  maxJobs = DEFAULT_MAX_JOBS,
  receiptRetentionMs = DEFAULT_RECEIPT_RETENTION_MS,
  maxReceipts = DEFAULT_MAX_RECEIPTS,
  retentionSweepIntervalMs = DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
  maxQueueAgeMs = DEFAULT_MAX_QUEUE_AGE_MS,
  maxRetryBacklog = DEFAULT_MAX_RETRY_BACKLOG,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setIntervalTimer = setInterval,
  clearIntervalTimer = clearInterval,
  auditLogger
}) {
  if (!store || typeof store.read !== "function" || typeof store.transact !== "function") {
    throw new TypeError("ticket context job store is required");
  }
  if (!sourceConnectionService || typeof sourceConnectionService.enrichJiraIssue !== "function") {
    throw new TypeError("sourceConnectionService.enrichJiraIssue is required");
  }
  for (const [name, value, minimum] of [
    ["freshnessMs", freshnessMs, 0],
    ["maxAttempts", maxAttempts, 1],
    ["retryBaseMs", retryBaseMs, 1],
    ["retryMaxMs", retryMaxMs, 1],
    ["concurrency", concurrency, 1],
    ["retentionMs", retentionMs, 1],
    ["maxJobs", maxJobs, 1],
    ["receiptRetentionMs", receiptRetentionMs, 1],
    ["maxReceipts", maxReceipts, 1],
    ["retentionSweepIntervalMs", retentionSweepIntervalMs, 1],
    ["maxQueueAgeMs", maxQueueAgeMs, 1],
    ["maxRetryBacklog", maxRetryBacklog, 0]
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}`);
    }
  }

  const queue = [];
  const queued = new Set();
  const activeByProduct = new Map();
  const activeByKey = new Map();
  const followUpAfterActive = new Set();
  const pausedProducts = new Map();
  const retryTimers = new Map();
  let activeCount = 0;
  let started = false;
  let stopping = false;
  let retentionTimer = null;
  let retentionSweepRunning = false;
  let lastPersistenceFailure = null;

  function timestamp() {
    return new Date(now()).toISOString();
  }

  function emit(event) {
    Promise.resolve(auditLogger?.record?.(event)).catch(() => {});
  }

  function failureRecord(error, productId = null) {
    return {
      productId,
      at: timestamp(),
      code: typeof error?.code === "string" && /^[a-z0-9_]{1,64}$/.test(error.code)
        ? error.code
        : "context_job_persistence_failed"
    };
  }

  async function readStore() {
    try {
      return await store.read();
    } catch (error) {
      lastPersistenceFailure = failureRecord(error);
      throw error;
    }
  }

  async function transactStore(mutator) {
    try {
      const pendingFailure = lastPersistenceFailure;
      const result = await store.transact((snapshot) => {
        if (pendingFailure) snapshot.failures.persistence = pendingFailure;
        return mutator(snapshot);
      });
      if (pendingFailure === lastPersistenceFailure) lastPersistenceFailure = null;
      return result;
    } catch (error) {
      lastPersistenceFailure = failureRecord(error);
      throw error;
    }
  }

  async function find(productId, issueKey) {
    const snapshot = await readStore();
    return snapshot.jobs.find(
      (job) => job.productId === productId && job.issueKey === issueKey
    ) ?? null;
  }

  async function mutate(productId, issueKey, mutator, { create = false } = {}) {
    return transactStore((snapshot) => {
      let job = snapshot.jobs.find(
        (candidate) => candidate.productId === productId && candidate.issueKey === issueKey
      );
      if (!job && create) {
        if (snapshot.jobs.length >= maxJobs) {
          const terminal = snapshot.jobs
            .map((candidate, index) => ({ candidate, index }))
            .filter(({ candidate }) =>
              TERMINAL_JOB_STATES.has(candidate.state)
              && !activeByKey.has(jobKey(candidate.productId, candidate.issueKey))
            )
            .sort((left, right) =>
              Date.parse(left.candidate.updatedAt) - Date.parse(right.candidate.updatedAt)
            );
          const remove = new Set(
            terminal.slice(0, snapshot.jobs.length - maxJobs + 1).map(({ index }) => index)
          );
          snapshot.jobs = snapshot.jobs.filter((_candidate, index) => !remove.has(index));
        }
        if (snapshot.jobs.length >= maxJobs) {
          throw new ApiError(
            503,
            "context_job_capacity_reached",
            "The ticket context job queue has reached its configured capacity."
          );
        }
        const at = timestamp();
        job = {
          productId,
          issueKey,
          state: "pending",
          createdAt: at,
          updatedAt: at,
          queuedAt: at,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          attemptCount: 0,
          retryCount: 0,
          nextRetryAt: null,
          force: false,
          sources: {
            jira: emptySource(),
            testrail: emptySource(),
            github: emptySource()
          },
          completeness: { status: "pending", complete: false, reasons: ["secondary_enrichment_pending"] },
          invalidation: emptyInvalidation()
        };
        snapshot.jobs.push(job);
      }
      if (!job) return null;
      mutator(job);
      job.updatedAt = timestamp();
      job.completeness = completenessFor(job);
      return publicJob(job);
    });
  }

  function enqueueMemory(productId, issueKey, priority = false) {
    const key = jobKey(productId, issueKey);
    if (queued.has(key) || activeByKey.has(key)) return;
    queued.add(key);
    if (priority) queue.unshift({ productId, issueKey });
    else queue.push({ productId, issueKey });
    queueMicrotask(() => void pump());
  }

  function scheduleRetry(job) {
    const key = jobKey(job.productId, job.issueKey);
    const delay = Math.max(0, Date.parse(job.nextRetryAt) - now());
    const timer = setTimer(() => {
      retryTimers.delete(key);
      enqueueMemory(job.productId, job.issueKey);
    }, delay);
    timer?.unref?.();
    retryTimers.set(key, timer);
  }

  function invalidationStat(snapshot, productId) {
    let stat = snapshot.invalidationStats.find((candidate) => candidate.productId === productId);
    if (!stat) {
      stat = {
        productId,
        counts: {
          accepted: 0,
          duplicate: 0,
          obsolete: 0,
          notHot: 0,
          rejected: 0
        },
        last: null
      };
      snapshot.invalidationStats.push(stat);
    }
    return stat;
  }

  function recordDisposition(snapshot, {
    productId,
    source,
    observedAt = null,
    disposition,
    eventIdDigest = null,
    issueKeyDigest = null
  }) {
    const stat = invalidationStat(snapshot, productId);
    const countKey = disposition === "not-hot" ? "notHot" : disposition;
    stat.counts[countKey] += 1;
    stat.last = {
      source,
      observedAt,
      receivedAt: timestamp(),
      disposition,
      eventIdDigest,
      issueKeyDigest
    };
  }

  async function recordFailure(kind, error, productId = null) {
    const failure = failureRecord(error, productId);
    try {
      await transactStore((snapshot) => {
        snapshot.failures[kind] = failure;
      });
    } catch {
      if (kind === "persistence") lastPersistenceFailure = failure;
    }
  }

  async function sweepRetention() {
    if (retentionSweepRunning) return null;
    retentionSweepRunning = true;
    const startedAt = timestamp();
    try {
      return await transactStore((snapshot) => {
        const jobCutoff = now() - retentionMs;
        const receiptCutoff = now() - receiptRetentionMs;
        const beforeJobs = snapshot.jobs.length;
        const beforeReceipts = snapshot.receipts.length;
        snapshot.jobs = snapshot.jobs.filter((job) => {
          if (!TERMINAL_JOB_STATES.has(job.state)) return true;
          const key = jobKey(job.productId, job.issueKey);
          if (activeByKey.has(key) || queued.has(key) || retryTimers.has(key)) return true;
          const terminalAt = Date.parse(job.completedAt ?? job.cancelledAt ?? job.updatedAt);
          return terminalAt >= jobCutoff;
        });
        snapshot.receipts = snapshot.receipts
          .filter((receipt) => Date.parse(receipt.receivedAt) >= receiptCutoff)
          .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
          .slice(-maxReceipts);
        snapshot.lastRetentionSweep = {
          startedAt,
          completedAt: timestamp(),
          jobsDeleted: beforeJobs - snapshot.jobs.length,
          receiptsDeleted: beforeReceipts - snapshot.receipts.length
        };
        return clone(snapshot.lastRetentionSweep);
      });
    } finally {
      retentionSweepRunning = false;
    }
  }

  function shouldRetry(outcomes) {
    return Object.values(outcomes).some((outcome) =>
      outcome?.status === "unavailable"
      && !NON_RETRYABLE_CODES.has(outcome?.error?.code)
    );
  }

  async function runJob(productId, issueKey) {
    const key = jobKey(productId, issueKey);
    const controller = new AbortController();
    let rerunAfterRelease = false;
    activeByKey.set(key, controller);
    activeByProduct.set(productId, key);
    activeCount += 1;
    try {
      const current = await mutate(productId, issueKey, (job) => {
        job.state = "running";
        job.startedAt = timestamp();
        job.completedAt = null;
        job.cancelledAt = null;
        job.nextRetryAt = null;
        job.attemptCount += 1;
        job.invalidation.runningGeneration = job.invalidation.generation;
        job.invalidation.refreshAfterRun = false;
        for (const source of ["testrail", "github"]) {
          job.sources[source].state = "running";
          job.sources[source].startedAt = job.startedAt;
          job.sources[source].completedAt = null;
          job.sources[source].attemptCount = job.attemptCount;
          job.sources[source].error = null;
        }
        if (job.sources.jira.state === "pending") {
          job.sources.jira.state = "running";
          job.sources.jira.startedAt = job.startedAt;
          job.sources.jira.completedAt = null;
          job.sources.jira.attemptCount += 1;
          job.sources.jira.error = null;
        }
      });
      emit({
        eventType: "ticket-context.enrichment.started",
        productId,
        resourceId: issueKey,
        attemptCount: current.attemptCount
      });
      try {
        if (current.sources.jira.state === "running") {
          if (typeof sourceConnectionService.hydrateJiraIssue !== "function") {
            throw new ApiError(
              409,
              "retrieval_not_supported",
              "Targeted Jira retrieval is not available."
            );
          }
          const jiraResult = await sourceConnectionService.hydrateJiraIssue({
            productId,
            issueKey,
            signal: controller.signal
          });
          await mutate(productId, issueKey, (job) => {
            const completedAt = timestamp();
            job.sources.jira = {
              state: jiraResult?.status === "partial" ? "partial" : "refreshed",
              startedAt: job.sources.jira.startedAt,
              completedAt,
              attemptCount: job.sources.jira.attemptCount,
              recordsCollected: Number.isSafeInteger(jiraResult?.recordsCollected)
                ? Math.max(0, jiraResult.recordsCollected)
                : 0,
              truncated: jiraResult?.truncated === true,
              error: null
            };
            if (job.sources.jira.state === "refreshed") {
              job.invalidation.sources.jira.latestSuccessfulCompletionAt = completedAt;
            }
          });
        }
        const outcomes = await sourceConnectionService.enrichJiraIssue({
          productId,
          issueKey,
          signal: controller.signal
        });
        if (controller.signal.aborted) throw Object.assign(new Error("Cancelled"), {
          code: "retrieval_cancelled"
        });
        const completed = await mutate(productId, issueKey, (job) => {
          const at = timestamp();
          const runningGeneration = job.invalidation.runningGeneration ?? 0;
          for (const source of ["testrail", "github"]) {
            job.sources[source] = sourceOutcome(
              outcomes?.[source],
              at,
              job.attemptCount,
              job.sources[source].startedAt
            );
          }
          for (const source of SOURCES) {
            const invalidation = job.invalidation.sources[source];
            if (SUCCESS_SOURCE_STATES.has(job.sources[source].state)) {
              invalidation.latestSuccessfulCompletionAt = job.sources[source].completedAt;
            }
            if (
              invalidation.stale
              && invalidation.generation <= runningGeneration
              && SUCCESS_SOURCE_STATES.has(job.sources[source].state)
            ) {
              invalidation.stale = false;
            }
          }
          const refreshAfterRun =
            job.invalidation.refreshAfterRun
            || job.invalidation.generation > runningGeneration;
          job.invalidation.runningGeneration = null;
          job.invalidation.refreshAfterRun = false;
          const retryable = shouldRetry(outcomes ?? {});
          if (refreshAfterRun) {
            job.state = "pending";
            job.queuedAt = at;
            job.nextRetryAt = null;
            for (const source of SOURCES) {
              if (job.invalidation.sources[source].stale) {
                job.sources[source] = {
                  ...emptySource(),
                  attemptCount: job.sources[source].attemptCount
                };
              }
            }
          } else if (
            retryable
            && job.attemptCount < maxAttempts
            && !pausedProducts.has(productId)
          ) {
            const delay = Math.min(
              retryMaxMs,
              retryBaseMs * (2 ** Math.max(0, job.attemptCount - 1))
            );
            job.state = "pending";
            job.queuedAt = at;
            job.nextRetryAt = new Date(now() + delay).toISOString();
            job.retryCount += 1;
          } else {
            job.state = Object.values(job.sources)
              .some((source) =>
                ["partial", "unavailable", "not-connected"].includes(source.state)
                || source.truncated
                || source.error
              )
              || !["local", "refreshed", "complete"].includes(job.sources.jira.state)
              ? "partial"
              : "complete";
            job.completedAt = at;
            job.nextRetryAt = null;
          }
        });
        if (completed.state === "pending") {
          if (completed.nextRetryAt) scheduleRetry(completed);
          else rerunAfterRelease = true;
        }
        emit({
          eventType: "ticket-context.enrichment.completed",
          productId,
          resourceId: issueKey,
          status: completed.state,
          attemptCount: completed.attemptCount
        });
      } catch (error) {
        const cancelled = controller.signal.aborted || error?.code === "retrieval_cancelled";
        const deferred = cancelled && (pausedProducts.has(productId) || stopping);
        const failed = await mutate(productId, issueKey, (job) => {
          const at = timestamp();
          const safeError = sanitizeError(error, "enrichment_failed");
          const jiraWasRunning = job.sources.jira.state === "running";
          const runningGeneration = job.invalidation.runningGeneration ?? 0;
          const refreshAfterRun =
            job.invalidation.refreshAfterRun
            || job.invalidation.generation > runningGeneration;
          job.invalidation.runningGeneration = null;
          job.invalidation.refreshAfterRun = false;
          for (const source of ["jira", "testrail", "github"]) {
            if (job.sources[source].state === "running") {
              job.sources[source] = {
                ...job.sources[source],
                state: cancelled ? deferred ? "pending" : "cancelled" : "unavailable",
                startedAt: deferred ? null : job.sources[source].startedAt,
                completedAt: deferred ? null : at,
                error: cancelled ? null : safeError
              };
            }
          }
          if (refreshAfterRun && (!cancelled || deferred)) {
            job.state = "pending";
            job.queuedAt = at;
            job.completedAt = null;
            job.cancelledAt = null;
            job.nextRetryAt = null;
            for (const source of SOURCES) {
              if (job.invalidation.sources[source].stale) {
                job.sources[source] = {
                  ...emptySource(),
                  attemptCount: job.sources[source].attemptCount
                };
              }
            }
          } else if (cancelled) {
            job.state = deferred ? "pending" : "cancelled";
            job.cancelledAt = deferred ? null : at;
            job.completedAt = deferred ? null : at;
            job.queuedAt = deferred ? at : job.queuedAt;
            job.nextRetryAt = null;
          } else if (
            job.attemptCount < maxAttempts
            && !NON_RETRYABLE_CODES.has(safeError.code)
          ) {
            const delay = Math.min(
              retryMaxMs,
              retryBaseMs * (2 ** Math.max(0, job.attemptCount - 1))
            );
            job.state = "pending";
            job.queuedAt = at;
            job.nextRetryAt = new Date(now() + delay).toISOString();
            job.retryCount += 1;
            if (jiraWasRunning) {
              job.sources.jira = {
                ...emptySource(),
                attemptCount: job.sources.jira.attemptCount
              };
            }
          } else {
            job.state = "unavailable";
            job.completedAt = at;
          }
        });
        if (failed.state === "pending" && !pausedProducts.has(productId) && !stopping) {
          if (failed.nextRetryAt) scheduleRetry(failed);
          else rerunAfterRelease = true;
        }
        emit({
          eventType: cancelled
            ? "ticket-context.enrichment.cancelled"
            : "ticket-context.enrichment.failed",
          productId,
          resourceId: issueKey,
          code: error?.code ?? "enrichment_failed"
        });
      }
    } finally {
      activeByKey.delete(key);
      if (activeByProduct.get(productId) === key) activeByProduct.delete(productId);
      activeCount -= 1;
      const memoryFollowUp = followUpAfterActive.delete(key);
      if ((rerunAfterRelease || memoryFollowUp) && !stopping) {
        enqueueMemory(productId, issueKey, true);
      }
      queueMicrotask(() => void pump());
    }
  }

  async function pump() {
    if (!started || stopping || activeCount >= concurrency) return;
    let index = queue.findIndex(({ productId }) =>
      !pausedProducts.has(productId) && !activeByProduct.has(productId)
    );
    while (index >= 0 && activeCount < concurrency) {
      const [{ productId, issueKey }] = queue.splice(index, 1);
      queued.delete(jobKey(productId, issueKey));
      void runJob(productId, issueKey).catch((error) => {
        void recordFailure("worker", error, productId);
        emit({
          eventType: "ticket-context.enrichment.worker_failed",
          productId,
          resourceId: issueKey,
          code: error?.code ?? "context_job_persistence_failed"
        });
      });
      index = queue.findIndex(({ productId: candidate }) =>
        !pausedProducts.has(candidate) && !activeByProduct.has(candidate)
      );
    }
  }

  return Object.freeze({
    async start() {
      if (started) return;
      try {
        await store.initialize?.();
      } catch (error) {
        lastPersistenceFailure = failureRecord(error);
        throw error;
      }
      await sweepRetention();
      const pending = await transactStore((snapshot) => {
        const recoverable = [];
        for (const job of snapshot.jobs) {
          if (job.sources.jira.state === "local") {
            job.invalidation.sources.jira.latestSuccessfulCompletionAt = null;
          }
          if (job.state === "running") {
            const interruptedGeneration = job.invalidation.runningGeneration ?? 0;
            const refreshAfterRecovery =
              job.invalidation.refreshAfterRun
              || job.invalidation.generation > interruptedGeneration;
            job.state = "pending";
            job.startedAt = null;
            job.nextRetryAt = null;
            job.invalidation.runningGeneration = null;
            job.invalidation.refreshAfterRun = false;
            for (const source of SOURCES) {
              if (
                job.sources[source].state === "running"
                || (
                  refreshAfterRecovery
                  && job.invalidation.sources[source].stale
                )
              ) {
                job.sources[source].state = "pending";
                job.sources[source].startedAt = null;
                job.sources[source].completedAt = null;
                job.sources[source].error = null;
              }
            }
            job.completeness = completenessFor(job);
          }
          if (job.state === "pending") recoverable.push(publicJob(job));
        }
        return recoverable;
      });
      started = true;
      for (const job of pending) {
        if (job.nextRetryAt && Date.parse(job.nextRetryAt) > now()) scheduleRetry(job);
        else enqueueMemory(job.productId, job.issueKey);
      }
      retentionTimer = setIntervalTimer(() => {
        void sweepRetention().catch((error) => {
          void recordFailure("persistence", error);
        });
      }, retentionSweepIntervalMs);
      retentionTimer?.unref?.();
    },

    async get({ productId, issueKey }) {
      const normalized = canonicalIssueKey(issueKey);
      const job = await find(productId, normalized);
      if (!job) {
        throw new ApiError(404, "context_job_not_found", "No ticket context job was found.");
      }
      return publicJob(job);
    },

    async enqueue({ productId, issueKey, force = false }) {
      const normalized = canonicalIssueKey(issueKey);
      const existing = await find(productId, normalized);
      if (existing && force) {
        const key = jobKey(productId, normalized);
        const refreshed = await mutate(productId, normalized, (job) => {
          const at = timestamp();
          job.nextRetryAt = null;
          job.force = true;
          if (job.state === "running") {
            job.invalidation.generation += 1;
            job.invalidation.refreshAfterRun = true;
            job.invalidation.sources.jira = {
              stale: true,
              generation: job.invalidation.generation,
              observedAt: at,
              eventIdDigest: null,
              latestSuccessfulCompletionAt:
                job.invalidation.sources.jira.latestSuccessfulCompletionAt
            };
            return;
          }
          job.state = "pending";
          job.queuedAt = at;
          job.startedAt = null;
          job.completedAt = null;
          job.cancelledAt = null;
          job.sources.jira = emptySource();
          for (const source of ["testrail", "github"]) {
            job.sources[source] = emptySource();
          }
        });
        const timer = retryTimers.get(key);
        if (timer) {
          clearTimer(timer);
          retryTimers.delete(key);
        }
        if (refreshed.state === "pending") {
          enqueueMemory(productId, normalized, true);
          const index = queue.findIndex(
            (entry) => entry.productId === productId && entry.issueKey === normalized
          );
          if (index > 0) {
            const [entry] = queue.splice(index, 1);
            queue.unshift(entry);
          }
        }
        return refreshed;
      }
      if (
        existing
        && ["pending", "running"].includes(existing.state)
      ) {
        if (existing.state === "pending") {
          const key = jobKey(productId, normalized);
          if (existing.nextRetryAt && Date.parse(existing.nextRetryAt) > now()) {
            if (!retryTimers.has(key)) scheduleRetry(existing);
          } else {
            enqueueMemory(productId, normalized);
          }
        }
        return publicJob(existing);
      }
      if (
        existing
        && !force
        && existing.completedAt
        && now() - Date.parse(existing.completedAt) <= freshnessMs
        && existing.completeness?.complete
      ) {
        return publicJob(existing);
      }
      const job = await mutate(productId, normalized, (draft) => {
        const at = timestamp();
        draft.state = "pending";
        draft.queuedAt = at;
        draft.startedAt = null;
        draft.completedAt = null;
        draft.cancelledAt = null;
        draft.nextRetryAt = null;
        draft.force = force;
        if (force) {
          draft.sources.jira = emptySource();
        }
        for (const source of ["testrail", "github"]) {
          draft.sources[source] = emptySource();
        }
      }, { create: true });
      enqueueMemory(productId, normalized, force);
      return job;
    },

    async cancel({ productId, issueKey }) {
      const normalized = canonicalIssueKey(issueKey);
      const key = jobKey(productId, normalized);
      const existing = await find(productId, normalized);
      if (!existing) {
        throw new ApiError(404, "context_job_not_found", "No ticket context job was found.");
      }
      const timer = retryTimers.get(key);
      if (timer) {
        clearTimer(timer);
        retryTimers.delete(key);
      }
      const queuedIndex = queue.findIndex(
        (entry) => entry.productId === productId && entry.issueKey === normalized
      );
      if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
      queued.delete(key);
      activeByKey.get(key)?.abort();
      return mutate(productId, normalized, (job) => {
        const at = timestamp();
        job.state = "cancelled";
        job.cancelledAt = at;
        job.completedAt = at;
        job.nextRetryAt = null;
        for (const source of ["jira", "testrail", "github"]) {
          if (["pending", "running"].includes(job.sources[source].state)) {
            job.sources[source].state = "cancelled";
            job.sources[source].completedAt = at;
            job.sources[source].error = null;
          }
        }
      });
    },

    async recordJiraOutcome({
      productId,
      issueKey,
      state,
      recordsCollected = 0,
      truncated = false,
      error = null
    }) {
      const normalized = canonicalIssueKey(issueKey);
      return mutate(productId, normalized, (job) => {
        const at = timestamp();
        job.sources.jira = {
          state,
          startedAt: job.sources.jira.startedAt,
          completedAt: at,
          attemptCount: job.sources.jira.attemptCount + 1,
          recordsCollected,
          truncated,
          error: error ? sanitizeError(error) : null
        };
        if (state !== "local" && SUCCESS_SOURCE_STATES.has(state)) {
          job.invalidation.sources.jira.latestSuccessfulCompletionAt = at;
        }
        if (["unavailable", "not-connected"].includes(state)) {
          job.state = state === "not-connected" ? "partial" : "unavailable";
          job.completedAt = at;
        }
      }, { create: true });
    },

    async invalidate({ productId, issueKey, source, eventId, observedAt }) {
      if (typeof productId !== "string" || !PRODUCT_ID_PATTERN.test(productId)) {
        throw new ApiError(400, "invalid_request", "productId is invalid.");
      }
      const normalized = canonicalIssueKey(issueKey);
      if (!SOURCES.includes(source)) {
        throw new ApiError(400, "invalid_request", "source is not supported.");
      }
      if (
        typeof eventId !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventId)
      ) {
        throw new ApiError(400, "invalid_request", "eventId is invalid.");
      }
      if (typeof observedAt !== "string") {
        throw new ApiError(400, "invalid_request", "observedAt must be an ISO-8601 timestamp.");
      }
      const observedTime = Date.parse(observedAt);
      if (!Number.isFinite(observedTime)) {
        throw new ApiError(400, "invalid_request", "observedAt must be an ISO-8601 timestamp.");
      }
      const canonicalObservedAt = new Date(observedTime).toISOString();
      const eventIdDigest = digest(eventId);
      const issueKeyDigest = digest(normalized);
      const result = await transactStore((snapshot) => {
        const duplicate = snapshot.receipts.find((receipt) =>
          receipt.productId === productId
          && receipt.source === source
          && receipt.eventIdDigest === eventIdDigest
        );
        if (duplicate) {
          recordDisposition(snapshot, {
            productId,
            source,
            observedAt: canonicalObservedAt,
            disposition: "duplicate",
            eventIdDigest,
            issueKeyDigest
          });
          return { disposition: "ignored:duplicate", job: null };
        }

        const job = snapshot.jobs.find((candidate) =>
          candidate.productId === productId && candidate.issueKey === normalized
        );
        let disposition;
        if (!job) {
          disposition = "not-hot";
        } else {
          const sourceOutcome = job.sources[source];
          const latestSuccessfulCompletion =
            job.invalidation.sources[source].latestSuccessfulCompletionAt
            ?? (
              sourceOutcome.state !== "local"
              && SUCCESS_SOURCE_STATES.has(sourceOutcome.state)
                ? sourceOutcome.completedAt
                : null
            );
          disposition =
            latestSuccessfulCompletion
            && observedTime <= Date.parse(latestSuccessfulCompletion)
              ? "obsolete"
              : "accepted";
        }

        const receivedAt = timestamp();
        snapshot.receipts.push({
          productId,
          source,
          eventIdDigest,
          issueKeyDigest,
          observedAt: canonicalObservedAt,
          receivedAt,
          disposition
        });
        snapshot.receipts = snapshot.receipts
          .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
          .slice(-maxReceipts);
        recordDisposition(snapshot, {
          productId,
          source,
          observedAt: canonicalObservedAt,
          disposition,
          eventIdDigest,
          issueKeyDigest
        });

        if (disposition !== "accepted") {
          return {
            disposition: `ignored:${disposition}`,
            job: null
          };
        }

        job.invalidation.generation += 1;
        const generation = job.invalidation.generation;
        job.invalidation.sources[source] = {
          stale: true,
          generation,
          observedAt: canonicalObservedAt,
          eventIdDigest,
          latestSuccessfulCompletionAt:
            job.invalidation.sources[source].latestSuccessfulCompletionAt
        };
        if (job.state === "running") {
          job.invalidation.refreshAfterRun = true;
        } else {
          const at = timestamp();
          if (job.state !== "pending") {
            job.state = "pending";
            job.queuedAt = at;
            job.startedAt = null;
            job.completedAt = null;
            job.cancelledAt = null;
            job.nextRetryAt = null;
          }
          job.sources[source] = {
            ...emptySource(),
            attemptCount: job.sources[source].attemptCount
          };
          if (source === "jira") job.force = true;
          job.updatedAt = at;
          job.completeness = completenessFor(job);
        }
        return {
          disposition: "accepted",
          job: publicJob(job),
          state: job.state,
          nextRetryAt: job.nextRetryAt
        };
      });

      if (result.disposition === "accepted" && result.state !== "running") {
        const key = jobKey(productId, normalized);
        if (activeByKey.has(key)) {
          followUpAfterActive.add(key);
        } else if (result.nextRetryAt && Date.parse(result.nextRetryAt) > now()) {
          const existing = await find(productId, normalized);
          if (existing && !retryTimers.has(key)) {
            scheduleRetry(existing);
          }
        } else {
          enqueueMemory(productId, normalized, true);
        }
      }
      emit({
        eventType: "ticket-context.invalidation",
        productId,
        resourceId: normalized,
        source,
        disposition: result.disposition
      });
      return {
        disposition: result.disposition,
        ...(result.job ? { job: result.job } : {})
      };
    },

    async recordInvalidationRejection({
      productId,
      source = "jira",
      eventId = null,
      observedAt = null,
      issueKey = null
    }) {
      const eventIdDigest =
        typeof eventId === "string" && eventId.length > 0 ? digest(eventId) : null;
      const issueKeyDigest =
        typeof issueKey === "string" && issueKey.length > 0 ? digest(issueKey) : null;
      const parsedObservedAt = Date.parse(observedAt);
      await transactStore((snapshot) => {
        recordDisposition(snapshot, {
          productId,
          source,
          observedAt: Number.isFinite(parsedObservedAt)
            ? new Date(parsedObservedAt).toISOString()
            : null,
          disposition: "rejected",
          eventIdDigest,
          issueKeyDigest
        });
      });
    },

    async getJiraReceipt({ productId, issueKey }) {
      const normalized = canonicalIssueKey(issueKey);
      const job = await find(productId, normalized);
      if (!job?.sources?.jira?.completedAt) return null;
      if (now() - Date.parse(job.sources.jira.completedAt) > freshnessMs) return null;
      return clone(job.sources.jira);
    },

    async beginFullSync(productId) {
      const pauseCount = pausedProducts.get(productId) ?? 0;
      pausedProducts.set(productId, pauseCount + 1);
      if (pauseCount > 0) return;
      const key = activeByProduct.get(productId);
      if (key) activeByKey.get(key)?.abort();
      while (activeByProduct.has(productId)) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },

    async endFullSync(productId) {
      const pauseCount = pausedProducts.get(productId) ?? 0;
      if (pauseCount > 1) {
        pausedProducts.set(productId, pauseCount - 1);
        return;
      }
      if (pauseCount === 0) return;
      pausedProducts.delete(productId);
      const snapshot = await readStore();
      for (const job of snapshot.jobs) {
        if (job.productId === productId && job.state === "pending") {
          enqueueMemory(job.productId, job.issueKey, true);
        }
      }
      queueMicrotask(() => void pump());
    },

    async shutdown() {
      stopping = true;
      if (retentionTimer) {
        clearIntervalTimer(retentionTimer);
        retentionTimer = null;
      }
      for (const timer of retryTimers.values()) clearTimer(timer);
      retryTimers.clear();
      followUpAfterActive.clear();
      for (const controller of activeByKey.values()) controller.abort();
      while (activeCount > 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },

    async drain() {
      while (queue.length > 0 || activeCount > 0 || retryTimers.size > 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },

    status() {
      return {
        queued: queue.length,
        active: activeCount,
        pausedProducts: [...pausedProducts.keys()]
      };
    },

    async operations({ productId }) {
      const snapshot = await readStore();
      const jobs = snapshot.jobs.filter((job) => job.productId === productId);
      const jobStates = Object.fromEntries(
        ["pending", "running", "complete", "partial", "unavailable", "cancelled"]
          .map((state) => [state, jobs.filter((job) => job.state === state).length])
      );
      const queuedJobs = queue
        .filter((entry) => entry.productId === productId)
        .map((entry) => jobs.find((job) => job.issueKey === entry.issueKey))
        .filter(Boolean);
      const oldestQueuedAt = queuedJobs
        .map((job) => Date.parse(job.queuedAt))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)[0];
      const stat = snapshot.invalidationStats.find((entry) => entry.productId === productId);
      const lastSuccessfulCompletion = jobs
        .filter((job) => job.state === "complete" && job.completedAt)
        .map((job) => job.completedAt)
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
      const used = snapshot.jobs.length;
      const capacityPercent = Math.round((used / maxJobs) * 10_000) / 100;
      const failureForProduct = (failure) =>
        failure && (failure.productId === null || failure.productId === productId)
          ? { at: failure.at, code: failure.code }
          : null;
      const health = healthForSnapshot(snapshot);
      return {
        health,
        durable: {
          jobStates,
          totalJobs: jobs.length,
          deliveryReceipts: snapshot.receipts
            .filter((receipt) => receipt.productId === productId).length
        },
        memory: {
          queued: queuedJobs.length,
          active: activeByProduct.has(productId) ? 1 : 0,
          delayedRetry: [...retryTimers.keys()]
            .filter((key) => key.startsWith(`${productId}:`)).length,
          paused: pausedProducts.has(productId),
          oldestQueuedAgeMs: oldestQueuedAt === undefined
            ? null
            : Math.max(0, now() - oldestQueuedAt)
        },
        attempts: jobs.reduce((total, job) => total + job.attemptCount, 0),
        retries: jobs.reduce((total, job) => total + job.retryCount, 0),
        capacity: { used, max: maxJobs, percent: capacityPercent },
        lastSuccessfulCompletion,
        lastWorkerFailure: failureForProduct(snapshot.failures.worker),
        lastPersistenceFailure:
          lastPersistenceFailure
            ? { at: lastPersistenceFailure.at, code: lastPersistenceFailure.code }
            : failureForProduct(snapshot.failures.persistence),
        invalidations: {
          dispositions: stat
            ? {
                accepted: stat.counts.accepted,
                duplicate: stat.counts.duplicate,
                obsolete: stat.counts.obsolete,
                "not-hot": stat.counts.notHot,
                rejected: stat.counts.rejected
              }
            : {
                accepted: 0,
                duplicate: 0,
                obsolete: 0,
                "not-hot": 0,
                rejected: 0
              },
          last: stat?.last
            ? {
                source: stat.last.source,
                observedAt: stat.last.observedAt,
                receivedAt: stat.last.receivedAt,
                disposition: stat.last.disposition
              }
            : null
        },
        lastRetentionSweep: clone(snapshot.lastRetentionSweep)
      };
    },

    async health() {
      const snapshot = await readStore();
      return healthForSnapshot(snapshot);
    },

    sweepRetention
  });

  function healthForSnapshot(snapshot) {
      const oldestQueuedAt = queue
        .map(({ productId, issueKey }) => snapshot.jobs.find((job) =>
          job.productId === productId && job.issueKey === issueKey
        ))
        .filter(Boolean)
        .map((job) => Date.parse(job.queuedAt))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)[0];
      const oldestQueuedAgeMs = oldestQueuedAt === undefined
        ? 0
        : Math.max(0, now() - oldestQueuedAt);
      const lastSuccessfulCompletion = snapshot.jobs
        .filter((job) => job.state === "complete" && job.completedAt)
        .map((job) => Date.parse(job.completedAt))
        .filter(Number.isFinite)
        .sort((left, right) => right - left)[0] ?? 0;
      const reasons = [];
      if (snapshot.jobs.length / maxJobs >= 0.9) reasons.push("capacity_high");
      if (oldestQueuedAgeMs > maxQueueAgeMs) reasons.push("queue_age_excessive");
      if (retryTimers.size > maxRetryBacklog) reasons.push("retry_backlog_excessive");
      const workerFailure = snapshot.failures.worker;
      if (workerFailure && Date.parse(workerFailure.at) >= lastSuccessfulCompletion) {
        reasons.push("worker_failure");
      }
      const persistenceFailure = lastPersistenceFailure ?? snapshot.failures.persistence;
      if (persistenceFailure && Date.parse(persistenceFailure.at) >= lastSuccessfulCompletion) {
        reasons.push("persistence_failure");
      }
      return {
        status: reasons.length === 0 ? "healthy" : "degraded",
        reasons
      };
  }
}
