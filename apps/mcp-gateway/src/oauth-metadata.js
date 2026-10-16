/**
 * MCP-103: OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP gateway.
 *
 * The gateway is an OAuth *resource server* only. It never issues, mints, validates, or
 * introspects tokens here, and it never stands up a local identity provider: token
 * verification remains owned by the Application API policy layer and the verifier wired
 * through `packages/ops/src/identity-provider.js` (PR #24). This module only publishes
 * the already-configured issuer and resource values so a standards-compliant MCP client
 * can discover where to authenticate.
 *
 * Configuration is all-or-nothing and fails closed: a production process must not start
 * without it, and a partially configured environment is an error rather than a partially
 * advertised resource.
 */

export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

export const PROTECTED_RESOURCE_METADATA_REQUIRED_MESSAGE =
  "OAuth protected-resource metadata is not configured. Set TKL_MCP_RESOURCE_URI to this "
  + "gateway's canonical resource URI and TKL_MCP_AUTHORIZATION_SERVERS to the approved "
  + "authorization server issuer URL(s). The authorization server remains an external "
  + "decision (see the \"External Decisions Register\" in docs/team/TKL-Delivery-Backlog.md); "
  + "this gateway publishes configured values only and never acts as an identity provider.";

function trimmedValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError("OAuth metadata configuration values must be strings");
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseList(value, variableName) {
  const trimmed = trimmedValue(value);
  if (trimmed === undefined) {
    return [];
  }
  const entries = trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error(`${variableName} must list at least one non-empty value.`);
  }
  return entries;
}

function assertPublishableUrl(value, variableName, { isProduction }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be an absolute URL, got "${value}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${variableName} must use https (http is allowed only for local development).`);
  }
  if (isProduction && url.protocol !== "https:") {
    throw new Error(`${variableName} must use https in production.`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${variableName} must not embed credentials.`);
  }
  if (url.hash.length > 0) {
    throw new Error(`${variableName} must not include a fragment.`);
  }
  return url;
}

/**
 * Builds the metadata document from configuration, or returns `undefined` outside
 * production when no OAuth configuration is present at all. Any partial or invalid
 * configuration throws in every environment.
 */
export function loadProtectedResourceMetadata({
  env = process.env,
  isProduction = env.NODE_ENV === "production"
} = {}) {
  const resource = trimmedValue(env.TKL_MCP_RESOURCE_URI);
  const authorizationServers = parseList(
    env.TKL_MCP_AUTHORIZATION_SERVERS,
    "TKL_MCP_AUTHORIZATION_SERVERS"
  );
  const scopesSupported = parseList(env.TKL_MCP_SCOPES_SUPPORTED, "TKL_MCP_SCOPES_SUPPORTED");
  const documentation = trimmedValue(env.TKL_MCP_RESOURCE_DOCUMENTATION);

  if (resource === undefined && authorizationServers.length === 0) {
    if (isProduction) {
      throw new Error(PROTECTED_RESOURCE_METADATA_REQUIRED_MESSAGE);
    }
    return undefined;
  }
  if (resource === undefined) {
    throw new Error(
      "TKL_MCP_RESOURCE_URI is required whenever TKL_MCP_AUTHORIZATION_SERVERS is configured."
    );
  }
  if (authorizationServers.length === 0) {
    throw new Error(
      "TKL_MCP_AUTHORIZATION_SERVERS is required whenever TKL_MCP_RESOURCE_URI is configured."
    );
  }

  assertPublishableUrl(resource, "TKL_MCP_RESOURCE_URI", { isProduction });
  for (const issuer of authorizationServers) {
    assertPublishableUrl(issuer, "TKL_MCP_AUTHORIZATION_SERVERS", { isProduction });
  }
  if (documentation !== undefined) {
    assertPublishableUrl(documentation, "TKL_MCP_RESOURCE_DOCUMENTATION", { isProduction });
  }

  return Object.freeze({
    resource,
    authorization_servers: Object.freeze([...authorizationServers]),
    bearer_methods_supported: Object.freeze(["header"]),
    ...(scopesSupported.length > 0
      ? { scopes_supported: Object.freeze([...scopesSupported]) }
      : {}),
    ...(documentation === undefined ? {} : { resource_documentation: documentation })
  });
}

/**
 * RFC 9728 locates a resource's metadata by inserting the well-known segment before the
 * resource path, e.g. `https://host/mcp` -> `https://host/.well-known/oauth-protected-resource/mcp`.
 */
export function protectedResourceMetadataUrl(metadata) {
  const url = new URL(metadata.resource);
  const resourcePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${PROTECTED_RESOURCE_METADATA_PATH}${resourcePath}`;
}

/** True for both the root and resource-path-suffixed metadata locations. */
export function isProtectedResourceMetadataPath(pathname) {
  return (
    pathname === PROTECTED_RESOURCE_METADATA_PATH
    || pathname.startsWith(`${PROTECTED_RESOURCE_METADATA_PATH}/`)
  );
}

function escapeHeaderValue(value) {
  // RFC 7230 quoted-string: drop anything outside printable US-ASCII (defeats CR/LF
  // header splitting) and escape the two characters that may not appear unescaped.
  return value.replace(/[^\x20-\x7e]/g, "").replace(/(["\\])/g, "\\$1");
}

/**
 * Builds the `WWW-Authenticate` challenge for a 401. The `resource_metadata` pointer is
 * included only when metadata is configured; no scope, issuer, or token material is
 * invented when it is not. Callers must pass fixed, authored `error`/`errorDescription`
 * values: upstream or caller-controlled text must never reach a response header.
 */
export function bearerChallenge({ metadata, error, errorDescription }) {
  const parameters = ['realm="tkl-mcp"'];
  if (typeof error === "string" && error.length > 0) {
    parameters.push(`error="${escapeHeaderValue(error)}"`);
  }
  if (typeof errorDescription === "string" && errorDescription.length > 0) {
    parameters.push(`error_description="${escapeHeaderValue(errorDescription)}"`);
  }
  if (metadata !== undefined) {
    parameters.push(`resource_metadata="${escapeHeaderValue(protectedResourceMetadataUrl(metadata))}"`);
  }
  return `Bearer ${parameters.join(", ")}`;
}
