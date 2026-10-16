/**
 * Opt-in, sanitized live-source smoke test harness (LIVE-101).
 *
 * This is preparatory tooling only. `LIVE-101` cannot be completed --
 * exercised against real Jira/GitHub/TestRail and marked `DONE` with
 * "approved evidence" -- until the External Decisions Register's "approved
 * access" entries are actually granted (see
 * `docs/team/TKL-Delivery-Backlog.md`). Until then, this module and its
 * `bin/run.js` CLI exist so the smoke test can be run the moment access is
 * approved, without inventing credentials, approvals, or a passing result
 * that has not actually happened.
 *
 * This intentionally never runs as part of `npm test`, `npm run
 * test:contract`, or `npm run test:integration` (see the package/root
 * scripts): a live network call against real third-party systems has no
 * place in the default CI gate (`QA-101`), and a silent skip inside that
 * gate would manufacture green evidence for a task whose bar is "approved
 * evidence", not "did not fail because it never ran". It is invoked
 * explicitly via `npm run smoke:live`.
 *
 * Design constraints, mirrored from `@tkl/ingestion` (ING-104) and the
 * connectors' own sanitized-logging guarantees (ING-106):
 *   - Only connectors already `enabledPlugins`-approved in product
 *     configuration are ever attempted; a source still in
 *     `plannedPlugins`/`pending-external-input` (for example Jira and
 *     TestRail in `config/products/fl-titling.json` today) is reported as
 *     skipped, never invented a "ready" status.
 *   - Credential resolution has no opinion on secret storage (SEC-101/
 *     OPS-102 is not this harness's job): it reads a small, explicit set of
 *     environment variables and fails closed, naming the missing variable,
 *     when one is not set -- it never falls back to a default or fabricated
 *     value.
 *   - The report emitted for each source contains only identifiers,
 *     counts, status, and checkpoint metadata -- the same shape connector
 *     `health()`/`logEvent` already treat as safe to surface. It never
 *     contains the resolved credential value, a raw record payload, or an
 *     unsanitized error/response body.
 */
import { composeConnectors, registerConnectorPlugins } from "@tkl/ingestion";

export const LIVE_SMOKE_SOURCE_IDS = Object.freeze([
  "jira",
  "github",
  "testrail",
  "confluence",
  "reportportal",
]);

/** Maps a source ID to the environment variable this harness reads the credential from. */
export function credentialEnvVarName(sourceId) {
  return `LIVE_SMOKE_${sourceId.toUpperCase()}_TOKEN`;
}

/**
 * Builds a `resolveCredential` function that reads directly from `env`
 * (defaulting to `process.env`), keyed by the source segment of the
 * `credentialRef` (for example `secret://github/fl-titling` -> `github` ->
 * `LIVE_SMOKE_GITHUB_TOKEN`). Fails closed, naming the missing variable,
 * rather than ever returning an empty/fabricated credential.
 */
export function createEnvCredentialResolver(env = process.env) {
  return async function resolveCredential(credentialRef) {
    const match = /^(?:secret|env):\/\/([^/]+)\//.exec(String(credentialRef ?? ""));
    const sourceId = match?.[1];
    if (!sourceId) {
      throw new TypeError(`Cannot determine the source for credentialRef "${credentialRef}"`);
    }
    const envVarName = credentialEnvVarName(sourceId);
    const value = env?.[envVarName];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(
        `Live smoke credential for "${sourceId}" is not available: environment variable `
        + `"${envVarName}" is not set. This source cannot be smoke tested until that access is provided.`,
      );
    }
    return value.trim();
  };
}

function pluginIdForSource(sourceId) {
  return `connector.${sourceId}`;
}

/**
 * Runs a single, bounded (at most one record) read against one connector
 * to prove real connectivity, authorization, and allowlist enforcement --
 * never a full sync. Returns only sanitized, already-safe-to-surface
 * fields.
 */
async function smokeTestSource({ sourceId, configuration, registry, dependencies }) {
  const pluginId = pluginIdForSource(sourceId);
  const source = configuration.sources?.[sourceId] ?? {};
  const isEnabled = configuration.enabledPlugins.includes(pluginId);

  if (!isEnabled) {
    return {
      source: sourceId,
      status: "skipped",
      reason: source.configurationStatus === "pending-external-input"
        ? "pending-external-input"
        : "not-enabled",
    };
  }

  try {
    const composed = composeConnectors({
      configuration,
      registry,
      dependencies: { [pluginId]: dependencies },
    });
    const connector = composed.getPlugin(pluginId);
    if (!connector) throw new TypeError(`Connector "${pluginId}" did not compose`);

    let recordsSampled = 0;
    for await (const _record of connector.collect()) {
      recordsSampled += 1;
      break; // A single record is enough to prove a real, authorized read.
    }
    const health = await connector.health();
    return {
      source: sourceId,
      status: "ok",
      recordsSampled,
      health: {
        pluginId: health.pluginId,
        status: health.status,
        records: health.records,
        retries: health.retries,
        failures: health.failures,
        lastCheckpoint: health.lastCheckpoint ?? null,
      },
    };
  } catch (error) {
    // Connector/harness error messages are already crafted (see
    // `@tkl/ingestion`, `ConnectorHttpError`, and this module's own
    // credential resolver) to never include a credential value or
    // response body -- only identifiers and status codes -- so surfacing
    // `error.message` here stays within the same sanitization guarantee.
    return { source: sourceId, status: "blocked", reason: error?.message ?? "Unknown error" };
  }
}

/**
 * Runs the live smoke test across all three real connectors, one at a
 * time. Never throws for an individual source's failure (that is reported
 * as `status: "blocked"`); only rejects for a structurally invalid
 * `configuration`.
 */
export async function runLiveSmoke({
  configuration,
  env = process.env,
  fetchImpl = fetch,
  resolveCredential = createEnvCredentialResolver(env),
  now = () => new Date().toISOString(),
}) {
  const registry = registerConnectorPlugins();
  const results = [];
  for (const sourceId of LIVE_SMOKE_SOURCE_IDS) {
    results.push(
      await smokeTestSource({
        sourceId,
        configuration,
        registry,
        dependencies: { resolveCredential, fetch: fetchImpl, env },
      }),
    );
  }
  return {
    generatedAt: now(),
    tenantId: configuration.tenantId,
    productId: configuration.productId,
    results,
  };
}
