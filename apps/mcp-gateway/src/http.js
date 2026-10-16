import {
  assertBodySize,
  createRateLimiter,
  requireAuthorizationHeader,
  requireJsonContentType,
  securityHeaders,
  SecurityError
} from "../../../packages/security/src/index.js";
import { createCorrelationId } from "../../../packages/observability/src/index.js";
import {
  bearerChallenge,
  isProtectedResourceMetadataPath
} from "./oauth-metadata.js";
import {
  assertProtocolVersionHeader,
  createMcpProtocol,
  JSON_RPC_ERROR_CODES,
  JsonRpcError,
  jsonRpcErrorResponse,
  jsonRpcResult,
  parseJsonRpcMessage,
  toJsonRpcError
} from "./protocol.js";
import { clientFingerprint, createSessionStore } from "./sessions.js";

/**
 * MCP-103: Streamable HTTP transport for the read-only TKL MCP gateway.
 *
 * Lifecycle implemented here:
 *
 * 1. `POST /mcp` with `initialize` negotiates a protocol revision and returns a new
 *    `Mcp-Session-Id`.
 * 2. `POST /mcp` with `notifications/initialized` completes initialization and is
 *    answered with `202 Accepted` and no body, as JSON-RPC forbids responding to a
 *    notification.
 * 3. Every other capability request requires that initialized session, and is delegated
 *    to the existing gateway allowlist.
 * 4. `DELETE /mcp` terminates the session.
 *
 * The transport only adds protocol framing. Authentication forwarding, allowlisting,
 * validation, rate limiting, audit, and redaction stay exactly where they already were:
 * the security package, the gateway, and the Application API.
 *
 * Server-initiated SSE streams are deliberately not offered, so `GET /mcp` answers
 * `405` as the specification requires of a server without a GET stream.
 */

const MCP_SESSION_HEADER = "mcp-session-id";
const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Fixed challenge text. Upstream or caller-influenced strings must never be copied into
 * a response header, so the `WWW-Authenticate` description is authored here.
 */
const MISSING_CREDENTIAL_CHALLENGE = Object.freeze({});
const REJECTED_CREDENTIAL_CHALLENGE = Object.freeze({
  error: "invalid_token",
  errorDescription: "The presented credential was rejected."
});

/**
 * Transport-level abuse bound, applied per credential fingerprint before any session
 * state is allocated. It is deliberately looser than the gateway's per-subject
 * capability limit (60/minute), which still applies to every tool call and resource
 * read; this one exists so lifecycle traffic alone cannot exhaust session storage.
 */
const DEFAULT_TRANSPORT_RATE_LIMIT = 240;

function jsonHeaders(extra = {}) {
  return {
    ...securityHeaders(),
    "content-type": JSON_CONTENT_TYPE,
    "cache-control": "no-store",
    ...extra
  };
}

function writeJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, jsonHeaders(extraHeaders));
  response.end(JSON.stringify(body));
}

function writeEmpty(response, status, extraHeaders = {}) {
  response.writeHead(status, { ...securityHeaders(), ...extraHeaders });
  response.end();
}

function headerValue(headers, name) {
  const value = headers[name];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new JsonRpcError(
      JSON_RPC_ERROR_CODES.invalidRequest,
      `The ${name} header must be sent at most once.`,
      { status: 400 }
    );
  }
  return value;
}

/**
 * Streamable HTTP clients advertise `application/json, text/event-stream`. This gateway
 * always answers with JSON, so an `Accept` header that excludes JSON cannot be honored.
 */
function requireJsonAccept(accept) {
  if (accept === undefined) {
    return;
  }
  const accepted = accept
    .split(",")
    .map((entry) => entry.split(";")[0].trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (accepted.length === 0) {
    return;
  }
  if (accepted.includes("application/json") || accepted.includes("*/*") || accepted.includes("application/*")) {
    return;
  }
  throw new SecurityError(
    406,
    "not_acceptable",
    "MCP responses are sent as application/json; the Accept header must allow it."
  );
}

/**
 * Resolves the request path without trusting the `Host` header: only the path is used
 * for routing, and a malformed request target is an explicit client error rather than a
 * thrown `TypeError` inside the request listener.
 */
function parseRequestUrl(rawUrl) {
  try {
    return new URL(rawUrl ?? "/", "http://mcp-gateway.invalid");
  } catch {
    throw new JsonRpcError(
      JSON_RPC_ERROR_CODES.invalidRequest,
      "The request target is malformed.",
      { status: 400 }
    );
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assertBodySize(size);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    throw new JsonRpcError(
      JSON_RPC_ERROR_CODES.invalidRequest,
      "An MCP request body is required.",
      { status: 400 }
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new JsonRpcError(
      JSON_RPC_ERROR_CODES.parseError,
      "The MCP request body must be valid JSON.",
      { status: 400 }
    );
  }
}

export function createMcpRequestListener({
  gateway,
  sessionStore = createSessionStore(),
  protectedResourceMetadata,
  protocol,
  authenticateToken,
  rateLimiter = createRateLimiter({ limit: DEFAULT_TRANSPORT_RATE_LIMIT }),
  mcpPath = "/mcp",
  healthPath = "/health"
}) {
  if (!gateway || typeof gateway.handle !== "function") {
    throw new TypeError("A gateway exposing handle() is required");
  }
  const mcpProtocol = protocol ?? createMcpProtocol({ gateway });

  function unauthorizedHeaders({ error, errorDescription }) {
    return {
      "www-authenticate": bearerChallenge({
        metadata: protectedResourceMetadata,
        error,
        errorDescription
      })
    };
  }

  function writeJsonRpcFailure(response, requestId, error, { hadAuthorization = true } = {}) {
    const jsonRpcError = toJsonRpcError(error);
    const extraHeaders = {};
    if (jsonRpcError.status === 401) {
      Object.assign(
        extraHeaders,
        unauthorizedHeaders(
          hadAuthorization ? REJECTED_CREDENTIAL_CHALLENGE : MISSING_CREDENTIAL_CHALLENGE
        )
      );
    }
    if (jsonRpcError.status === 429 && Number.isInteger(jsonRpcError.data?.retryAfterMs)) {
      extraHeaders["retry-after"] = String(Math.ceil(jsonRpcError.data.retryAfterMs / 1000));
    }
    writeJson(
      response,
      jsonRpcError.status,
      jsonRpcErrorResponse(requestId, jsonRpcError),
      extraHeaders
    );
  }

  /**
   * Authenticates the transport envelope and bounds request volume per credential
   * before any session state is allocated.
   */
  async function authenticateTransport(request, state) {
    const authorization = headerValue(request.headers, "authorization");
    state.hadAuthorization = typeof authorization === "string" && authorization.length > 0;
    requireAuthorizationHeader(authorization);
    const authContext = authenticateToken
      ? await authenticateToken(authorization.slice("Bearer ".length))
      : undefined;
    const fingerprint = clientFingerprint(
      authContext
        ? `${authContext.tenantId ?? ""}:${authContext.subject}`
        : authorization,
    );
    rateLimiter.assertWithinLimit(fingerprint);
    return { authorization, fingerprint };
  }

  function handleMetadata(response) {
    if (protectedResourceMetadata === undefined) {
      writeJson(response, 404, {
        error: {
          code: "oauth_metadata_not_configured",
          message:
            "OAuth protected-resource metadata is not configured for this deployment."
        }
      });
      return;
    }
    writeJson(response, 200, protectedResourceMetadata);
  }

  async function handleDelete(request, response, state) {
    const { fingerprint } = await authenticateTransport(request, state);
    const sessionId = headerValue(request.headers, MCP_SESSION_HEADER);
    sessionStore.terminate(sessionId, { clientFingerprint: fingerprint });
    writeEmpty(response, 204);
  }

  async function handlePost(request, response, state) {
    const { authorization, fingerprint } = await authenticateTransport(request, state);
    requireJsonContentType(headerValue(request.headers, "content-type"));
    requireJsonAccept(headerValue(request.headers, "accept"));

    const correlationId = headerValue(request.headers, "x-correlation-id") ?? createCorrelationId();
    const protocolVersionHeader = headerValue(request.headers, MCP_PROTOCOL_VERSION_HEADER);
    const sessionId = headerValue(request.headers, MCP_SESSION_HEADER);

    const message = parseJsonRpcMessage(await readJsonBody(request));
    if (!message.isNotification) {
      state.requestId = message.id;
    }

    if (message.method === "initialize") {
      if (message.isNotification) {
        throw new JsonRpcError(
          JSON_RPC_ERROR_CODES.invalidRequest,
          "initialize must be sent as a JSON-RPC request with an id.",
          { status: 400 }
        );
      }
      if (sessionId !== undefined) {
        throw new JsonRpcError(
          JSON_RPC_ERROR_CODES.invalidRequest,
          "This MCP session is already initialized. Terminate it before initializing again.",
          { status: 400 }
        );
      }
      const result = mcpProtocol.initialize(message.params);
      const session = sessionStore.create({
        protocolVersion: result.protocolVersion,
        clientFingerprint: fingerprint
      });
      writeJson(response, 200, jsonRpcResult(message.id, result), {
        "mcp-session-id": session.id,
        "mcp-protocol-version": session.protocolVersion
      });
      return;
    }

    const session = sessionStore.require(sessionId, { clientFingerprint: fingerprint });
    assertProtocolVersionHeader(protocolVersionHeader, session.protocolVersion);

    if (message.isNotification) {
      if (message.method === "notifications/initialized") {
        sessionStore.markInitialized(session.id, { clientFingerprint: fingerprint });
      }
      // JSON-RPC forbids answering a notification, so every accepted notification -
      // including one this gateway does not act on - is acknowledged with 202 only.
      writeEmpty(response, 202, {
        "mcp-session-id": session.id,
        "mcp-protocol-version": session.protocolVersion
      });
      return;
    }

    if (!session.initialized && message.method !== "ping") {
      throw new JsonRpcError(
        JSON_RPC_ERROR_CODES.transport,
        "The MCP session is not initialized. Send the notifications/initialized notification first.",
        { status: 400 }
      );
    }

    const result = await mcpProtocol.dispatch(message.method, message.params, {
      authorization,
      correlationId,
      protocolVersion: session.protocolVersion
    });
    writeJson(response, 200, jsonRpcResult(message.id, result), {
      "mcp-session-id": session.id,
      "mcp-protocol-version": session.protocolVersion
    });
  }

  return async function requestListener(request, response) {
    const method = request.method ?? "GET";
    const state = { requestId: null, hadAuthorization: false };

    try {
      const url = parseRequestUrl(request.url);
      if (method === "GET" && url.pathname === healthPath) {
        writeJson(response, 200, await gateway.health());
        return;
      }
      if (method === "GET" && isProtectedResourceMetadataPath(url.pathname)) {
        handleMetadata(response);
        return;
      }
      if (url.pathname !== mcpPath) {
        writeJson(response, 404, {
          error: { code: "not_found", message: "MCP route not found." }
        });
        return;
      }
      if (method === "POST") {
        await handlePost(request, response, state);
        return;
      }
      if (method === "DELETE") {
        await handleDelete(request, response, state);
        return;
      }
      writeJson(
        response,
        405,
        {
          error: {
            code: "method_not_allowed",
            message:
              "This MCP endpoint accepts POST for JSON-RPC messages and DELETE for session "
              + "termination. Server-initiated SSE streams are not offered."
          }
        },
        { allow: "POST, DELETE" }
      );
    } catch (error) {
      try {
        writeJsonRpcFailure(response, state.requestId, error, {
          hadAuthorization: state.hadAuthorization
        });
      } catch {
        // Last-resort guard: a response that cannot be written must not escape this
        // listener as an unhandled rejection and terminate the gateway process.
        if (!response.headersSent) {
          response.writeHead(500, jsonHeaders());
        }
        response.end();
      }
    }
  };
}
