# MCP Gateway Runbook

Covers the read-only MCP gateway (`apps/mcp-gateway`) and its Streamable HTTP transport
(`MCP-103`). The gateway never calls Jira, GitHub, or TestRail: every capability is
served by the TKL Application API.

## Configuration validation

Before starting the gateway, verify:

- `validateDeploymentEnvironment` reports `ready: true` (see `packages/ops/README.md`).
  Production additionally requires `TKL_IDENTITY_ISSUER` and
  `TKL_IDENTITY_AUDIENCE`; `createIdentityVerifier()` uses those values with OIDC
  discovery or `TKL_IDENTITY_JWKS_URI` and the gateway must not start without them.
- `TKL_API_URL` points at the approved Application API instance over HTTPS in deployed
  environments.
- `PORT` is an integer between 1 and 65535.
- OAuth protected-resource metadata is configured for any deployed environment:
  - `TKL_MCP_RESOURCE_URI` - canonical public URI of the MCP endpoint (HTTPS in
    production, no credentials, no fragment).
  - `TKL_MCP_AUTHORIZATION_SERVERS` - comma-separated approved issuer URL(s).
  - `TKL_MCP_SCOPES_SUPPORTED` and `TKL_MCP_RESOURCE_DOCUMENTATION` are optional.
  A partial configuration fails startup in every environment, and production fails
  closed when the metadata is absent entirely.

The gateway holds no source credential and resolves none. Never place a token, password,
or API key in any of the variables above.

## Health signals

Monitor:

- `GET /health` (unauthenticated): correlated `mcp-gateway` and `application-api`
  component status. `degraded` means the Application API health call failed.
- Audit events `mcp.tool` and `mcp.resource`: correlation ID, operation, product,
  outcome, status, duration. Authorization material, arguments, and resource contents are
  never recorded.
- Transport status mix: a rise in `400`/`404` session responses usually means clients are
  losing their session (restart, expiry, or an instance change), not an authorization
  problem.
- Session pressure: repeated `503` session-capacity or `429` per-credential session
  responses indicate the bounded store (256 total, 32 per credential, 30 minutes idle,
  60-second handshake deadline by default) is saturated or that clients are not
  terminating sessions.

## Common failures

| Symptom | Likely cause | Safe action |
|---|---|---|
| Startup fails with `Refusing to start: ... deployment validation checklist` | Missing production identity verifier, TLS flag, tenant, or audit destination | Fix the failing checklist item; do not bypass the check |
| Startup fails with `OAuth protected-resource metadata is not configured` | Production started without `TKL_MCP_RESOURCE_URI`/`TKL_MCP_AUTHORIZATION_SERVERS` | Configure the approved resource and issuer values |
| `404 oauth_metadata_not_configured` on `/.well-known/oauth-protected-resource` | Metadata deliberately unset outside production | Configure the values, or accept it for local development only |
| `401` with `WWW-Authenticate: Bearer ...` | Missing bearer token, or the Application API rejected the forwarded token | Client must re-authenticate with the advertised authorization server; never disable the check |
| `403` with `The MCP session is bound to a different authorization` | A session ID was reused with a different credential | Client must call `initialize` again after rotating its token |
| `404` with `session is unknown, expired, or terminated` | Idle timeout, gateway restart, or a different instance | Client must call `initialize` again; enable sticky routing or a shared session store for multi-instance deployments |
| `400` with `notifications/initialized` in the message | Client skipped the initialization notification | Fix the client lifecycle; the gateway must not serve capabilities before initialization |
| `400` with `Unsupported MCP-Protocol-Version` | Client sent a header the session did not negotiate | Client must send the version returned by `initialize` |
| `-32602` with `Unsupported MCP protocol version` | Client requested an unsupported revision | Upgrade the client; the supported list is in `error.data.supported` |
| `-32600` with `batch` | Client sent a JSON-RPC array | Send one message per request |
| `405` on `GET /mcp` | Client expects a server-initiated SSE stream | Expected: this gateway offers no GET stream |
| `415` / `406` | Wrong `Content-Type` or an `Accept` header that excludes JSON | Send `application/json` and accept it |
| `429` with `Retry-After` | Per-subject capability rate limit, or the transport's per-credential bound (240 requests/minute) | Client backs off; raise a limit only with security approval |
| `429` with `concurrent MCP sessions` | One credential holds too many sessions (32 by default) | Client must `DELETE /mcp` sessions it no longer uses |
| `503` session capacity | Bounded session store is full | Investigate client churn or leaked sessions before raising `maxSessions`; unauthenticated floods must be stopped at the network edge |
| `-32603` `The MCP request could not be completed.` | Unmapped internal failure | Correlate with the gateway/API audit log using the correlation ID; the message is intentionally generic |

## Recovery

1. Confirm the Application API is healthy first (`GET /health` on the API); a degraded
   `application-api` component explains most gateway failures.
2. For transport regressions, run
   `npm run test --workspace @tkl/mcp-gateway` and
   `node --experimental-strip-types --test tests/integration/mcp-103-transport.test.js`.
3. Restarting the gateway clears all in-memory sessions. Clients recover automatically by
   calling `initialize` again; no knowledge, evidence, or audit data is lost.
4. If OAuth metadata was wrong, correct the environment variables and restart; clients
   rediscover the authorization server from the `WWW-Authenticate` challenge.

## Safe rollback

Stop the gateway or route traffic away from it. The Application API, connectors, and
dashboard are unaffected, and no write capability exists to reverse. Preserve audit
events and correlation IDs for the investigation. Do not roll back by disabling
authentication, the session requirement, or the read-only allowlist.
