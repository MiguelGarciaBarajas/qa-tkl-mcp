import { readFileSync } from "node:fs";
import {
  createCredentialReferenceResolver,
  createIdentityAdapter,
  createStaticTokenResolver,
  createTokenAuthenticator,
  PolicyError
} from "../../policy/src/index.js";

export { createIdentityClaimsMapper, createIdentityVerifier } from "./identity-provider.js";

/**
 * OPS-102: deployment configuration validation, a concrete (swappable) environment-
 * variable-backed secret resolver, and configurable audit destination wiring for the
 * API and MCP gateway composition roots (`apps/api/src/server.js`,
 * `apps/mcp-gateway/src/server.js`).
 *
 * Production identity uses the provider-neutral OIDC/JWKS verifier exposed through
 * `createIdentityVerifier`; the deployment supplies its approved issuer, audience, and
 * claim names. The secret manager remains outside the process and injects values into
 * the environment variables resolved by `createEnvCredentialResolver`.
 *
 * Credentials have a safe environment-variable-backed default implementation. Identity
 * deliberately has none: no token is ever accepted without a verifier supplied by trusted
 * composition code, and production startup fails while that verifier is missing.
 */

const SUPPORTED_AUDIT_DESTINATIONS = new Set(["console", "stdout", "none"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deterministically derives an environment variable name for a `secret://` reference,
 * e.g. `secret://jira/fl-titling` -> `TKL_SECRET__JIRA__FL_TITLING`. An `env://NAME`
 * reference resolves directly to `NAME` (its own explicit, already-named variable).
 * Never guesses or falls back to a default value: an unresolved reference always
 * throws rather than returning `undefined` or an empty string.
 */
export function credentialReferenceEnvVarName(reference) {
  if (typeof reference !== "string") {
    throw new TypeError("A credential reference string is required");
  }
  if (reference.startsWith("env://")) {
    return reference.slice("env://".length);
  }
  if (reference.startsWith("secret://")) {
    const path = reference.slice("secret://".length);
    return `TKL_SECRET__${path
      .split("/")
      .filter((segment) => segment.length > 0)
      .join("__")
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_")}`;
  }
  throw new TypeError(`Unsupported credential reference scheme: "${reference}"`);
}

/**
 * Loads a product configuration JSON file (e.g. `config/products/fl-titling.json`).
 * Returns `undefined` if the file cannot be loaded outside production, or throws
 * in production when the file is missing/unreadable.
 */
export function loadProductConfiguration({
  productId = process.env.TKL_PRODUCT_ID ?? "fl-titling",
  configPath,
  env = process.env,
} = {}) {
  const targetPath = configPath
    ?? env?.TKL_PRODUCT_CONFIG_PATH
    ?? new URL(`../../../config/products/${productId}.json`, import.meta.url);
  try {
    const raw = readFileSync(targetPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (env?.NODE_ENV === "production") {
      throw new Error(`Failed to load product configuration for "${productId}": ${error.message}`);
    }
    return undefined;
  }
}

export const IDENTITY_VERIFIER_REQUIRED_MESSAGE =
  "No identity verifier is wired. An identity adapter requires an explicit verifyToken "
  + "function (or a fully built identityAdapter) supplied by trusted composition code, which "
  + "cryptographically verifies the presented token against the approved identity provider. "
  + "There is no built-in default: accepting a token without verification would let any caller "
  + "self-assert subject, roles, permissions, and product access. TKL_IDENTITY_PROVIDER is only "
  + "a label and never authenticates anything. Configure TKL_IDENTITY_ISSUER and "
  + "TKL_IDENTITY_AUDIENCE before deploying.";

function requireClaimStringArray(value, field, { rejectWildcard = false } = {}) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new PolicyError(
      401,
      "invalid_auth_context",
      `Verified claim "${field}" must be an array of non-empty strings.`,
    );
  }
  if (rejectWildcard && value.includes("*")) {
    throw new PolicyError(
      401,
      "invalid_auth_context",
      `Verified claim "${field}" must contain explicit product identifiers, not wildcard access.`,
    );
  }
  return [...value];
}

/**
 * Maps already-verified identity provider claims onto a `@tkl/policy` auth context.
 * Only what the verifier actually asserted is carried over: nothing is defaulted to a
 * role, permission, or product (in particular never `"*"`), so an incomplete claim set
 * produces an authenticated-but-unprivileged context that `assertAuthorized` denies.
 */
function toAuthContext(claims, { env }) {
  if (!isRecord(claims)) {
    throw new PolicyError(401, "unauthenticated", "The identity token is invalid.");
  }
  const subject = claims.subject ?? claims.sub;
  if (typeof subject !== "string" || subject.trim().length === 0) {
    throw new PolicyError(401, "unauthenticated", "Verified claims must include a non-empty subject.");
  }

  const tenantId = claims.tenantId ?? claims.tid;
  if (tenantId !== undefined && (typeof tenantId !== "string" || tenantId.trim().length === 0)) {
    throw new PolicyError(401, "invalid_auth_context", "Verified claim \"tenantId\" must be a non-empty string.");
  }
  const configuredTenantId =
    typeof env.TKL_TENANT_ID === "string" && env.TKL_TENANT_ID.trim().length > 0
      ? env.TKL_TENANT_ID.trim()
      : undefined;
  if (tenantId !== undefined && configuredTenantId !== undefined && tenantId !== configuredTenantId) {
    throw new PolicyError(403, "tenant_access_denied", "The subject cannot access this tenant.", {
      tenantId: configuredTenantId,
    });
  }

  return {
    subject,
    roles: requireClaimStringArray(claims.roles, "roles"),
    permissions: requireClaimStringArray(claims.permissions, "permissions"),
    productIds: requireClaimStringArray(claims.productIds, "productIds", { rejectWildcard: true }),
    ...(tenantId !== undefined ? { tenantId } : {}),
  };
}

/**
 * Builds the provider-neutral identity adapter seam (`createIdentityAdapter` from
 * `@tkl/policy`) around a caller-supplied `verifyToken`.
 *
 * `verifyToken` is mandatory and must perform real cryptographic verification (signature,
 * issuer, audience, expiry) with the approved identity provider; this package deliberately
 * ships no default verifier, so a deployment can never authenticate an arbitrary or
 * self-asserted token. Verified claims are then normalized by `toAuthContext`, which copies
 * only asserted roles/permissions/products and never fabricates reader or wildcard access.
 */
export function createEnvIdentityAdapter({
  env = process.env,
  verifyToken,
  mapClaims = (claims) => claims,
} = {}) {
  if (!isRecord(env)) {
    throw new TypeError("env must be an object");
  }
  if (typeof verifyToken !== "function") {
    throw new TypeError(IDENTITY_VERIFIER_REQUIRED_MESSAGE);
  }
  if (typeof mapClaims !== "function") {
    throw new TypeError("mapClaims must be a function");
  }

  return createIdentityAdapter({
    verifyToken,
    mapClaims: async (claims) => toAuthContext(await mapClaims(claims), { env }),
  });
}

/**
 * Builds a configured `createTokenAuthenticator` according to the active deployment
 * environment:
 * - In production (or when `TKL_IDENTITY_PROVIDER` is set), an identity adapter is used
 *   and a real verifier is mandatory: either a fully built `identityAdapter` or a
 *   `verifyToken` function supplied by trusted composition code. When neither is
 *   supplied this throws (fail closed) rather than authenticating unverified tokens.
 * - In development/test without an identity provider, uses `createStaticTokenResolver`
 *   with `TKL_AUTH_TOKENS`; that path is never reachable in production.
 */
export function createConfiguredAuthenticator({
  env = process.env,
  identityAdapter,
  tokenResolver,
  verifyToken,
  mapClaims,
} = {}) {
  if (!isRecord(env)) {
    throw new TypeError("env must be an object");
  }
  const isProduction = env.NODE_ENV === "production";
  const hasIdp = typeof env.TKL_IDENTITY_PROVIDER === "string" && env.TKL_IDENTITY_PROVIDER.trim().length > 0;

  if (isProduction || hasIdp || identityAdapter !== undefined || typeof verifyToken === "function") {
    if (identityAdapter !== undefined) {
      return createTokenAuthenticator({ identityAdapter });
    }
    if (typeof verifyToken !== "function") {
      throw new Error(IDENTITY_VERIFIER_REQUIRED_MESSAGE);
    }
    return createTokenAuthenticator({
      identityAdapter: createEnvIdentityAdapter({ env, verifyToken, mapClaims }),
    });
  }

  const tokenMap = env.TKL_AUTH_TOKENS ? JSON.parse(env.TKL_AUTH_TOKENS) : {};
  const resolver = tokenResolver ?? createStaticTokenResolver(tokenMap);
  return createTokenAuthenticator({ tokenResolver: resolver });
}

/**
 * A concrete, environment-variable-backed secret manager resolver. Wrapped in
 * `createCredentialReferenceResolver` so reference-format validation stays identical
 * to every other credential-resolving caller in the repository. Fails closed
 * (throws) when the mapped environment variable is missing or empty; never returns a
 * placeholder value, and never logs the resolved secret.
 */
export function createEnvCredentialResolver({ env = process.env } = {}) {
  if (!isRecord(env)) {
    throw new TypeError("env must be an object");
  }
  return createCredentialReferenceResolver({
    async resolve(reference) {
      const envVarName = credentialReferenceEnvVarName(reference);
      const value = env[envVarName];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(
          `Credential reference "${reference}" did not resolve: environment variable `
          + `"${envVarName}" is not set. Configure it through the approved secret `
          + `manager before deploying this environment.`,
        );
      }
      return value;
    },
  });
}

/**
 * Builds the audit sink `createAuditLogger` records events to, selected by
 * `TKL_AUDIT_DESTINATION` (or an explicit `destination`). `"console"` is the local
 * development default; `"stdout"` emits one compact JSON object per line, suited to
 * any log-shipping agent that forwards a process's standard output to approved
 * observability infrastructure; `"none"` discards events and must only be used in
 * tests. An unrecognized destination fails closed (throws) rather than silently
 * falling back to a default, so a deployment typo can never silently disable
 * auditing.
 */
export function createAuditSink({ destination = process.env.TKL_AUDIT_DESTINATION ?? "console" } = {}) {
  if (!SUPPORTED_AUDIT_DESTINATIONS.has(destination)) {
    throw new TypeError(
      `Unsupported audit destination "${destination}"; expected one of `
      + `${[...SUPPORTED_AUDIT_DESTINATIONS].join(", ")}`,
    );
  }
  if (destination === "console") {
    return console;
  }
  if (destination === "stdout") {
    return {
      info(event) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      },
    };
  }
  return { info() {} };
}

function checklistItem(id, status, detail) {
  return { id, status, detail };
}

/**
 * Validates the environment a TKL API/MCP process is about to start in, returning an
 * "Environment validation checklist" (OPS-102's required verification artifact): one
 * pass/fail/skipped entry per control, plus an overall `ready` flag. Production-only
 * controls (identity provider, identity verifier, transport security, audit destination,
 * secret resolution) are `skipped` -- never silently passed -- outside production, so a
 * checklist reader can always tell a control was not evaluated rather than assuming
 * it was satisfied.
 *
 * `identityVerifier` is the verifier function the calling composition root wired into its
 * authenticator (see `createIdentityVerifier`). In production it must be a function:
 * `TKL_IDENTITY_PROVIDER` alone is a label and proves nothing about token verification.
 *
 * This never performs the deployment itself and never picks the identity
 * provider/secret manager/deployment target on the caller's behalf: those remain the
 * External Decisions Register entries for OPS-102; this only proves the environment
 * the caller already configured is internally consistent and complete before the
 * server starts.
 */
export function validateDeploymentEnvironment({
  env = process.env,
  productConfig,
  identityVerifier,
  isProduction = env.NODE_ENV === "production",
} = {}) {
  if (!isRecord(env)) {
    throw new TypeError("env must be an object");
  }
  const checklist = [];

  const portRaw = env.PORT;
  let portItem;
  if (portRaw === undefined) {
    portItem = checklistItem("port", "pass", "PORT is unset; the service default port applies");
  } else {
    const portStr = String(portRaw).trim();
    const isDigitsOnly = /^\d+$/.test(portStr);
    const portNum = Number.parseInt(portStr, 10);
    if (isDigitsOnly && Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535) {
      portItem = checklistItem("port", "pass", `PORT is a valid port (${portNum})`);
    } else {
      portItem = checklistItem("port", "fail", `PORT "${portRaw}" is not an integer between 1 and 65535`);
    }
  }
  checklist.push(portItem);

  const tenantId = env.TKL_TENANT_ID;
  checklist.push(
    tenantId === undefined
      ? isProduction
        ? checklistItem("tenant_id", "fail", "TKL_TENANT_ID is required in production")
        : checklistItem("tenant_id", "pass", "TKL_TENANT_ID is unset; the development default tenant applies")
      : typeof tenantId === "string" && tenantId.trim().length > 0
        ? checklistItem("tenant_id", "pass", `TKL_TENANT_ID is configured (${tenantId})`)
        : checklistItem("tenant_id", "fail", "TKL_TENANT_ID must not be empty"),
  );

  const auditDestination = env.TKL_AUDIT_DESTINATION ?? "console";
  if (!SUPPORTED_AUDIT_DESTINATIONS.has(auditDestination)) {
    checklist.push(
      checklistItem(
        "audit_destination",
        "fail",
        `TKL_AUDIT_DESTINATION "${auditDestination}" is not one of `
        + `${[...SUPPORTED_AUDIT_DESTINATIONS].join(", ")}`,
      ),
    );
  } else if (isProduction) {
    checklist.push(
      auditDestination === "stdout"
        ? checklistItem("audit_destination", "pass", "TKL_AUDIT_DESTINATION=stdout ships audit events to approved observability infrastructure")
        : checklistItem(
            "audit_destination",
            "fail",
            `TKL_AUDIT_DESTINATION must be "stdout" (or another shipped destination) in production, got "${auditDestination}"`,
          ),
    );
  } else {
    checklist.push(checklistItem("audit_destination", "pass", `TKL_AUDIT_DESTINATION=${auditDestination}`));
  }

  if (isProduction) {
    const isIdpConfigured =
      typeof env.TKL_IDENTITY_PROVIDER === "string" && env.TKL_IDENTITY_PROVIDER.trim().length > 0;
    checklist.push(
      env.TKL_AUTH_TOKENS || env.TKL_IDENTITY_TOKENS
        ? checklistItem(
            "identity_provider",
            "fail",
            "TKL_AUTH_TOKENS/TKL_IDENTITY_TOKENS (development static token maps) must not be set in "
            + "production; inject an approved identity adapter through createIdentityAdapter instead",
          )
        : isIdpConfigured
          ? checklistItem(
              "identity_provider",
              "pass",
              `TKL_IDENTITY_PROVIDER=${env.TKL_IDENTITY_PROVIDER.trim()} is configured (a label only; `
              + "see identity_verifier for the control that actually authenticates tokens)",
            )
          : checklistItem(
              "identity_provider",
              "fail",
              "TKL_IDENTITY_PROVIDER is required in production (the approved identity platform, e.g. Entra ID)",
            ),
    );
    checklist.push(
      typeof identityVerifier === "function"
        ? checklistItem(
            "identity_verifier",
            "pass",
            "A verifier function is wired into the authenticator; tokens are cryptographically verified "
            + "by the approved identity provider before any claim is trusted",
          )
        : checklistItem(
            "identity_verifier",
            "fail",
            "No identity provider verifier is wired into this process. TKL_IDENTITY_PROVIDER is only a "
            + "label: configure TKL_IDENTITY_ISSUER and TKL_IDENTITY_AUDIENCE (and optionally "
            + "TKL_IDENTITY_JWKS_URI) so createIdentityVerifier can authenticate tokens safely",
          ),
    );
    checklist.push(
      env.TKL_REQUIRE_TLS === "true"
        ? checklistItem("transport_security", "pass", "TKL_REQUIRE_TLS=true")
        : checklistItem(
            "transport_security",
            "fail",
            'TKL_REQUIRE_TLS must be "true" in production; deploy behind HTTPS/TLS 1.2+ termination',
          ),
    );
  } else {
    checklist.push(checklistItem("identity_provider", "skipped", "Only evaluated in production"));
    checklist.push(checklistItem("identity_verifier", "skipped", "Only evaluated in production"));
    checklist.push(checklistItem("transport_security", "skipped", "Only evaluated in production"));
  }

  const effectiveConfig = productConfig !== undefined ? productConfig : loadProductConfiguration({ env });
  if (effectiveConfig !== undefined) {
    if (!isRecord(effectiveConfig)) {
      checklist.push(checklistItem("secret_resolution", "fail", "productConfig must be an object"));
    } else if (!isRecord(effectiveConfig.credentialRefs)) {
      checklist.push(checklistItem("secret_resolution", "fail", "productConfig.credentialRefs must be an object"));
    } else {
      const rawEnabled = Array.isArray(effectiveConfig.enabledPlugins) ? effectiveConfig.enabledPlugins : [];
      const enabledConnectors = rawEnabled.filter((id) => typeof id === "string" && id.startsWith("connector."));
      const missingDefinitions = enabledConnectors.filter(
        (pluginId) => typeof effectiveConfig.credentialRefs[pluginId] !== "string",
      );

      if (missingDefinitions.length > 0) {
        checklist.push(
          checklistItem(
            "secret_resolution",
            "fail",
            `Missing credential reference definition in productConfig for enabled plugin(s): ${missingDefinitions.join(", ")}`,
          ),
        );
      } else {
        const relevantRefs = enabledConnectors.map((pluginId) => [pluginId, effectiveConfig.credentialRefs[pluginId]]);
        if (relevantRefs.length === 0) {
          checklist.push(checklistItem("secret_resolution", "pass", "No enabled plugin requires a credential reference"));
        } else if (!isProduction) {
          checklist.push(
            checklistItem(
              "secret_resolution",
              "skipped",
              "Only evaluated in production (fixture/local credential injection is permitted otherwise)",
            ),
          );
        } else {
          const unresolved = relevantRefs
            .map(([pluginId, reference]) => {
              try {
                return { pluginId, reference, envVarName: credentialReferenceEnvVarName(reference) };
              } catch (err) {
                return { pluginId, reference, error: err.message };
              }
            })
            .filter((item) => item.error || typeof env[item.envVarName] !== "string" || env[item.envVarName].trim().length === 0);

          checklist.push(
            unresolved.length === 0
              ? checklistItem("secret_resolution", "pass", `${relevantRefs.length} enabled plugin credential(s) resolve`)
              : checklistItem(
                  "secret_resolution",
                  "fail",
                  `Missing secret manager values for: ${unresolved
                    .map(({ pluginId, envVarName, error }) => (error ? `${pluginId} (${error})` : `${pluginId} (${envVarName})`))
                    .join(", ")}`,
                ),
          );
        }
      }
    }
  }

  return {
    environment: isProduction ? "production" : "development",
    ready: checklist.every((item) => item.status !== "fail"),
    checklist,
  };
}
