# Production Deployment and Identity Readiness

This runbook covers the `OPS-102` startup controls shared by the Application API and MCP
gateway. It contains configuration names only; never copy a credential value into this
document, source control, a command argument, or a ticket.

## Required decisions

The platform owner supplies:

- the approved OIDC issuer and API audience;
- either an OIDC discovery endpoint exposed by that issuer or an explicit JWKS URI;
- claim names for subject, roles, permissions/scopes, product access, and tenant;
- the deployment secret manager and its environment-injection mechanism;
- the public HTTPS endpoints and TLS termination;
- the log collector receiving newline-delimited audit JSON from stdout.

The implementation is provider-neutral and works with standards-compliant OIDC/JWKS
providers, including Entra ID. No tenant-specific identifier is committed to the
repository.

## Production configuration

Set these through the deployment platform:

```text
NODE_ENV=production
TKL_TENANT_ID=<approved-tenant>
TKL_PRODUCT_ID=fl-titling
TKL_AUDIT_DESTINATION=stdout
TKL_REQUIRE_TLS=true
TKL_IDENTITY_PROVIDER=<approved-provider-label>
TKL_IDENTITY_ISSUER=<exact-https-token-issuer>
TKL_IDENTITY_AUDIENCE=<approved-api-audience>
```

Optional identity controls:

```text
TKL_IDENTITY_JWKS_URI=<explicit-https-jwks-uri>
TKL_IDENTITY_ALLOWED_ALGORITHMS=RS256
TKL_IDENTITY_JWKS_CACHE_TTL_SECONDS=300
TKL_IDENTITY_JWKS_REFRESH_COOLDOWN_SECONDS=30
TKL_IDENTITY_CLOCK_TOLERANCE_SECONDS=60
TKL_IDENTITY_SUBJECT_CLAIM=sub
TKL_IDENTITY_ROLES_CLAIM=roles
TKL_IDENTITY_PERMISSIONS_CLAIM=scp
TKL_IDENTITY_PRODUCTS_CLAIM=tkl_products
TKL_IDENTITY_TENANT_CLAIM=tid
```

If `TKL_IDENTITY_JWKS_URI` is omitted, the verifier reads
`<issuer>/.well-known/openid-configuration`, requires the returned issuer to match
exactly, and uses its HTTPS `jwks_uri`.

Tokens must contain a `kid` protected-header value matching exactly one RSA signing key.
Role, permission, product, and tenant claims must be assigned by the application
registration or another administrator-controlled policy. Do not map user-editable
attributes or self-service group names. Product claims must list explicit product IDs;
the verifier rejects token-provided wildcard access.

The MCP gateway additionally requires `TKL_MCP_RESOURCE_URI` and
`TKL_MCP_AUTHORIZATION_SERVERS`; follow [the MCP gateway runbook](mcp-gateway.md).
The advertised authorization server must issue tokens whose exact issuer and audience
match `TKL_IDENTITY_ISSUER` and `TKL_IDENTITY_AUDIENCE`.

For each enabled connector credential reference, inject the derived variable through the
approved secret manager. For example, `secret://github/fl-titling` maps to:

```text
TKL_SECRET__GITHUB__FL_TITLING
```

The variable's value is intentionally absent from repository configuration.

## Readiness procedure

1. Confirm the application registration issues access tokens for the configured audience.
2. Confirm tokens carry a subject and the approved role, permission, product, and tenant
   claims. Missing authorization claims produce no access.
3. Start the API and MCP gateway with the production environment.
4. Require every `validateDeploymentEnvironment` checklist item to report `pass`.
5. Verify `/health` through the public HTTPS endpoint.
6. Call one read-only endpoint with a valid token and expect success.
7. Repeat with a forged signature, wrong audience, expired token, another tenant, and an
   unauthorized product; each request must fail without returning internal details.
8. Confirm audit JSON reaches the approved collector and contains no bearer token,
   connector credential, raw source payload, or secret-manager reference value.

## Failure and recovery

| Symptom | Cause | Safe response |
|---|---|---|
| `identity_verifier` fails at startup | Issuer/audience configuration is absent | Configure the approved values; never enable the development token map |
| Metadata retrieval fails | Issuer discovery or JWKS endpoint is unavailable | Restore provider connectivity; do not bypass signature verification |
| Every token returns `401` | Issuer, audience, algorithm, key ID, or token lifetime does not match | Compare the provider registration with the configured non-secret values |
| Valid subject receives `403` | Required permission, product, or tenant claim is absent/mismatched | Correct the provider claim assignment; do not grant a default wildcard |
| `secret_resolution` fails | An enabled connector's injected secret variable is absent | Repair the deployment secret injection and restart |
| Audit destination fails policy | Production is not configured for stdout collection | Restore the approved log collector before accepting traffic |

## Rollback

Roll back the deployment image and configuration together. Do not restore
`TKL_AUTH_TOKENS`, accept unsigned tokens, disable issuer/audience validation, or commit a
credential as an emergency workaround. If the identity provider is unavailable, keep the
service unavailable until verification can fail closed correctly.
