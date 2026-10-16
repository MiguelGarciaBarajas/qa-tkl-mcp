import test from "node:test";
import assert from "node:assert/strict";
import {
  clientFingerprint,
  createSessionStore,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS
} from "../src/sessions.js";

const AGENT_FINGERPRINT = clientFingerprint("Bearer agent-token");
const OTHER_FINGERPRINT = clientFingerprint("Bearer other-token");

function makeStore(overrides = {}) {
  let currentTime = 1_000;
  let sequence = 0;
  const store = createSessionStore({
    now: () => currentTime,
    createSessionId: () => `session-${++sequence}`,
    ...overrides
  });
  return {
    store,
    advance(ms) {
      currentTime += ms;
    }
  };
}

test("derives a non-reversible fingerprint from the authorization header", () => {
  const fingerprint = clientFingerprint("Bearer private-token");

  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint.includes("private-token"), false);
  assert.throws(() => clientFingerprint(undefined), TypeError);
});

test("creates a session that starts uninitialized and bound to one authorization", () => {
  const { store } = makeStore();

  const session = store.create({
    protocolVersion: "2025-06-18",
    clientFingerprint: AGENT_FINGERPRINT
  });

  assert.equal(session.id, "session-1");
  assert.equal(session.initialized, false);
  assert.equal(session.protocolVersion, "2025-06-18");
  assert.equal(store.size(), 1);
});

test("requires a session id and rejects malformed or unknown identifiers", () => {
  const { store } = makeStore();

  assert.throws(
    () => store.require(undefined, { clientFingerprint: AGENT_FINGERPRINT }),
    (error) => error.status === 400 && /Mcp-Session-Id header is required/.test(error.message)
  );
  assert.throws(
    () => store.require("has space", { clientFingerprint: AGENT_FINGERPRINT }),
    (error) => error.status === 400 && /malformed/.test(error.message)
  );
  assert.throws(
    () => store.require("session-404", { clientFingerprint: AGENT_FINGERPRINT }),
    (error) => error.status === 404
  );
});

test("rejects a session presented with a different authorization", () => {
  const { store } = makeStore();
  const session = store.create({
    protocolVersion: "2025-06-18",
    clientFingerprint: AGENT_FINGERPRINT
  });

  assert.throws(
    () => store.require(session.id, { clientFingerprint: OTHER_FINGERPRINT }),
    (error) => error.status === 403 && /different authorization/.test(error.message)
  );
});

test("marks a session initialized only after the initialized notification", () => {
  const { store } = makeStore();
  const session = store.create({
    protocolVersion: "2025-06-18",
    clientFingerprint: AGENT_FINGERPRINT
  });

  assert.equal(store.require(session.id, { clientFingerprint: AGENT_FINGERPRINT }).initialized, false);
  store.markInitialized(session.id, { clientFingerprint: AGENT_FINGERPRINT });
  assert.equal(store.require(session.id, { clientFingerprint: AGENT_FINGERPRINT }).initialized, true);
});

test("expires an idle session and refreshes the idle window on each use", () => {
  const { store, advance } = makeStore({ idleTimeoutMs: 1_000 });
  const first = store.create({ protocolVersion: "2025-06-18", clientFingerprint: AGENT_FINGERPRINT });

  advance(600);
  store.require(first.id, { clientFingerprint: AGENT_FINGERPRINT });
  advance(600);
  assert.equal(store.require(first.id, { clientFingerprint: AGENT_FINGERPRINT }).id, first.id);

  advance(1_000);
  assert.throws(
    () => store.require(first.id, { clientFingerprint: AGENT_FINGERPRINT }),
    (error) => error.status === 404
  );
  assert.equal(store.size(), 0);
});

test("terminates a session so the identifier can no longer be used", () => {
  const { store } = makeStore();
  const session = store.create({ protocolVersion: "2025-06-18", clientFingerprint: AGENT_FINGERPRINT });

  store.terminate(session.id, { clientFingerprint: AGENT_FINGERPRINT });

  assert.equal(store.size(), 0);
  assert.throws(
    () => store.require(session.id, { clientFingerprint: AGENT_FINGERPRINT }),
    (error) => error.status === 404
  );
  assert.throws(
    () => store.terminate(session.id, { clientFingerprint: AGENT_FINGERPRINT }),
    (error) => error.status === 404
  );
});

test("bounds session storage and fails closed instead of evicting live sessions", () => {
  const { store } = makeStore({ maxSessions: 2 });
  store.create({ protocolVersion: "2025-06-18", clientFingerprint: AGENT_FINGERPRINT });
  store.create({ protocolVersion: "2025-06-18", clientFingerprint: AGENT_FINGERPRINT });

  assert.throws(
    () => store.create({ protocolVersion: "2025-06-18", clientFingerprint: AGENT_FINGERPRINT }),
    (error) => error.status === 503 && /session capacity/.test(error.message)
  );
  assert.equal(store.size(), 2);
});

test("bounds concurrent sessions per credential", () => {
  const { store } = makeStore({ maxSessionsPerClient: 2 });
  store.create({ protocolVersion: "2025-06-18", clientFingerprint: AGENT_FINGERPRINT });
  store.create({ protocolVersion: "2025-06-18", clientFingerprint: AGENT_FINGERPRINT });

  assert.throws(
    () => store.create({ protocolVersion: "2025-06-18", clientFingerprint: AGENT_FINGERPRINT }),
    (error) => error.status === 429 && /concurrent MCP sessions/.test(error.message)
  );
  assert.equal(
    store.create({ protocolVersion: "2025-06-18", clientFingerprint: OTHER_FINGERPRINT }).id,
    "session-3"
  );
});

test("abandons a session that never completes initialization", () => {
  const { store, advance } = makeStore({
    idleTimeoutMs: 10_000,
    uninitializedTimeoutMs: 1_000
  });
  const uninitialized = store.create({
    protocolVersion: "2025-06-18",
    clientFingerprint: AGENT_FINGERPRINT
  });
  const initialized = store.create({
    protocolVersion: "2025-06-18",
    clientFingerprint: AGENT_FINGERPRINT
  });
  store.markInitialized(initialized.id, { clientFingerprint: AGENT_FINGERPRINT });

  advance(1_000);

  assert.throws(
    () => store.require(uninitialized.id, { clientFingerprint: AGENT_FINGERPRINT }),
    (error) => error.status === 404
  );
  assert.equal(
    store.require(initialized.id, { clientFingerprint: AGENT_FINGERPRINT }).id,
    initialized.id
  );
});

test("reclaims capacity from expired sessions before rejecting a new one", () => {
  const { store, advance } = makeStore({ maxSessions: 1, idleTimeoutMs: 1_000 });
  store.create({ protocolVersion: "2025-06-18", clientFingerprint: AGENT_FINGERPRINT });

  advance(1_000);
  const replacement = store.create({
    protocolVersion: "2025-06-18",
    clientFingerprint: AGENT_FINGERPRINT
  });

  assert.equal(replacement.id, "session-2");
  assert.equal(store.size(), 1);
});

test("validates store configuration and generated identifiers explicitly", () => {
  assert.throws(() => createSessionStore({ maxSessions: 0 }), TypeError);
  assert.throws(() => createSessionStore({ maxSessionsPerClient: 0 }), TypeError);
  assert.throws(() => createSessionStore({ idleTimeoutMs: 0 }), TypeError);
  assert.throws(() => createSessionStore({ uninitializedTimeoutMs: 0 }), TypeError);
  assert.throws(
    () =>
      createSessionStore({ createSessionId: () => "not visible ascii" }).create({
        protocolVersion: "2025-06-18",
        clientFingerprint: AGENT_FINGERPRINT
      }),
    /visible-ASCII/
  );
  assert.throws(
    () =>
      createSessionStore({}).create({ protocolVersion: "", clientFingerprint: AGENT_FINGERPRINT }),
    TypeError
  );
});

test("uses a bounded default idle timeout", () => {
  assert.equal(DEFAULT_SESSION_IDLE_TIMEOUT_MS, 30 * 60 * 1000);
});