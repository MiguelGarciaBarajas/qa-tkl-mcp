# TKL Policy

This package provides provider-neutral authentication and authorization primitives for
the API and MCP gateway. A verified auth context contains a subject, roles, permissions,
and the product IDs the subject may access.

The API requires a Bearer token for knowledge routes. The server composition root uses
`TKL_AUTH_TOKENS` only as a local development resolver; production deployments must
replace it with an injected identity adapter created by `createIdentityAdapter`.
The Technology Usage Facet requires an approved identity platform, such as Entra ID,
for deployed authentication.

Credential integrations must use `createCredentialReferenceResolver` with validated
`secret://` or `env://` references. Credential values stay inside the resolver boundary
and are not part of API or MCP response contracts.

Example local configuration:

```powershell
$env:TKL_AUTH_TOKENS = '{"reader-token":{"subject":"carlos","roles":["reader"],"permissions":["knowledge:read","ask:read","coverage:read","traceability:read","conflicts:read"],"productIds":["fl-titling"]},"reviewer-token":{"subject":"dana","roles":["reader"],"permissions":["knowledge:read","ask:read","coverage:read","traceability:read","conflicts:read","conflicts:review"],"productIds":["fl-titling"]}}'
```

Permission strings are freeform and matched exactly against the auth context's
`permissions` array (an `admin` role bypasses the check). `conflicts:review` is required
for the API's `POST /v1/knowledge/conflicts/review` route — the only write route in the
API — and should only be granted to subjects trusted to record human review decisions on
knowledge conflicts.
