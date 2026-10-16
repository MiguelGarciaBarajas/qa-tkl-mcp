import { useEffect, useId, useRef, useState } from "react";
import { getTklApiClient } from "../api/client";
import type {
  TicketContextJob,
  TicketContextSourceState,
  TicketContextSourceStatus,
} from "../contracts/types";

const ACTIVE_JOB_STATES = new Set<TicketContextJob["state"]>(["pending", "running"]);
const SOURCE_ORDER = ["jira", "testrail", "github"] as const;
const SOURCE_LABEL = {
  jira: "Jira",
  testrail: "TestRail",
  github: "GitHub",
} as const;

interface TicketContextStatusProps {
  issueKey: string;
  pollIntervalMs?: number;
}

function statusLabel(status: string): string {
  return status
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function badgeClass(status: TicketContextSourceState | TicketContextJob["state"]): string {
  if (status === "complete" || status === "refreshed" || status === "local") {
    return "badge badge--ok";
  }
  if (status === "partial") return "badge badge--warn";
  if (status === "unavailable") return "badge badge--error";
  if (status === "pending" || status === "running") return "badge badge--pending";
  return "badge badge--muted";
}

function formatDateTime(value: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function sanitizeTicketContextMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "No additional details are available.";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "The source returned an unavailable response.";
  }
  return trimmed
    .replace(/\b(?:https?|ssh):\/\/\S+/gi, "[redacted endpoint]")
    .replace(
      /\b(authorization|bearer|token|password|secret|credential|api[-_ ]?key)\b\s*(?:[:=]\s*|\s+)\S+/gi,
      "$1 [redacted]",
    )
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "[redacted]")
    .slice(0, 180);
}

function safeError(caught: unknown, fallback: string): string {
  return sanitizeTicketContextMessage(caught instanceof Error ? caught.message : fallback);
}

function sourceSummary(source: TicketContextSourceStatus): string {
  const records = `${source.recordsCollected} record${source.recordsCollected === 1 ? "" : "s"}`;
  const attempts = `${source.attemptCount} attempt${source.attemptCount === 1 ? "" : "s"}`;
  return `${records} · ${attempts}${source.truncated ? " · Truncated" : ""}`;
}

function progressText(
  job: TicketContextJob | null,
  noJob: boolean,
  loading: boolean,
  action: "refresh" | "cancel" | null,
): string {
  if (action === "refresh") return "Requesting a context refresh.";
  if (action === "cancel") return "Cancelling background enrichment.";
  if (loading) return "Checking ticket context enrichment status.";
  if (noJob) return "No background enrichment job has been requested for this ticket.";
  if (!job) return "Ticket context enrichment status is unavailable.";
  if (job.state === "pending") return "Background enrichment is queued.";
  if (job.state === "running") return "Background enrichment is running.";
  return `Background enrichment is ${statusLabel(job.state).toLowerCase()}.`;
}

export function TicketContextStatus({
  issueKey,
  pollIntervalMs = 4_000,
}: TicketContextStatusProps) {
  const normalizedIssueKey = issueKey.trim().toUpperCase();
  const validIssueKey = /^[A-Z]{2,}[A-Z0-9_]*-\d+$/.test(normalizedIssueKey);

  if (!validIssueKey) return null;

  return (
    <TicketContextStatusCard
      issueKey={normalizedIssueKey}
      key={normalizedIssueKey}
      pollIntervalMs={pollIntervalMs}
    />
  );
}

function TicketContextStatusCard({
  issueKey: normalizedIssueKey,
  pollIntervalMs,
}: Required<TicketContextStatusProps>) {
  const headingId = useId();
  const mountedRef = useRef(true);
  const getRequestRef = useRef<Promise<TicketContextJob | null> | null>(null);
  const requestVersionRef = useRef(0);
  const [job, setJob] = useState<TicketContextJob | null>(null);
  const [noJob, setNoJob] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    action: "refresh" | "cancel";
    message: string;
  } | null>(null);
  const [action, setAction] = useState<"refresh" | "cancel" | null>(null);
  const [pollCycle, setPollCycle] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const requestVersion = ++requestVersionRef.current;
    const request = getTklApiClient().getTicketContextJob(normalizedIssueKey);
    getRequestRef.current = request;
    void request
      .then((nextJob) => {
        if (cancelled || requestVersion !== requestVersionRef.current) return;
        setJob(nextJob);
        setNoJob(nextJob === null);
      })
      .catch((caught) => {
        if (cancelled || requestVersion !== requestVersionRef.current) return;
        setStatusError(safeError(caught, "Ticket context status could not be loaded."));
      })
      .finally(() => {
        if (
          getRequestRef.current === request
          && requestVersion === requestVersionRef.current
        ) {
          getRequestRef.current = null;
        }
        if (!cancelled && requestVersion === requestVersionRef.current) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [normalizedIssueKey]);

  useEffect(() => {
    if (
      !job
      || !ACTIVE_JOB_STATES.has(job.state)
      || action !== null
    ) {
      return;
    }

    let cancelled = false;
    const interval = Math.min(Math.max(pollIntervalMs, 500), 30_000);
    const timer = setTimeout(() => {
      const requestVersion = ++requestVersionRef.current;
      const request = getTklApiClient().getTicketContextJob(normalizedIssueKey);
      getRequestRef.current = request;
      void request
        .then((nextJob) => {
          if (cancelled || requestVersion !== requestVersionRef.current) return;
          setJob(nextJob);
          setNoJob(nextJob === null);
          setStatusError(null);
        })
        .catch((caught) => {
          if (cancelled || requestVersion !== requestVersionRef.current) return;
          setStatusError(safeError(caught, "Ticket context status could not be refreshed."));
        })
        .finally(() => {
          if (
            getRequestRef.current === request
            && requestVersion === requestVersionRef.current
          ) {
            getRequestRef.current = null;
          }
          if (!cancelled && requestVersion === requestVersionRef.current) {
            setPollCycle((cycle) => cycle + 1);
          }
        });
    }, interval);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    action,
    job,
    normalizedIssueKey,
    pollCycle,
    pollIntervalMs,
  ]);

  const runAction = async (nextAction: "refresh" | "cancel") => {
    const actionIssueKey = normalizedIssueKey;
    setAction(nextAction);
    setActionError(null);
    requestVersionRef.current += 1;
    getRequestRef.current = null;

    try {
      const client = getTklApiClient();
      const nextJob = nextAction === "refresh"
        ? await client.refreshTicketContext(actionIssueKey)
        : await client.cancelTicketContext(actionIssueKey);
      if (!mountedRef.current) return;
      setJob(nextJob);
      setNoJob(false);
      setStatusError(null);
      setPollCycle((cycle) => cycle + 1);
    } catch (caught) {
      if (!mountedRef.current) return;
      setActionError({
        action: nextAction,
        message: safeError(
          caught,
          nextAction === "refresh"
            ? "The context refresh could not be requested."
            : "Background enrichment could not be cancelled.",
        ),
      });
    } finally {
      if (mountedRef.current) setAction(null);
    }
  };

  const active = job ? ACTIVE_JOB_STATES.has(job.state) : false;

  return (
    <article className="card ticket-context-status" aria-labelledby={headingId}>
      <div className="ticket-context-status__header">
        <div>
          <span className="page-heading__eyebrow">Background context</span>
          <h3 id={headingId}>Ticket context for {normalizedIssueKey}</h3>
        </div>
        {job && (
          <span className={badgeClass(job.completeness.status)}>
            {statusLabel(job.completeness.status)}
          </span>
        )}
      </div>

      <p className="ticket-context-status__progress" aria-live="polite" aria-atomic="true">
        {progressText(job, noJob, loading, action)}
      </p>
      <p className="ticket-context-status__explanation">
        Current local results remain available while Jira, TestRail, and GitHub enrichment
        runs in the background.
      </p>

      {statusError && (
        <p className="ticket-context-status__error" role="alert">
          Status check failed: {statusError}
        </p>
      )}

      {job && (
        <>
          <div className="ticket-context-status__sources">
            {SOURCE_ORDER.map((sourceId) => {
              const source = job.sources[sourceId];
              return (
                <section className="ticket-context-source" key={sourceId}>
                  <div className="ticket-context-source__heading">
                    <strong>{SOURCE_LABEL[sourceId]}</strong>
                    <span className={badgeClass(source.state)}>{statusLabel(source.state)}</span>
                  </div>
                  <span>{sourceSummary(source)}</span>
                  {source.completedAt && (
                    <small>Completed {formatDateTime(source.completedAt)}</small>
                  )}
                  {source.error && (
                    <p className="ticket-context-source__error">
                      {statusLabel(source.error.code)}:{" "}
                      {sanitizeTicketContextMessage(source.error.message)}
                    </p>
                  )}
                </section>
              );
            })}
          </div>

          {job.completeness.reasons.length > 0 && (
            <div className="ticket-context-status__reasons">
              <strong>Completeness notes</strong>
              <ul>
                {job.completeness.reasons.map((reason) => (
                  <li key={reason}>{sanitizeTicketContextMessage(reason)}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="ticket-context-status__metadata">
            <span>
              Last update
              <strong>{formatDateTime(job.updatedAt)}</strong>
            </span>
            {job.nextRetryAt && (
              <span>
                Next retry
                <strong>{formatDateTime(job.nextRetryAt)}</strong>
              </span>
            )}
          </div>
        </>
      )}

      {noJob && !loading && !statusError && (
        <p className="ticket-context-status__empty">
          No enrichment job exists yet. Request a refresh to collect secondary context.
        </p>
      )}

      <div className="ticket-context-status__actions">
        <button
          className="button button--primary"
          disabled={loading || action !== null}
          onClick={() => void runAction("refresh")}
          type="button"
        >
          {action === "refresh" ? "Requesting refresh…" : "Refresh context"}
        </button>
        {active && (
          <button
            className="button button--danger"
            disabled={action !== null}
            onClick={() => void runAction("cancel")}
            type="button"
          >
            {action === "cancel" ? "Cancelling…" : "Cancel enrichment"}
          </button>
        )}
      </div>

      {actionError && (
        <p className="ticket-context-status__error" role="alert">
          {actionError.action === "cancel" ? "Cancel failed" : "Refresh failed"}:{" "}
          {actionError.message}
        </p>
      )}
    </article>
  );
}
