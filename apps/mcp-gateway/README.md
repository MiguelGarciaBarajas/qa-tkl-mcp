# TKL MCP Gateway

This package is the thin, read-only MCP boundary for TKL. It owns capability discovery,
input validation, and delegation to the TKL Application API. It must not import source
connectors, call Jira/GitHub directly, execute arbitrary SQL/shell/URL operations, or
expose write capabilities in the MVP.

Input and output contracts are defined in `packages/contracts`. The gateway validates
tool arguments before delegation, and its Application API client validates response
shapes before returning them to an MCP caller.

## Run

Start the Application API first, then run the gateway from the repository root:

```bash
npm run start --workspace @tkl/api
npm run start --workspace @tkl/mcp-gateway
```

The gateway accepts JSON requests at `POST http://localhost:3100/mcp`. Set `TKL_API_URL`
to point at another Application API instance.

Callers must provide an `Authorization: Bearer <token>` header. The gateway forwards
that header to the Application API; identity verification and product authorization
remain owned by the API policy layer.

The HTTP boundary requires `application/json`, limits request bodies to 1 MiB, and emits
restrictive security headers. Deployment traffic must use HTTPS/TLS; the local HTTP
listener is for development and smoke testing only.

Each tool call and resource read emits a structured audit event with a correlation ID,
operation, product, outcome, status, and duration. When the HTTP boundary has not yet
resolved an identity subject, an irreversible SHA-256 token fingerprint is used for
rate-limit and audit correlation. Authorization material and resource contents are not
included in events.

`GET /health` (unauthenticated, like the Application API's health route) returns a
correlated health report combining the gateway's own status with the Application API's
`/health` response when the injected `applicationClient` exposes a `health()` method.
This lets operators correlate connector, application, API, and MCP health/audit metrics
from one shared report shape (see `packages/observability`).

Supported JSON-RPC methods:

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`
- `resources/list` (always empty; this gateway publishes templates only)
- `resources/templates/list`
- `resources/read`

The five tools and product-scoped resource reads delegate to the corresponding
Application API capability. Resource reads require a `tkl://products/{productId}/...`
URI and preserve the API's product isolation boundary. In-process consumers must use
the scoped `createReadOnlyMcpProvider` adapter; the former unscoped `storyKey` provider
is no longer supported.

Only the five allowlisted tools and the four allowlisted resource templates (feature,
requirement, traceability, provenance) are reachable. Any unknown tool name, any MCP
method outside `tools/list`, `tools/call`, `resources/templates/list`, and
`resources/read` (including implied write operations), and any resource URI that does
not match a registered template are rejected before the Application API client is
invoked.

The tool schemas accept an optional registered `source` filter, including `testrail`.
The gateway only forwards that source identifier to the Application API; it does not
implement a TestRail connector.

## MCP transport (MCP-103)

`POST /mcp` speaks JSON-RPC 2.0 over Streamable HTTP.

| Concern | Behavior |
|---|---|
| Envelope | One JSON-RPC 2.0 object per request. Arrays (batches) are rejected with `-32600`: the `2025-06-18` revision removed batching, and a batch would let one authenticated request fan out into unbounded gateway work. |
| Errors | Standard codes: `-32700` parse, `-32600` invalid request, `-32601` unknown method, `-32602` invalid params/unknown tool, `-32603` internal, `-32002` resource not found, `-32000` transport/session/rate-limit. Unmapped internal failures return a generic message only. |
| Versions | `2025-06-18` (default), `2025-03-26`, `2024-11-05`. An unsupported `initialize` version is rejected with `-32602` and the supported list instead of being silently downgraded. |
| Capabilities | `tools.listChanged: false` and `resources.subscribe: false, listChanged: false`. No prompts, completions, sampling, logging, or subscriptions are declared or implemented. |
| Sessions | `initialize` returns `Mcp-Session-Id`. Every later request must present it, and `notifications/initialized` must arrive before any capability method (`ping` excepted). |
| Session binding | A session is bound to a SHA-256 fingerprint of the authorization that created it. Presenting it with a different credential returns `403`. |
| Session expiry | Sessions are bounded in memory (256 total, 32 per credential, 30 minutes idle, and a 60-second deadline to complete initialization) and expire lazily; an unknown, expired, or terminated session returns `404` so the client re-initializes. A credential over its session cap gets `429`, and total capacity exhaustion returns `503` rather than evicting a live session. |
| Termination | `DELETE /mcp` with a valid session returns `204`. |
| Streams | `GET /mcp` returns `405 Allow: POST, DELETE`; this gateway offers no server-initiated SSE stream. |
| Content types | `Content-Type: application/json` is required (`415` otherwise). An `Accept` header that excludes JSON returns `406`. Responses are always `application/json`. |
| Notifications | Answered with `202 Accepted` and no body, as JSON-RPC forbids responding to a notification. |
| Protocol header | `MCP-Protocol-Version` is validated against the version negotiated for the session; a mismatch returns `400`. |

Minimal lifecycle:

```bash
# 1. initialize (returns Mcp-Session-Id)
curl -i -X POST http://localhost:3100/mcp \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"analyst","version":"1.0.0"}}}'

# 2. complete initialization (202, no body)
curl -i -X POST http://localhost:3100/mcp \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -H 'mcp-session-id: <session>' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. call a read-only capability
curl -s -X POST http://localhost:3100/mcp \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -H 'mcp-session-id: <session>' -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 4. terminate the session
curl -i -X DELETE http://localhost:3100/mcp \
  -H 'authorization: Bearer <token>' -H 'mcp-session-id: <session>'
```

Transport framing is the only thing this layer adds. Authentication forwarding,
allowlisting, argument validation, rate limiting (`429` with `Retry-After`), audit, and
redaction remain exactly where they already were: `packages/security`, `gateway.js`, and
the Application API. The internal `gateway.handle(request, requestContext)` contract is
unchanged and still used by in-process consumers and integration tests.

The transport additionally applies its own per-credential fixed-window bound (240
requests/minute by default) before allocating session state, because `initialize` is
answered by the gateway itself and therefore never reaches the gateway's per-subject
capability limiter. Unauthenticated flood protection at the network edge is still
required: the gateway verifies no token itself and cannot distinguish a well-formed
bearer header from a valid one.

The session store is per process, which matches the current single-process deployment. A
multi-instance deployment must place a shared store behind the same
`createSessionStore()` interface, or terminate sessions with sticky routing.

## OAuth protected-resource metadata

The gateway is an OAuth 2.0 *resource server* only. It never issues, verifies, or
introspects tokens itself and never stands up a local identity provider: verification
stays with the Application API policy layer and the verifier wired through
`packages/ops/src/identity-provider.js`.

`GET /.well-known/oauth-protected-resource` (and the RFC 9728 resource-path variant
`/.well-known/oauth-protected-resource/mcp`) publishes only configured values:

| Variable | Purpose |
|---|---|
| `TKL_MCP_RESOURCE_URI` | Canonical public URI of this MCP endpoint, e.g. `https://tkl.example.com/mcp`. |
| `TKL_MCP_AUTHORIZATION_SERVERS` | Comma-separated issuer URLs of the approved authorization server(s). |
| `TKL_MCP_SCOPES_SUPPORTED` | Optional comma-separated scopes advertised to clients. |
| `TKL_MCP_RESOURCE_DOCUMENTATION` | Optional documentation URL. |

Configuration is all-or-nothing. A partial or non-publishable value (relative URL,
non-HTTPS in production, embedded credentials, URL fragment) fails at startup in every
environment, and a production process refuses to start when no metadata is configured at
all. Outside production the route answers `404 oauth_metadata_not_configured` instead of
inventing an issuer. Unauthenticated requests receive
`WWW-Authenticate: Bearer realm="tkl-mcp", ... resource_metadata="..."`, with the
`resource_metadata` pointer present only when metadata is configured.

The approved authorization server remains an external decision (see the "External
Decisions Register" in `docs/team/TKL-Delivery-Backlog.md`).
