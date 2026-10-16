import { useCallback, useEffect, useRef, useState } from "react";
import { getTklApiClient } from "../api/client";
import type {
  TicketContextInvalidationDisposition,
  TicketContextOperations,
} from "../contracts/types";
import { Icon } from "./Icon";

const POLL_INTERVAL_MS = 5_000;
const DISPOSITION_LABELS: Record<TicketContextInvalidationDisposition, string> = {
  accepted: "Accepted",
  duplicate: "Duplicate",
  obsolete: "Obsolete",
  "not-hot": "Not hot",
  rejected: "Rejected",
};

interface OperationsState {
  data: TicketContextOperations | null;
  loading: boolean;
  error: Error | null;
}

export function JitContextOperationsCard() {
  const [state, setState] = useState<OperationsState>({
    data: null,
    loading: true,
    error: null,
  });
  const mountedRef = useRef(false);
  const inFlightRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const clearPoll = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const load = useCallback(async function loadOperations(initial = false) {
    if (inFlightRef.current) return;
    clearPoll();
    inFlightRef.current = true;
    if (mountedRef.current && !initial) {
      setState((current) => ({
        ...current,
        loading: current.data === null,
        error: null,
      }));
    }

    try {
      const data = await getTklApiClient().getTicketContextOperations();
      if (!mountedRef.current) return;
      setState({ data, loading: false, error: null });
      if (hasActiveWork(data)) {
        timerRef.current = window.setTimeout(() => {
          void loadOperations(false);
        }, POLL_INTERVAL_MS);
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setState((current) => ({
        data: current.data,
        loading: false,
        error: error instanceof Error ? error : new Error("Unknown request failure."),
      }));
    } finally {
      inFlightRef.current = false;
    }
  }, [clearPoll]);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    void Promise.resolve().then(() => {
      if (!cancelled) return load(true);
      return undefined;
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      clearPoll();
    };
  }, [clearPoll, load]);

  const { data, loading, error } = state;
  const activeWork = data ? hasActiveWork(data) : false;
  const health = data ? deriveOperationsHealth(data) : null;

  return (
    <article className="card jit-context-operations" aria-labelledby="jit-context-heading">
      <div className="jit-context-operations__header">
        <div>
          <span className="page-heading__eyebrow">Independent subsystem</span>
          <h3 id="jit-context-heading">JIT Context</h3>
          <p>Read-only durable processing, queue and invalidation health.</p>
        </div>
        <div className="jit-context-operations__actions">
          {health && (
            <span className={health.degraded ? "badge badge--warn" : "badge badge--ok"}>
              {health.degraded ? "Degraded" : "Healthy"}
            </span>
          )}
          <button
            className="button"
            type="button"
            disabled={loading}
            onClick={() => void load(false)}
          >
            {loading && <Icon name="refresh" size={14} className="spin" />}
            Refresh status
          </button>
        </div>
      </div>

      <p
        className="jit-context-operations__queue-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {loading && !data
          ? "Loading JIT context operations…"
          : activeWork && data
            ? `${data.memory.queued} queued, ${data.memory.active} active, ${data.memory.delayedRetry} delayed retry. Status refreshes about every 5 seconds while work remains.`
            : "The JIT context queue is idle."}
      </p>

      {error && (
        <p className="jit-context-operations__error" role="alert">
          JIT context status is unavailable. Refresh status to try again.
        </p>
      )}

      {data && (
        <>
          {health && health.reasons.length > 0 && (
            <p className="jit-context-operations__health-detail">
              <strong>Health signals:</strong> {health.reasons.join("; ")}.
            </p>
          )}

          {isEmpty(data) && (
            <p className="jit-context-operations__empty">
              No JIT context work has been recorded yet.
            </p>
          )}

          <div className="jit-context-operations__metrics">
            <OperationMetric label="Durable jobs" value={formatNumber(data.durable.totalJobs)} />
            <OperationMetric
              label="Queue / active / delayed"
              value={`${data.memory.queued} / ${data.memory.active} / ${data.memory.delayedRetry}`}
            />
            <OperationMetric
              label="Oldest queued"
              value={formatDuration(data.memory.oldestQueuedAgeMs)}
            />
            <OperationMetric
              label="Capacity"
              value={`${formatNumber(data.capacity.used)} / ${formatNumber(data.capacity.max)} (${formatPercent(data.capacity.percent)})`}
            />
            <OperationMetric
              label="Attempts / retries"
              value={`${formatNumber(data.attempts)} / ${formatNumber(data.retries)}`}
            />
            <OperationMetric
              label="Delivery receipts"
              value={formatNumber(data.durable.deliveryReceipts)}
            />
          </div>

          <div className="jit-context-operations__details">
            <OperationsBreakdown
              title="Durable job states"
              values={[
                ["Pending", data.durable.jobStates.pending],
                ["Running", data.durable.jobStates.running],
                ["Complete", data.durable.jobStates.complete],
                ["Partial", data.durable.jobStates.partial],
                ["Unavailable", data.durable.jobStates.unavailable],
                ["Cancelled", data.durable.jobStates.cancelled],
              ]}
            />
            <OperationsBreakdown
              title="Invalidation dispositions"
              values={Object.entries(data.invalidations.dispositions).map(
                ([disposition, count]) => [
                  DISPOSITION_LABELS[disposition as TicketContextInvalidationDisposition],
                  count,
                ],
              )}
            />
          </div>

          <dl className="jit-context-operations__timeline">
            <TimelineItem
              label="Last successful completion"
              value={formatTimestamp(data.lastSuccessfulCompletion)}
            />
            <TimelineItem
              label="Last invalidation"
              value={data.invalidations.last
                ? `${sanitizeLabel(data.invalidations.last.source)} · ${DISPOSITION_LABELS[data.invalidations.last.disposition]} · observed ${data.invalidations.last.observedAt ? formatTimestamp(data.invalidations.last.observedAt) : "not available"} · received ${formatTimestamp(data.invalidations.last.receivedAt)}`
                : "None recorded"}
            />
            <TimelineItem
              label="Last retention sweep"
              value={data.lastRetentionSweep
                ? `${formatTimestamp(data.lastRetentionSweep.completedAt)} · ${formatNumber(data.lastRetentionSweep.jobsDeleted)} jobs and ${formatNumber(data.lastRetentionSweep.receiptsDeleted)} receipts removed · started ${formatTimestamp(data.lastRetentionSweep.startedAt)}`
                : "None recorded"}
            />
          </dl>

          <div className="jit-context-operations__failures">
            <FailureSignal label="Last worker failure" failure={data.lastWorkerFailure} />
            <FailureSignal
              label="Last persistence failure"
              failure={data.lastPersistenceFailure}
            />
          </div>
        </>
      )}
    </article>
  );
}

function OperationMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OperationsBreakdown({
  title,
  values,
}: {
  title: string;
  values: Array<[string, number]>;
}) {
  return (
    <section aria-labelledby={`jit-${title.toLowerCase().replaceAll(" ", "-")}`}>
      <h4 id={`jit-${title.toLowerCase().replaceAll(" ", "-")}`}>{title}</h4>
      <dl>
        {values.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{formatNumber(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function TimelineItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function FailureSignal({
  label,
  failure,
}: {
  label: string;
  failure: TicketContextOperations["lastWorkerFailure"];
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>
        {failure
          ? <><code>{sanitizeFailureCode(failure.code)}</code> · {formatTimestamp(failure.at)}</>
          : "None recorded"}
      </strong>
    </div>
  );
}

function deriveOperationsHealth(operations: TicketContextOperations): {
  degraded: boolean;
  reasons: string[];
} {
  return {
    degraded: operations.health.status === "degraded",
    reasons: operations.health.reasons.map(humanizeHealthReason),
  };
}

function humanizeHealthReason(reason: string): string {
  const labels: Record<string, string> = {
    capacity_high: "capacity is at least 90%",
    queue_age_excessive: "the oldest queued job exceeds the configured limit",
    retry_backlog_excessive: "the delayed retry backlog exceeds the configured limit",
    worker_failure: "a worker failure has not yet been followed by a successful completion",
    persistence_failure:
      "a persistence failure has not yet been followed by a successful completion",
  };
  return labels[reason] ?? "an operational health threshold is exceeded";
}

function hasActiveWork(operations: TicketContextOperations): boolean {
  return (
    operations.memory.queued > 0
    || operations.memory.active > 0
    || operations.memory.delayedRetry > 0
  );
}

function isEmpty(operations: TicketContextOperations): boolean {
  return (
    operations.durable.totalJobs === 0
    && operations.durable.deliveryReceipts === 0
    && operations.attempts === 0
    && Object.values(operations.invalidations.dispositions).every((value) => value === 0)
  );
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function formatPercent(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatTimestamp(timestamp: string | null): string {
  return timestamp ? new Date(timestamp).toLocaleString() : "None recorded";
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "None";
  if (milliseconds < 1_000) return "Less than a second";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours} hr` : `${hours} hr ${remainingMinutes} min`;
}

function sanitizeFailureCode(code: string): string {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(code)
    ? code
    : "invalid_failure_code";
}

function sanitizeLabel(label: string): string {
  const sanitized = label.replace(/[^A-Za-z0-9_.:-]/g, " ").trim().slice(0, 60);
  return sanitized || "Unknown source";
}
