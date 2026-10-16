# TKL API and MCP Threat Model

## Scope

This model covers the Application API and MCP Gateway boundaries owned by the API, MCP,
and Security workstream. Source connectors, normalizers, storage, and dashboard
implementation remain separate components.

## Controls

| Threat | Control |
|---|---|
| Unauthenticated access | Bearer authentication is required for knowledge routes and MCP HTTP requests. |
| Cross-tenant or cross-product data access | Every knowledge request is checked against the API service's configured tenant and the subject's assigned products; missing or mismatched tenant identity fails closed. |
| Unauthorized capability use | Permissions are checked per capability: knowledge, coverage, traceability, and conflicts. |
| Prompt injection through source content | Source content is treated as untrusted data and is never executed as instructions by the gateway. |
| Generic tool abuse | MCP exposes only fixed read-only tools; no SQL, shell, filesystem, or arbitrary URL tools exist. |
| Write operations | API routes are GET-only and the MVP has no external write capability. |
| Oversized MCP requests | JSON payloads are limited to 1 MiB. |
| Malformed input | Shared contracts reject unknown fields, invalid IDs, invalid sources, and invalid limits. |
| Secret leakage | Audit fields are recursively redacted; credentials are not passed to agents or dashboards. |
| Browser/content-type abuse | JSON content type and restrictive response security headers are enforced at the MCP boundary. |
| Transport interception | Deployed traffic must use HTTPS/TLS 1.2 or 1.3; local HTTP is for development only. |
| MCP session hijacking | A Streamable HTTP session is bound to a SHA-256 fingerprint of the authorization that created it; presenting it with another credential is rejected with `403`, and `DELETE /mcp` terminates it. |
| Unbounded session state | Sessions are bounded by total count, per-credential count, idle age, and an initialization deadline; they hold no knowledge or credential material, and creation fails closed (`429`/`503`) instead of evicting live sessions. A per-credential transport rate limit applies before any session state is allocated. |
| Uninitialized or malformed protocol traffic | Capability methods require a negotiated, initialized session; JSON-RPC batches, malformed envelopes, unsupported protocol revisions, and mismatched `MCP-Protocol-Version` headers are rejected before any gateway work. |
| Authorization-server confusion | Protected-resource metadata publishes only configured issuer/resource values; partial or non-publishable configuration fails startup, and production refuses to start without it. The gateway never issues or verifies tokens itself. |
| Internal detail disclosure | Unmapped failures return a generic JSON-RPC `-32603` message; only authored gateway/API error messages and upstream `401`/`403` statuses are surfaced. |
| Response header injection | `WWW-Authenticate` is built from authored constants and validated configuration only; challenge values strip non-printable characters and escape quoting, so no upstream or caller text can split or extend a header. |
| Malformed request targets | The request path is parsed against a fixed base without trusting `Host`, and an unparseable target is answered `400` instead of throwing out of the request listener. |

## Residual production requirements

- Configure the approved OIDC identity platform, such as Entra ID, through
  `TKL_IDENTITY_ISSUER`, `TKL_IDENTITY_AUDIENCE`, and optional
  `TKL_IDENTITY_JWKS_URI`. `createIdentityVerifier` cryptographically verifies the
  RSA signature, algorithm, issuer, audience, expiry, not-before, and issued-at before
  claims reach `createIdentityAdapter`; the local static token resolver remains
  development-only. Claim names are explicit deployment configuration, and missing
  roles, permissions, or products never become default access.
- Resolve connector credentials only through validated `secret://` or `env://`
  references using `createCredentialReferenceResolver`; never pass credential values to
  API or MCP consumers.
- Connect the audit sink to approved observability infrastructure.
- Configure the MCP gateway's OAuth protected-resource metadata
  (`TKL_MCP_RESOURCE_URI`, `TKL_MCP_AUTHORIZATION_SERVERS`) with the approved
  authorization server. The gateway publishes configured values only; it is never an
  identity provider and performs no token verification of its own. Production startup
  fails closed while this is unset.
- Provide a shared session store or sticky routing before running more than one gateway
  instance; the bounded session store is per process by design.
- Use an approved secret manager such as Azure Key Vault.
- Deploy behind HTTPS/TLS; do not expose the development HTTP listener directly.
- Migrate the JavaScript scaffold to TypeScript or obtain Architecture review.
- Add integration and security tests against the deployed identity and transport configuration.
