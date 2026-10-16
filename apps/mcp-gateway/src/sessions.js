import { createHash, randomUUID } from "node:crypto";
import { JSON_RPC_ERROR_CODES, JsonRpcError } from "./protocol.js";

/**
 * MCP-103: bounded in-memory Streamable HTTP session storage.
 *
 * The gateway is a stateless-per-request service in front of the Application API, so a
 * session only carries transport state: the negotiated protocol revision, whether
 * `notifications/initialized` has arrived, and the fingerprint of the authorization
 * that created it. No knowledge, arguments, or credentials are retained.
 *
 * Storage is bounded three ways: total sessions, sessions per credential fingerprint,
 * and age (a short deadline for a session that never completes initialization, then an
 * idle timeout once it has). Expiry is evaluated lazily on each access with an
 * injectable clock, so there is no background timer and tests stay deterministic. A
 * single process instance is sufficient for the current single-process deployment; a
 * multi-instance deployment must place a shared store behind this same interface (see
 * `apps/mcp-gateway/README.md`).
 */

export const DEFAULT_MAX_SESSIONS = 256;
export const DEFAULT_MAX_SESSIONS_PER_CLIENT = 32;
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * A session that never completes `notifications/initialized` is abandoned quickly, so
 * initialize traffic alone cannot hold the bounded store at capacity.
 */
export const DEFAULT_UNINITIALIZED_TIMEOUT_MS = 60 * 1000;

/** Streamable HTTP requires session IDs to be visible ASCII (0x21-0x7E). */
const SESSION_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

/** Derives a non-reversible fingerprint so a session is bound to one credential. */
export function clientFingerprint(authorization) {
  if (typeof authorization !== "string" || authorization.length === 0) {
    throw new TypeError("An authorization value is required to fingerprint a session");
  }
  return createHash("sha256").update(authorization).digest("hex");
}

function missingSessionError() {
  return new JsonRpcError(
    JSON_RPC_ERROR_CODES.transport,
    "The Mcp-Session-Id header is required. Call initialize to start a session.",
    { status: 400 }
  );
}

function unknownSessionError() {
  return new JsonRpcError(
    JSON_RPC_ERROR_CODES.transport,
    "The MCP session is unknown, expired, or terminated. Call initialize to start a new session.",
    { status: 404 }
  );
}

export function createSessionStore({
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxSessionsPerClient = DEFAULT_MAX_SESSIONS_PER_CLIENT,
  idleTimeoutMs = DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  uninitializedTimeoutMs = DEFAULT_UNINITIALIZED_TIMEOUT_MS,
  now = () => Date.now(),
  createSessionId = () => randomUUID()
} = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new TypeError("maxSessions must be a positive integer");
  }
  if (!Number.isInteger(maxSessionsPerClient) || maxSessionsPerClient < 1) {
    throw new TypeError("maxSessionsPerClient must be a positive integer");
  }
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
    throw new TypeError("idleTimeoutMs must be a positive integer");
  }
  if (!Number.isInteger(uninitializedTimeoutMs) || uninitializedTimeoutMs < 1) {
    throw new TypeError("uninitializedTimeoutMs must be a positive integer");
  }

  const sessions = new Map();

  function pruneExpired(currentTime) {
    for (const [id, session] of sessions) {
      const idleExpired = currentTime - session.lastSeenAt >= idleTimeoutMs;
      const handshakeExpired =
        !session.initialized && currentTime - session.createdAt >= uninitializedTimeoutMs;
      if (idleExpired || handshakeExpired) {
        sessions.delete(id);
      }
    }
  }

  function lookup(sessionId, fingerprint) {
    if (sessionId === undefined) {
      throw missingSessionError();
    }
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new JsonRpcError(
        JSON_RPC_ERROR_CODES.transport,
        "The Mcp-Session-Id header is malformed.",
        { status: 400 }
      );
    }
    const currentTime = now();
    pruneExpired(currentTime);
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw unknownSessionError();
    }
    if (session.clientFingerprint !== fingerprint) {
      throw new JsonRpcError(
        JSON_RPC_ERROR_CODES.transport,
        "The MCP session is bound to a different authorization.",
        { status: 403 }
      );
    }
    session.lastSeenAt = currentTime;
    return session;
  }

  return {
    create({ protocolVersion, clientFingerprint: fingerprint }) {
      if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
        throw new TypeError("protocolVersion is required to create a session");
      }
      if (typeof fingerprint !== "string" || fingerprint.length === 0) {
        throw new TypeError("clientFingerprint is required to create a session");
      }
      const currentTime = now();
      pruneExpired(currentTime);
      if (sessions.size >= maxSessions) {
        throw new JsonRpcError(
          JSON_RPC_ERROR_CODES.transport,
          "The MCP gateway has reached its session capacity. Retry later.",
          { status: 503 }
        );
      }
      let sessionsForClient = 0;
      for (const session of sessions.values()) {
        if (session.clientFingerprint === fingerprint) {
          sessionsForClient += 1;
        }
      }
      if (sessionsForClient >= maxSessionsPerClient) {
        throw new JsonRpcError(
          JSON_RPC_ERROR_CODES.transport,
          "Too many concurrent MCP sessions for this credential. Terminate an existing session first.",
          { status: 429 }
        );
      }
      const id = createSessionId();
      if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) {
        throw new Error("createSessionId must return a visible-ASCII identifier");
      }
      if (sessions.has(id)) {
        throw new Error("createSessionId returned an identifier that is already in use");
      }
      const session = {
        id,
        protocolVersion,
        clientFingerprint: fingerprint,
        initialized: false,
        createdAt: currentTime,
        lastSeenAt: currentTime
      };
      sessions.set(id, session);
      return session;
    },

    require(sessionId, { clientFingerprint: fingerprint }) {
      return lookup(sessionId, fingerprint);
    },

    /** Marks the session initialized after `notifications/initialized` arrives. */
    markInitialized(sessionId, { clientFingerprint: fingerprint }) {
      const session = lookup(sessionId, fingerprint);
      session.initialized = true;
      return session;
    },

    terminate(sessionId, { clientFingerprint: fingerprint }) {
      const session = lookup(sessionId, fingerprint);
      sessions.delete(session.id);
      return session;
    },

    size() {
      pruneExpired(now());
      return sessions.size;
    }
  };
}
