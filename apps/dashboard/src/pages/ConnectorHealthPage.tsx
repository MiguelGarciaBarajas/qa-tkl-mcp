import { useEffect, useState } from "react";
import { getTklApiClient } from "../api/client";
import { useAsync } from "../api/useAsync";
import { Icon } from "../components/Icon";
import { JitContextOperationsCard } from "../components/JitContextOperationsCard";
import { PageHeader } from "../components/PageHeader";
import type {
  ConnectorHealth,
  ConnectorStatus,
  GitHubRepository,
  SourceConnection,
} from "../contracts/types";

const STATUS_LABEL: Record<ConnectorStatus, string> = {
  healthy: "Healthy",
  validating: "Validating",
  syncing: "Syncing",
  degraded: "Degraded",
  failing: "Failing",
  disabled: "Disabled",
  "pending-configuration": "Pending configuration",
};

const STATUS_CLASS: Record<ConnectorStatus, string> = {
  healthy: "badge badge--ok",
  validating: "badge badge--pending",
  syncing: "badge badge--pending",
  degraded: "badge badge--warn",
  failing: "badge badge--error",
  disabled: "badge badge--muted",
  "pending-configuration": "badge badge--pending",
};

export function ConnectorHealthPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, loading, error } = useAsync(loadConnectorHealth, [refreshKey]);

  useEffect(() => {
    if (
      loading
      || !data
      || !(
        data.connectors.some((connector) =>
          connector.status === "syncing" || connector.status === "validating"
        )
        || data.repositories.some((repository) =>
          repository.syncStatus === "syncing" || repository.validationStatus === "validating"
        )
      )
    ) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setRefreshKey((current) => current + 1);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [data, loading, refreshKey]);

  async function loadConnectorHealth(): Promise<{
    connectors: ConnectorHealth[];
    repositories: GitHubRepository[];
  }> {
    const client = getTklApiClient();
    const [health, connections] = await Promise.all([
      client.getConnectorHealth(),
      client.getSourceConnections(),
    ]);
    return {
      connectors: mergeConnectorHealth(health, connections),
      repositories:
        connections.find((connection) => connection.source === "github")?.repositories ?? [],
    };
  }

  function mergeConnectorHealth(
    health: ConnectorHealth[],
    connections: SourceConnection[],
  ): ConnectorHealth[] {
    const merged = new Map(health.map((connector) => [connector.source, connector]));

    for (const connection of connections.filter((item) => item.configured)) {
      const runtimeHealth = merged.get(connection.source);
      merged.set(connection.source, {
        connectorId: runtimeHealth?.connectorId ?? connection.displayName,
        source: connection.source,
        status: toHealthStatus(connection),
        lastSyncAt: connection.lastSyncAt ?? runtimeHealth?.lastSyncAt ?? null,
        lastSuccessfulSyncAt:
          connection.lastSuccessfulSyncAt ?? runtimeHealth?.lastSuccessfulSyncAt ?? null,
        recordsSyncedLast24h: runtimeHealth?.recordsSyncedLast24h ?? 0,
        errorRateLast24h: runtimeHealth?.errorRateLast24h ?? 0,
        credentialStatus:
          connection.status === "authorization-expired" ? "invalid" : "valid",
        message:
          connection.status === "syncing"
            ? "Synchronization is currently in progress."
            : connection.status === "validating"
              ? "Connection validation is currently in progress."
              : connection.error?.message
          ?? runtimeHealth?.message
          ?? (connection.lastSuccessfulSyncAt
            ? undefined
            : "Connected successfully; synchronization has not run yet."),
      });
    }

    return [...merged.values()];
  }

  function toHealthStatus(connection: SourceConnection): ConnectorStatus {
    switch (connection.status) {
      case "connected":
        return "healthy";
      case "validating":
        return "validating";
      case "syncing":
        return "syncing";
      case "stale":
        return "degraded";
      case "authorization-expired":
      case "error":
        return "failing";
      case "disabled":
        return "disabled";
      case "not-connected":
        return "pending-configuration";
    }
  }

  const pending = data?.connectors.filter((c) => c.status === "pending-configuration") ?? [];
  const healthyCount =
    data?.connectors.filter((connector) => connector.status === "healthy").length ?? 0;
  const syncingCount =
    data?.connectors.filter((connector) => connector.status === "syncing").length ?? 0;
  const hasConnectors = Boolean(
    data && (data.connectors.length > 0 || data.repositories.length > 0),
  );
  const summary = data
    ? [
        `${healthyCount} healthy`,
        syncingCount > 0 ? `${syncingCount} syncing` : null,
        `${data.connectors.length} connectors`,
        data.repositories.length > 0 ? `${data.repositories.length} GitHub repositories` : null,
      ].filter(Boolean).join(" · ")
    : loading
      ? "Loading connector status"
      : "Connector status unavailable";

  return (
    <section>
      <PageHeader
        eyebrow="Operations"
        title="Connector Health"
        description="Monitor synchronization, freshness and credential health without exposing source secrets."
        icon="activity"
        summary={summary}
      />
      <JitContextOperationsCard />

      {loading && !data && <p>Loading connector health…</p>}
      {error && <p role="alert">Failed to load connector health: {error.message}</p>}
      {!loading && !error && !hasConnectors && (
        <div className="page__empty">
          <strong>No source connectors are configured yet.</strong>
          <span>Connect Jira, GitHub, TestRail, Confluence, or ReportPortal to begin building workspace knowledge.</span>
          <a className="button button--primary" href="#/source-connections">Configure sources</a>
        </div>
      )}

      {data && hasConnectors && (
        <>
          {pending.length > 0 && (
            <p className="page__notes" role="status">
              {pending.length} connector{pending.length > 1 ? "s" : ""} awaiting configuration:{" "}
              {pending.map((c) => c.connectorId).join(", ")}.
            </p>
          )}
          <p className="page__notes" role="note">
            <strong>Records (24h)</strong> reflects current-process / recent runtime sync activity,
            not the total retained knowledge. For durable inventory, canonical knowledge, coverage,
            and freshness, see <a href="#/knowledge-inventory">Knowledge Inventory</a>. A zero here
            does not imply data loss or require a resync.
          </p>
          <table className="table connector-health-table">
        <thead>
          <tr>
            <th>Connector</th>
            <th>Status</th>
            <th>Last sync</th>
            <th>Records (24h)</th>
            <th>Error rate (24h)</th>
            <th>Credential</th>
          </tr>
        </thead>
        <tbody>
          {data.connectors.flatMap((connector) => {
            const rows = [
              <tr className="connector-health-table__connector" key={connector.connectorId}>
                <td data-label="Connector">{connector.connectorId}</td>
                <td data-label="Status">
                  <span className={STATUS_CLASS[connector.status]}>
                    {(connector.status === "syncing" || connector.status === "validating") && (
                      <Icon name="refresh" size={13} className="spin" />
                    )}
                    {STATUS_LABEL[connector.status]}
                  </span>
                </td>
                <td data-label="Last sync">
                  {connector.status === "pending-configuration"
                    ? "not configured"
                    : connector.status === "syncing" && connector.lastSyncAt
                      ? `Started ${formatElapsed(connector.lastSyncAt)} ago`
                    : connector.lastSyncAt
                      ? new Date(connector.lastSyncAt).toLocaleString()
                      : "never"}
                </td>
                <td data-label="Records (24h)">{connector.recordsSyncedLast24h}</td>
                <td data-label="Error rate (24h)">
                  {(connector.errorRateLast24h * 100).toFixed(1)}%
                </td>
                <td data-label="Credential">{connector.credentialStatus}</td>
              </tr>,
            ];
            if (connector.source === "github") {
              rows.push(...data.repositories.map((repository) => (
                <GitHubRepositoryHealthRow repository={repository} key={repository.id} />
              )));
            }
            return rows;
          })}
        </tbody>
          </table>
          {data.connectors.some((c) => c.message) && (
            <ul className="page__notes">
              {data.connectors.filter((c) => c.message).map((c) => (
                <li key={c.connectorId}>
                  <strong>{c.connectorId}:</strong> {c.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function GitHubRepositoryHealthRow({ repository }: { repository: GitHubRepository }) {
  const status = repositoryHealthStatus(repository);
  return (
    <tr className="connector-health-table__repository">
      <td data-label="Repository">
        <span className="connector-health-table__nested-label">Repository</span>
        <strong>{repository.repository}</strong>
        <a href={repository.url} target="_blank" rel="noreferrer">{repository.url}</a>
      </td>
      <td data-label="Status">
        <span className={STATUS_CLASS[status]}>
          {(status === "syncing" || status === "validating") && (
            <Icon name="refresh" size={13} className="spin" />
          )}
          {STATUS_LABEL[status]}
        </span>
        <small>
          Validation: {humanize(repository.validationStatus)} · Sync:{" "}
          {humanize(repository.syncStatus)}
        </small>
      </td>
      <td data-label="Timestamps">
        <span>Last sync: {formatDate(repository.lastSyncAt)}</span>
        <small>Successful: {formatDate(repository.lastSuccessfulSyncAt)}</small>
      </td>
      <td data-label="Records collected">{repository.recordsCollected.toLocaleString()}</td>
      <td data-label="Error">
        {repository.error ? sanitizeError(repository.error.message) : "—"}
      </td>
      <td data-label="State">{repository.enabled ? humanize(repository.lifecycle) : "Disabled"}</td>
    </tr>
  );
}

function repositoryHealthStatus(repository: GitHubRepository): ConnectorStatus {
  if (!repository.enabled || repository.lifecycle === "archived") return "disabled";
  if (repository.validationStatus === "validating") return "validating";
  if (repository.syncStatus === "syncing") return "syncing";
  if (repository.validationStatus === "failed" || repository.syncStatus === "failed") {
    return "failing";
  }
  if (repository.syncStatus === "cancelled") return "degraded";
  if (repository.validationStatus === "pending") return "pending-configuration";
  return "healthy";
}

function formatDate(timestamp: string | null): string {
  return timestamp ? new Date(timestamp).toLocaleString() : "never";
}

function humanize(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sanitizeError(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:access_?token|token|key|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@");
}

function formatElapsed(timestamp: string): string {
  const elapsedMs = Math.max(0, Date.now() - new Date(timestamp).getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes === 1) return "1 minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
