# TKL Security Controls

This package contains boundary controls shared by the API and MCP HTTP servers:
restrictive response headers, JSON content-type enforcement, Bearer-header enforcement,
a 1 MiB MCP request limit, and a per-caller rate limiter.

`createRateLimiter({ limit, windowMs })` implements a fixed-window limiter keyed by an
arbitrary string (the API and MCP gateway both key on the authenticated `subject`). Callers
invoke `assertWithinLimit(key)` before performing work; once a caller exceeds `limit`
requests inside `windowMs`, it throws a `SecurityError` with status `429` and code
`rate_limit_exceeded`, including a `retryAfterMs` detail. Both `apps/api` and
`apps/mcp-gateway` enforce this after authorization succeeds, so unauthenticated requests
are rejected by identity checks first and never consume rate-limit budget.

These controls complement, rather than replace, the policy package. Identity verification
and product authorization remain provider-neutral in `packages/policy`; deployed identity
must use an approved provider such as Entra ID, and deployed traffic must use HTTPS/TLS.
