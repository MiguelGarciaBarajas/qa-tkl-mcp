# @tkl/ops

Deployment configuration and environment validation for the API and MCP gateway
(OPS-102). This package enforces, at process startup, the "residual production
requirements" listed in `docs/security/TKL-Threat-Model.md`:

1. An approved identity adapter is configured in production (the dev-only static
   token map, `TKL_AUTH_TOKENS`, is rejected) **and a real token verifier is
   actually wired in**. `TKL_IDENTITY_PROVIDER` is only a label; it never
   authenticates anything by itself.
2. Connector/service credentials are resolved only through validated
   `secret://`/`env://` references (via `createEnvCredentialResolver`, which wraps
   `createCredentialReferenceResolver` from `@tkl/policy`).
3. Audit events are sent to an approved sink (`createAuditSink`), not silently
   left on the console default in production.
4. Transport security (HTTPS/TLS) is confirmed enforced in production.
5. The deployment environment is validated as a whole before the server accepts
   traffic (`validateDeploymentEnvironment`), failing closed on any missing item.

## Exports

- `credentialReferenceEnvVarName(reference)` — deterministically maps a
  `secret://a/b/c` or `env://NAME` reference to the environment variable name
  that stores its value (`secret://jira/fl-titling` → `TKL_SECRET__JIRA__FL_TITLING`).
- `createEnvCredentialResolver({ env })` — an environment-variable-backed
  implementation of the `@tkl/policy` credential reference resolver seam. Fails
  closed (throws) if the mapped variable is missing or empty; never logs the
  resolved value.
- `createAuditSink({ destination })` — returns a sink compatible with
  `createAuditLogger({ sink })` from `@tkl/observability`. Supported values for
  `TKL_AUDIT_DESTINATION` / `destination`: `console` (default, dev only),
  `stdout` (newline-delimited JSON, safe for production log collectors), `none`
  (discard, for tests). Any other value throws — there is no silent fallback.
- `loadProductConfiguration({ productId, configPath, env })` — loads product
  configuration JSON (e.g. `config/products/fl-titling.json`).
- `createIdentityVerifier({ env, fetchImpl, now })` — builds the production
  OIDC/JWKS verifier from explicit issuer and audience configuration. It verifies
  an RSA JWT signature, allowed algorithm, key use, issuer, audience, expiry,
  not-before, and issued-at before returning claims. JWKS responses are bounded
  and cached; an unknown key ID triggers one refresh for rotation. Missing
  configuration returns `undefined`, while partial or malformed configuration
  throws before the server listens.
- `createIdentityClaimsMapper({ env })` — maps configurable verified claim names
  to `subject`, `roles`, `permissions`, `productIds`, and `tenantId`. Missing
  authorization claims become empty collections rather than fabricated access.
- `createEnvIdentityAdapter({ env, verifyToken, mapClaims })` — builds an
  identity adapter satisfying `@tkl/policy`'s `createIdentityAdapter` contract.
  `verifyToken` is **required** and must cryptographically verify the token
  (signature, issuer, audience, expiry) with the approved provider; there is no
  default verifier. Verified claims are normalized into an auth context that
  carries only the roles, permissions, and products the provider asserted —
  nothing is defaulted to `reader` or `"*"`, and a claim tenant that contradicts
  `TKL_TENANT_ID` is rejected.
- `createConfiguredAuthenticator({ env, identityAdapter, tokenResolver, verifyToken, mapClaims })`
  — constructs a `createTokenAuthenticator` configured for the active
  environment. In production, or whenever `TKL_IDENTITY_PROVIDER` is set, it
  requires an injected `identityAdapter` or `verifyToken` and throws otherwise;
  the static token resolver path is reachable only in local development/test.
- `validateDeploymentEnvironment({ env, productConfig, identityVerifier, isProduction })`
  — runs the full startup checklist and returns `{ environment, ready, checklist }`.
  Checklist items: `port`, `tenant_id`, `audit_destination`, `identity_provider`,
  `identity_verifier`, `transport_security`, `secret_resolution` (evaluates
  supplied or auto-loaded `productConfig`). Identity provider, identity
  verifier, and transport security checks are `skipped` outside production, and
  never treated as failures there, so local/dev workflows are unaffected.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Optional, must be an integer 1-65535 if set. |
| `NODE_ENV` | `production` enables the strict checklist; anything else is treated as development. |
| `TKL_TENANT_ID` | Required in production. |
| `TKL_AUDIT_DESTINATION` | `console` \| `stdout` \| `none`. Must be `stdout` in production. |
| `TKL_AUTH_TOKENS` | Dev-only static token map. Must be unset in production. |
| `TKL_IDENTITY_TOKENS` | Not used. Must be unset in production; a static claim map is never a verifier. |
| `TKL_IDENTITY_PROVIDER` | Required in production (e.g. `entra-id`). A label for the approved platform only — it does not verify tokens; `createIdentityVerifier()` must supply the verifier. |
| `TKL_IDENTITY_ISSUER` | Exact HTTPS issuer expected in every verified token. Required to build the production verifier. |
| `TKL_IDENTITY_AUDIENCE` | One or more accepted token audiences, comma separated. Required to build the production verifier. |
| `TKL_IDENTITY_JWKS_URI` | Optional explicit HTTPS JWKS URL. If omitted, the verifier uses the issuer's OIDC discovery document. |
| `TKL_IDENTITY_ALLOWED_ALGORITHMS` | Optional comma-separated allowlist: `RS256`, `RS384`, `RS512`. Defaults to `RS256`. |
| `TKL_IDENTITY_JWKS_CACHE_TTL_SECONDS` | Optional positive cache TTL. Defaults to 300 seconds. |
| `TKL_IDENTITY_JWKS_REFRESH_COOLDOWN_SECONDS` | Minimum interval between unknown-key refresh attempts. Defaults to 30 seconds. |
| `TKL_IDENTITY_CLOCK_TOLERANCE_SECONDS` | Optional positive clock tolerance. Defaults to 60 seconds. |
| `TKL_IDENTITY_SUBJECT_CLAIM` | Subject claim name. Defaults to `sub`. |
| `TKL_IDENTITY_ROLES_CLAIM` | Roles claim name. Defaults to `roles`. |
| `TKL_IDENTITY_PERMISSIONS_CLAIM` | Permission/scope claim name. Defaults to `scp`. |
| `TKL_IDENTITY_PRODUCTS_CLAIM` | Product allowlist claim name. Defaults to `tkl_products`. |
| `TKL_IDENTITY_TENANT_CLAIM` | Tenant claim name. Defaults to `tid`. |
| `TKL_REQUIRE_TLS` | Must be `"true"` in production. |
| `TKL_SECRET__<PATH>` | Values injected by the deployment secret manager for `secret://` references, derived via `credentialReferenceEnvVarName`. |

## Usage

```js
import {
  createAuditSink,
  createConfiguredAuthenticator,
  createIdentityClaimsMapper,
  createIdentityVerifier,
  validateDeploymentEnvironment,
} from "../../../packages/ops/src/index.js";
import { createAuditLogger } from "../../../packages/observability/src/index.js";

const identityVerifier = createIdentityVerifier();
const mapClaims = createIdentityClaimsMapper();
const deploymentCheck = validateDeploymentEnvironment({ identityVerifier });
if (!deploymentCheck.ready) {
  for (const item of deploymentCheck.checklist) {
    if (item.status === "fail") console.error(`[startup] FAIL ${item.id}: ${item.detail}`);
  }
  throw new Error("Refusing to start: deployment validation checklist failed.");
}

const authenticator = createConfiguredAuthenticator({ verifyToken: identityVerifier, mapClaims });
const auditLogger = createAuditLogger({ sink: createAuditSink() });
```

`apps/api/src/server.js` and `apps/mcp-gateway/src/server.js` both wire this in
at startup.

## Out of scope / external decisions

This package does not embed a tenant-specific issuer, audience, application
registration, secret-manager product, or deployment target. The production
verifier is standards-based and ready for an approved OIDC provider such as Entra
ID, but the platform owner must supply the real values. Secret values remain the
responsibility of the deployment platform: inject them from the approved manager
(for example Azure Key Vault) into the derived `TKL_SECRET__*` variables without
writing them to source, arguments, or logs.

There is deliberately no permissive identity fallback. If issuer/audience
configuration is absent, `createIdentityVerifier()` returns `undefined` and the
production checklist fails. Partial configuration, unsupported algorithms,
untrusted keys, forged signatures, or invalid token claims fail closed.

The configured role, permission, product, and tenant claims must be application-managed
authorization claims, not self-service profile attributes or user-controlled group names.
`admin` is accepted only when the provider assigns it as an application role, and product
claims must contain explicit IDs: token-provided `"*"` access is rejected.
