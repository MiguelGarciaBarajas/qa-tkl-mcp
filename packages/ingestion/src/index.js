/**
 * Config-driven registration and composition of the real source connectors
 * (ING-104). This is the missing wiring between the already-configurable
 * product configuration (`config/products/*.json`, ARCH-103) and the
 * already-built plugin registry/composition root (`@tkl/plugin-registry`,
 * `@tkl/core`, ARCH-104) on one side, and the real production connector
 * plugins (`@tkl/connector-jira`, `@tkl/connector-github`,
 * `@tkl/connector-testrail`, ING-101..103) on the other. Before this
 * package existed, nothing in the repository ever registered those
 * connectors' real manifests/factories into a `PluginRegistry`, so
 * `composeConfiguredPlugins` had no connector to compose.
 *
 * Each connector is composed independently from `enabledPlugins`/`sources`
 * in product configuration (`composeConfiguredPlugins` already only
 * instantiates plugins listed in `enabledPlugins`; disabling one plugin --
 * or leaving it in `plannedPlugins` -- never affects composition of the
 * others). No source-specific allowlist value (Jira project/JQL filter,
 * GitHub repository) is invented here: every value must already be present
 * in `configuration.sources.<source>` (mirroring product config) or the
 * corresponding factory fails closed with a specific error identifying the
 * missing key, rather than substituting an unapproved default. See
 * `docs/team/TKL-Delivery-Backlog.md`'s "External Decisions Register" for
 * which of these are still pending approval (for example, the Jira
 * project/JQL filter).
 *
 * Credential resolution is intentionally left to the caller
 * (`dependencies.resolveCredential`, a per-product-context dependency
 * accepted by `composeConfiguredPlugins`): this package has no opinion on
 * which secret provider is used (SEC-101 defines the provider-neutral
 * boundary; the concrete provider is OPS-102, not yet built).
 */
import { composeConfiguredPlugins } from "@tkl/core";
import { PluginRegistry } from "@tkl/plugin-registry";
import {
  createJiraHttpClient,
  JiraConnector,
  jiraManifest,
} from "@tkl/connector-jira";
import {
  createGitHubHttpClient,
  GitHubConnector,
  githubManifest,
} from "@tkl/connector-github";
import {
  createTestRailHttpClient,
  TestRailConnector,
  testrailManifest,
} from "@tkl/connector-testrail";
import {
  createConfluenceHttpClient,
  ConfluenceConnector,
  confluenceManifest,
} from "@tkl/connector-confluence";
import {
  createReportPortalHttpClient,
  ReportPortalConnector,
  reportportalManifest,
} from "@tkl/connector-reportportal";

export {
  jiraManifest,
  githubManifest,
  testrailManifest,
  confluenceManifest,
  reportportalManifest,
};
export const CONNECTOR_MANIFESTS = Object.freeze([
  jiraManifest,
  githubManifest,
  testrailManifest,
  confluenceManifest,
  reportportalManifest,
]);

function nonEmptyStringArray(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const normalized = value.map((entry) => typeof entry === "string" ? entry.trim() : "");
  return normalized.every((entry) => entry.length > 0) ? normalized : undefined;
}

function jiraProjectKey(issueKey) {
  const match = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(String(issueKey ?? "").trim());
  return match ? match[1].toUpperCase() : undefined;
}

function positiveIntegerId(value) {
  const normalized = typeof value === "number" || typeof value === "string"
    ? String(value).trim()
    : "";
  if (!/^\d+$/.test(normalized) || BigInt(normalized) <= 0n) return undefined;
  return BigInt(normalized).toString();
}

function readEnvValue(env, envVarName) {
  if (typeof envVarName !== "string" || envVarName.length === 0) return undefined;
  const value = env?.[envVarName];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readEnvListValue(env, envVarName) {
  const raw = readEnvValue(env, envVarName);
  if (!raw) return undefined;
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Builds a real, allowlist-enforcing Jira connector from `sources.jira`.
 * `allowedProjects`/`allowedJql` must already be present in configuration --
 * this never derives them from `jql`/`issueKey`, which is a specific query,
 * not an approved allowlist.
 */
function createJiraPlugin({ tenantId, productId, credentialRef, configuration, dependencies = {} }) {
  const allowedProjects = nonEmptyStringArray(configuration.allowedProjects);
  const allowedJql = nonEmptyStringArray(configuration.allowedJql);
  const normalizedAllowedProjects = allowedProjects?.map((project) => project.toUpperCase());
  const issueKey = typeof configuration.issueKey === "string" ? configuration.issueKey.trim() : "";
  const jql = typeof configuration.jql === "string" ? configuration.jql.trim() : "";
  const missing = [
    !allowedProjects && "sources.jira.allowedProjects",
    !allowedJql && "sources.jira.allowedJql",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new TypeError(
      `connector.jira cannot be registered: missing required, not-yet-approved configuration `
      + `(${missing.join(", ")}). See the "External Decisions Register" in `
      + `docs/team/TKL-Delivery-Backlog.md for the Jira project/JQL filter decision.`,
    );
  }
  if (!issueKey && !jql) {
    throw new TypeError(
      "connector.jira cannot be registered: sources.jira must define either issueKey or jql",
    );
  }
  if (jql && !allowedJql.includes(jql)) {
    throw new TypeError("connector.jira cannot be registered: sources.jira.jql is not allowlisted");
  }
  if (issueKey) {
    const projectKey = jiraProjectKey(issueKey);
    if (!projectKey || !normalizedAllowedProjects.includes(projectKey)) {
      throw new TypeError(
        "connector.jira cannot be registered: sources.jira.issueKey is invalid or not allowlisted",
      );
    }
  }

  const client = dependencies.client ?? createJiraHttpClient({
    fetch: dependencies.fetch,
    baseUrl: configuration.baseUrl,
    credentialRef,
    resolveCredential: dependencies.resolveCredential,
    allowedProjects: normalizedAllowedProjects,
    allowedJql,
    allowInsecureLoopback: configuration.allowInsecureLoopback,
  });

  return new JiraConnector({
    client,
    tenantId,
    productId,
    credentialRef,
    issueKey: issueKey || undefined,
    jql: jql || undefined,
    incrementalLookbackSeconds: configuration.incrementalLookbackSeconds,
    baseUrl: configuration.baseUrl,
    allowInsecureLoopback: configuration.allowInsecureLoopback,
  });
}

/**
 * Builds a real, allowlist-enforcing GitHub connector from `sources.github`.
 * Each connector instance receives one already-validated repository target.
 * Products with multiple targets compose/run one instance per target at the
 * API orchestration layer while sharing the source credential resolver.
 */
function createGitHubPlugin({ tenantId, productId, credentialRef, configuration, dependencies = {} }) {
  const repository = typeof configuration.repository === "string" ? configuration.repository.trim() : "";
  if (repository.length === 0) {
    throw new TypeError("connector.github cannot be registered: sources.github.repository is required");
  }

  const client = dependencies.client ?? createGitHubHttpClient({
    fetch: dependencies.fetch,
    apiUrl: configuration.apiUrl,
    webBaseUrl: configuration.webBaseUrl,
    credentialRef,
    resolveCredential: dependencies.resolveCredential,
    allowedRepositories: [repository],
    allowInsecureLoopback: configuration.allowInsecureLoopback,
  });

  return new GitHubConnector({
    client,
    tenantId,
    productId,
    credentialRef,
    repository,
    incrementalLookbackSeconds: configuration.incrementalLookbackSeconds,
    webBaseUrl: configuration.webBaseUrl,
    allowInsecureLoopback: configuration.allowInsecureLoopback,
  });
}

/**
 * Builds a real TestRail connector from `sources.testrail`. The base URL and
 * project ID can be resolved indirectly through named environment variables.
 * Suite scope defaults to the complete project; an explicit `selected` scope
 * resolves its suite IDs from configuration or `suiteIdsEnv`.
 * Until the required connection values resolve, this fails
 * closed with a specific error instead of guessing values -- consistent
 * with `sources.testrail.configurationStatus` staying
 * `"pending-external-input"` and `connector.testrail` staying out of
 * `enabledPlugins` today.
 */
function createTestRailPlugin({ tenantId, productId, credentialRef, configuration, dependencies = {} }) {
  const env = dependencies.env ?? process.env;
  const baseUrl = configuration.baseUrl ?? readEnvValue(env, configuration.baseUrlEnv);
  const rawProjectId = configuration.projectId ?? readEnvValue(env, configuration.projectIdEnv);
  const rawSuiteIds = configuration.suiteIds ?? readEnvListValue(env, configuration.suiteIdsEnv);
  const suiteScope = configuration.suiteScope ?? (rawSuiteIds ? "selected" : "all");

  if (!baseUrl || !rawProjectId) {
    throw new TypeError(
      "connector.testrail cannot be registered: baseUrl/baseUrlEnv and projectId/projectIdEnv must "
      + "resolve to a value before this connector can be composed.",
    );
  }
  const projectId = positiveIntegerId(rawProjectId);
  if (!projectId) {
    throw new TypeError(
      "connector.testrail cannot be registered: projectId must be a positive integer",
    );
  }
  const suiteIds = Array.isArray(rawSuiteIds) ? rawSuiteIds.map(positiveIntegerId) : [];
  if (!["all", "selected"].includes(suiteScope)) {
    throw new TypeError(
      'connector.testrail cannot be registered: suiteScope must be either "all" or "selected"',
    );
  }
  if (suiteScope === "selected" && (suiteIds.length === 0 || suiteIds.some((suiteId) => !suiteId))) {
    throw new TypeError(
      "connector.testrail cannot be registered: selected suite scope requires at least one positive integer suite ID",
    );
  }

  const client = dependencies.client ?? createTestRailHttpClient({
    fetch: dependencies.fetch,
    baseUrl,
    credentialRef,
    resolveCredential: dependencies.resolveCredential,
    allowInsecureLoopback: configuration.allowInsecureLoopback,
  });

  return new TestRailConnector({
    client,
    tenantId,
    productId,
    credentialRef,
    projectId,
    suiteScope,
    suiteIds,
    incrementalLookbackSeconds: configuration.incrementalLookbackSeconds,
    baseUrl,
    allowInsecureLoopback: configuration.allowInsecureLoopback,
  });
}

function createConfluencePlugin({
  tenantId,
  productId,
  credentialRef,
  configuration,
  dependencies = {},
}) {
  const baseUrl = typeof configuration.baseUrl === "string" ? configuration.baseUrl.trim() : "";
  const username = typeof configuration.username === "string" ? configuration.username.trim() : "";
  const authMode = configuration.authMode ?? "basic";
  const spaceKeys = nonEmptyStringArray(configuration.spaceKeys);
  const contentScope = configuration.contentScope ?? "space";
  const rootPageRefs = nonEmptyStringArray(configuration.rootPageRefs);
  if (!baseUrl || !username || !spaceKeys) {
    throw new TypeError(
      "connector.confluence cannot be registered: baseUrl, username, and spaceKeys are required",
    );
  }
  if (!["tree", "page", "space"].includes(contentScope)) {
    throw new TypeError('connector.confluence cannot be registered: contentScope must be "tree", "page", or "space"');
  }
  if (!["basic", "bearer"].includes(authMode)) {
    throw new TypeError('connector.confluence cannot be registered: authMode must be "basic" or "bearer"');
  }
  if (contentScope !== "space" && !rootPageRefs) {
    throw new TypeError("connector.confluence cannot be registered: page-scoped ingestion requires rootPageRefs");
  }

  const client = dependencies.client ?? createConfluenceHttpClient({
    fetch: dependencies.fetch,
    baseUrl,
    username,
    authMode,
    credentialRef,
    resolveCredential: dependencies.resolveCredential,
    allowedSpaceKeys: spaceKeys,
    allowInsecureLoopback: configuration.allowInsecureLoopback,
  });
  return new ConfluenceConnector({
    client,
    tenantId,
    productId,
    credentialRef,
    baseUrl,
    spaceKeys,
    contentScope,
    rootPageRefs,
    incrementalLookbackSeconds: configuration.incrementalLookbackSeconds,
    allowInsecureLoopback: configuration.allowInsecureLoopback,
  });
}

function createReportPortalPlugin({
  tenantId,
  productId,
  credentialRef,
  configuration,
  dependencies = {},
}) {
  const baseUrl = typeof configuration.baseUrl === "string" ? configuration.baseUrl.trim() : "";
  const project = typeof configuration.project === "string" ? configuration.project.trim() : "";
  if (!baseUrl || !project) {
    throw new TypeError(
      "connector.reportportal cannot be registered: baseUrl and project are required",
    );
  }

  const client = dependencies.client ?? createReportPortalHttpClient({
    fetch: dependencies.fetch,
    baseUrl,
    project,
    incrementalLookbackSeconds: configuration.incrementalLookbackSeconds,
    credentialRef,
    resolveCredential: dependencies.resolveCredential,
    allowInsecureLoopback: configuration.allowInsecureLoopback,
    allowInsecureHost: configuration.allowInsecureHost,
  });
  return new ReportPortalConnector({
    client,
    tenantId,
    productId,
    credentialRef,
    baseUrl,
    project,
    incrementalLookbackSeconds: configuration.incrementalLookbackSeconds,
    allowInsecureLoopback: configuration.allowInsecureLoopback,
    allowInsecureHost: configuration.allowInsecureHost,
  });
}

const CONNECTOR_FACTORIES = {
  [jiraManifest.id]: createJiraPlugin,
  [githubManifest.id]: createGitHubPlugin,
  [testrailManifest.id]: createTestRailPlugin,
  [confluenceManifest.id]: createConfluencePlugin,
  [reportportalManifest.id]: createReportPortalPlugin,
};

/**
 * Builds a `PluginRegistry` with all three real connector plugins
 * registered. Accepts an existing registry (for example, one that already
 * has other plugin families registered) so this never assumes it owns the
 * whole platform registry.
 */
export function registerConnectorPlugins(registry = new PluginRegistry()) {
  for (const manifest of CONNECTOR_MANIFESTS) {
    const factory = CONNECTOR_FACTORIES[manifest.id];
    const existing = registry.get(manifest.id);
    if (existing) {
      if (existing.manifest === manifest && existing.create === factory) continue;
      throw new TypeError(
        `Plugin "${manifest.id}" is already registered with a different manifest or factory`,
      );
    }
    registry.register({ manifest, create: factory });
  }
  return registry;
}

/**
 * Composes only the connectors listed in `configuration.enabledPlugins`
 * (validated product configuration) into real connector instances. A
 * connector left in `plannedPlugins`, or simply absent from
 * `enabledPlugins`, is never instantiated and never has its factory
 * invoked -- so each connector is independently disableable purely through
 * configuration, with no code change required.
 */
export function composeConnectors({ configuration, registry = registerConnectorPlugins(), dependencies = {} }) {
  return composeConfiguredPlugins({ configuration, registry, dependencies });
}
