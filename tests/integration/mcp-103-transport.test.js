import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createApplication } from "../../apps/api/src/app.js";
import {
  createApplicationApiClient,
  createGateway,
  createMcpRequestListener,
  createSessionStore,
  LATEST_PROTOCOL_VERSION,
  loadProtectedResourceMetadata,
  SUPPORTED_PROTOCOL_VERSIONS
} from "../../apps/mcp-gateway/src/index.js";
import { SecurityError } from "../../packages/security/src/index.js";

/**
 * MCP-103 transport conformance: drives the deployed Streamable HTTP surface end to end
 * (JSON-RPC framing, initialization, capability negotiation, session lifecycle, OAuth
 * protected-resource metadata) against the real gateway and the real Application API.
 *
 * Every capability response in this file is produced by `apps/api/src/app.js` through
 * the gateway's Application API client, so the transport can never be proven "working"
 * by a shortcut that bypasses authorization, validation, or the read-only allowlist.
 */

const TENANT_ID = "solera";
const PRODUCT_ID = "fl-titling";
const AUTHORIZATION = "Bearer mcp-103-analyst-token";
const OTHER_AUTHORIZATION = "Bearer mcp-103-other-token";
const RESOURCE_URI = `tkl://products/${PRODUCT_ID}/features/feature-titling-transfer`;

const AUTH_CONTEXT = {
  subject: "coverage-analyst",
  roles: ["reader"],
  permissions: ["knowledge:read", "coverage:read", "traceability:read", "conflicts:read"],
  productIds: [PRODUCT_ID],
  tenantId: TENANT_ID
};

const OAUTH_ENV = {
  TKL_MCP_RESOURCE_URI: "https://tkl.example.com/mcp",
  TKL_MCP_AUTHORIZATION_SERVERS: "https://login.example.com/tkl",
  TKL_MCP_SCOPES_SUPPORTED: "tkl.knowledge.read",
  TKL_SECRET__TESTRAIL__FL_TITLING: "never-publish-this-value"
};

const silentAuditLogger = { async record() {} };

function fixtureKnowledgeService() {
  return {
    tenantId: TENANT_ID,
    async listKnowledgeConflicts({ productId }) {
      return { productId, conflicts: [], provenance: [] };
    },
    async getStoryTestContext({ productId, storyId }) {
      return {
        productId,
        storyId,
        requirements: [{ id: "REQ-1", title: "Title transfer validation" }],
        tests: [{ id: "TC-1", type: "manual" }],
        defects: [],
        provenance: [{ source: "testrail", sourceId: "1202", retrievedAt: "2026-09-01T00:00:00.000Z" }]
      };
    },
    async readResource({ productId, uri }) {
      return {
        productId,
        uri,
        contents: [{ type: "text", text: "approved feature knowledge" }]
      };
    }
  };
}

function applicationFetch(application) {
  return async (input, options = {}) => {
    const url = input instanceof URL ? input : new URL(input);
    const response = await application.handle({
      method: options.method ?? "GET",
      pathname: url.pathname,
      url,
      authContext: options.headers?.authorization === AUTHORIZATION ? AUTH_CONTEXT : undefined,
      correlationId: "mcp-103-api"
    });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: response.headers
    });
  };
}

async function startTransport({
  sessionStore,
  protectedResourceMetadata,
  rateLimiter,
  transportRateLimiter
} = {}) {
  const application = createApplication({
    knowledgeService: fixtureKnowledgeService(),
    auditLogger: silentAuditLogger
  });
  const gateway = createGateway({
    applicationClient: createApplicationApiClient({
      baseUrl: "http://tkl-api.example.test",
      fetchImplementation: applicationFetch(application)
    }),
    auditLogger: silentAuditLogger,
    ...(rateLimiter === undefined ? {} : { rateLimiter })
  });
  const server = createServer(
    createMcpRequestListener({
      gateway,
      sessionStore: sessionStore ?? createSessionStore(),
      protectedResourceMetadata,
      ...(transportRateLimiter === undefined ? {} : { rateLimiter: transportRateLimiter })
    })
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    async post(body, { headers = {}, rawBody } = {}) {
      return fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: AUTHORIZATION,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers
        },
        body: rawBody ?? JSON.stringify(body)
      });
    },
    async request(method, path, headers = {}) {
      return fetch(`${baseUrl}${path}`, { method, headers });
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

async function initializeSession(transport, { headers } = {}) {
  const response = await transport.post(
    {
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "coverage-analyst", version: "1.0.0" }
      }
    },
    { headers }
  );
  const body = await response.json();
  const sessionId = response.headers.get("mcp-session-id");
  const initialized = await transport.post(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { headers: { ...headers, "mcp-session-id": sessionId } }
  );
  return { response, body, sessionId, initialized };
}

test("MCP-103 initializes, negotiates capabilities, and issues a Streamable HTTP session", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());

  const { response, body, sessionId, initialized } = await initializeSession(transport);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, "init-1");
  assert.equal(body.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.deepEqual(body.result.capabilities, {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false }
  });
  assert.equal(body.result.serverInfo.name, "tkl-mcp-gateway");
  assert.equal(typeof sessionId, "string");
  assert.equal(sessionId.length > 0, true);

  assert.equal(initialized.status, 202);
  assert.equal(await initialized.text(), "");
});

test("MCP-103 rejects an unsupported protocol version and reports the supported list", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());

  const response = await transport.post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2020-01-01", capabilities: {} }
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.error.code, -32602);
  assert.deepEqual(body.error.data.supported, [...SUPPORTED_PROTOCOL_VERSIONS]);
  assert.equal(response.headers.get("mcp-session-id"), null);
});

test("MCP-103 denies capability methods before initialization completes", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());

  const withoutSession = await transport.post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const withoutSessionBody = await withoutSession.json();
  assert.equal(withoutSession.status, 400);
  assert.equal(withoutSessionBody.error.code, -32000);
  assert.match(withoutSessionBody.error.message, /Mcp-Session-Id header is required/);

  const initialize = await transport.post({
    jsonrpc: "2.0",
    id: "init-1",
    method: "initialize",
    params: { protocolVersion: LATEST_PROTOCOL_VERSION }
  });
  const sessionId = initialize.headers.get("mcp-session-id");

  const beforeNotification = await transport.post(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { headers: { "mcp-session-id": sessionId } }
  );
  const beforeNotificationBody = await beforeNotification.json();
  assert.equal(beforeNotification.status, 400);
  assert.match(beforeNotificationBody.error.message, /notifications\/initialized/);

  await transport.post(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { headers: { "mcp-session-id": sessionId } }
  );
  const afterNotification = await transport.post(
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    { headers: { "mcp-session-id": sessionId } }
  );
  assert.equal(afterNotification.status, 200);
  assert.equal((await afterNotification.json()).result.tools.length, 5);
});

test("MCP-103 rejects a second initialize on an existing session", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());
  const { sessionId } = await initializeSession(transport);

  const response = await transport.post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION }
    },
    { headers: { "mcp-session-id": sessionId } }
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, -32600);
});

test("MCP-103 serves read-only tool calls and resource reads through the Application API", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());
  const { sessionId } = await initializeSession(transport);
  const headers = { "mcp-session-id": sessionId, "mcp-protocol-version": LATEST_PROTOCOL_VERSION };

  const toolCall = await transport.post(
    {
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: {
        name: "get_story_test_context",
        arguments: { productId: PRODUCT_ID, storyId: "STT-3731" }
      }
    },
    { headers }
  );
  const toolBody = await toolCall.json();
  assert.equal(toolCall.status, 200);
  assert.equal(toolBody.result.isError, false);
  assert.equal(toolBody.result.structuredContent.storyId, "STT-3731");
  assert.equal(toolBody.result.structuredContent.requirements[0].id, "REQ-1");

  const templates = await transport.post(
    { jsonrpc: "2.0", id: "templates-1", method: "resources/templates/list" },
    { headers }
  );
  assert.deepEqual(
    (await templates.json()).result.resourceTemplates.map((template) => template.name),
    ["feature", "requirement", "traceability", "provenance"]
  );

  const resourceRead = await transport.post(
    { jsonrpc: "2.0", id: "read-1", method: "resources/read", params: { uri: RESOURCE_URI } },
    { headers }
  );
  const resourceBody = await resourceRead.json();
  assert.equal(resourceRead.status, 200);
  assert.equal(resourceBody.result.structuredContent.uri, RESOURCE_URI);
  assert.equal(
    resourceBody.result.structuredContent.contents[0].text,
    "approved feature knowledge"
  );

  const ping = await transport.post({ jsonrpc: "2.0", id: "ping-1", method: "ping" }, { headers });
  assert.deepEqual((await ping.json()).result, {});
});

test("MCP-103 keeps denying write and unknown methods over the transport", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());
  const { sessionId } = await initializeSession(transport);
  const headers = { "mcp-session-id": sessionId };

  const writeMethod = await transport.post(
    { jsonrpc: "2.0", id: 1, method: "resources/write", params: { uri: RESOURCE_URI } },
    { headers }
  );
  assert.equal((await writeMethod.json()).error.code, -32601);

  const unknownTool = await transport.post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "delete_knowledge_entity", arguments: { productId: PRODUCT_ID } }
    },
    { headers }
  );
  assert.equal((await unknownTool.json()).error.code, -32602);

  const outOfScopeResource = await transport.post(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: `tkl://products/${PRODUCT_ID}/admin/settings` }
    },
    { headers }
  );
  assert.equal((await outOfScopeResource.json()).error.code, -32002);

  const undeclaredArgument = await transport.post(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "list_knowledge_conflicts",
        arguments: { productId: PRODUCT_ID, token: "secret" }
      }
    },
    { headers }
  );
  assert.equal((await undeclaredArgument.json()).error.code, -32602);
});

test("MCP-103 rejects an unknown session, a foreign authorization, and a terminated session", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());
  const { sessionId } = await initializeSession(transport);

  const unknownSession = await transport.post(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { "mcp-session-id": "00000000-0000-4000-8000-000000000000" } }
  );
  assert.equal(unknownSession.status, 404);
  assert.equal((await unknownSession.json()).error.code, -32000);

  const malformedSession = await transport.post(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { headers: { "mcp-session-id": "not a session id" } }
  );
  assert.equal(malformedSession.status, 400);

  const foreignToken = await transport.post(
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    { headers: { "mcp-session-id": sessionId, authorization: OTHER_AUTHORIZATION } }
  );
  assert.equal(foreignToken.status, 403);
  assert.match((await foreignToken.json()).error.message, /different authorization/);

  const mismatchedProtocol = await transport.post(
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
    { headers: { "mcp-session-id": sessionId, "mcp-protocol-version": "2024-11-05" } }
  );
  assert.equal(mismatchedProtocol.status, 400);
  assert.equal((await mismatchedProtocol.json()).error.data.negotiated, LATEST_PROTOCOL_VERSION);

  const terminated = await transport.request("DELETE", "/mcp", {
    authorization: AUTHORIZATION,
    "mcp-session-id": sessionId
  });
  assert.equal(terminated.status, 204);

  const afterTermination = await transport.post(
    { jsonrpc: "2.0", id: 5, method: "tools/list" },
    { headers: { "mcp-session-id": sessionId } }
  );
  assert.equal(afterTermination.status, 404);
});

test("MCP-103 expires an idle session and requires re-initialization", async (t) => {
  let currentTime = 10_000;
  const sessionStore = createSessionStore({
    idleTimeoutMs: 1_000,
    now: () => currentTime
  });
  const transport = await startTransport({ sessionStore });
  t.after(() => transport.close());
  const { sessionId } = await initializeSession(transport);

  currentTime += 1_000;

  const expired = await transport.post(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { "mcp-session-id": sessionId } }
  );
  assert.equal(expired.status, 404);
  assert.match((await expired.json()).error.message, /expired/);

  const reinitialized = await initializeSession(transport);
  assert.notEqual(reinitialized.sessionId, sessionId);
  const afterReinitialize = await transport.post(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { headers: { "mcp-session-id": reinitialized.sessionId } }
  );
  assert.equal(afterReinitialize.status, 200);
});

test("MCP-103 enforces JSON-RPC framing, batch policy, and content negotiation", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());
  const { sessionId } = await initializeSession(transport);
  const headers = { "mcp-session-id": sessionId };

  const malformedJson = await transport.post(undefined, { headers, rawBody: "{ not json" });
  assert.equal(malformedJson.status, 400);
  assert.equal((await malformedJson.json()).error.code, -32700);

  const emptyBody = await transport.post(undefined, { headers, rawBody: "" });
  assert.equal(emptyBody.status, 400);
  assert.equal((await emptyBody.json()).error.code, -32600);

  const missingVersion = await transport.post({ id: 1, method: "tools/list" }, { headers });
  assert.equal(missingVersion.status, 400);
  assert.equal((await missingVersion.json()).error.code, -32600);

  const batch = await transport.post(
    [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "resources/templates/list" }
    ],
    { headers }
  );
  const batchBody = await batch.json();
  assert.equal(batch.status, 400);
  assert.equal(batchBody.error.code, -32600);
  assert.match(batchBody.error.message, /batch/i);

  const wrongContentType = await transport.post(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { ...headers, "content-type": "text/plain" } }
  );
  assert.equal(wrongContentType.status, 415);

  const unacceptable = await transport.post(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { ...headers, accept: "text/html" } }
  );
  assert.equal(unacceptable.status, 406);

  const jsonOnlyAccept = await transport.post(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { headers: { ...headers, accept: "application/json" } }
  );
  assert.equal(jsonOnlyAccept.status, 200);
});

test("MCP-103 answers GET /mcp with 405 because no server-initiated stream is offered", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());

  const response = await transport.request("GET", "/mcp", { authorization: AUTHORIZATION });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST, DELETE");
  assert.equal((await response.json()).error.code, "method_not_allowed");
});

test("MCP-103 requires authentication and advertises the protected resource on 401", async (t) => {
  const transport = await startTransport({
    protectedResourceMetadata: loadProtectedResourceMetadata({
      env: OAUTH_ENV,
      isProduction: true
    })
  });
  t.after(() => transport.close());

  const response = await fetch(`${transport.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION }
    })
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, -32000);
  assert.equal(
    response.headers.get("www-authenticate"),
    'Bearer realm="tkl-mcp", resource_metadata='
    + '"https://tkl.example.com/.well-known/oauth-protected-resource/mcp"'
  );
});

test("MCP-103 publishes protected-resource metadata without leaking configuration secrets", async (t) => {
  const transport = await startTransport({
    protectedResourceMetadata: loadProtectedResourceMetadata({
      env: OAUTH_ENV,
      isProduction: true
    })
  });
  t.after(() => transport.close());

  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp"
  ]) {
    const response = await transport.request("GET", path);
    const raw = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(JSON.parse(raw), {
      resource: "https://tkl.example.com/mcp",
      authorization_servers: ["https://login.example.com/tkl"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["tkl.knowledge.read"]
    });
    assert.equal(raw.includes("never-publish-this-value"), false);
    assert.equal(raw.includes(AUTHORIZATION), false);
  }
});

test("MCP-103 reports unconfigured OAuth metadata explicitly instead of inventing an issuer", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());

  const response = await transport.request("GET", "/.well-known/oauth-protected-resource");

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "oauth_metadata_not_configured");
});

test("MCP-103 preserves the per-subject rate limit as a 429 JSON-RPC error", async (t) => {
  const transport = await startTransport({
    rateLimiter: {
      assertWithinLimit() {
        throw new SecurityError(429, "rate_limit_exceeded", "Too many requests. Please retry later.", {
          retryAfterMs: 12_000
        });
      }
    }
  });
  t.after(() => transport.close());
  const { sessionId } = await initializeSession(transport);

  const response = await transport.post(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_knowledge_conflicts", arguments: { productId: PRODUCT_ID } }
    },
    { headers: { "mcp-session-id": sessionId } }
  );
  const body = await response.json();

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "12");
  assert.equal(body.error.code, -32000);
  assert.equal(body.error.message, "Too many requests. Please retry later.");
});

test("MCP-103 survives a malformed request target and a hostile upstream error message", async (t) => {
  const application = createApplication({
    knowledgeService: fixtureKnowledgeService(),
    auditLogger: silentAuditLogger
  });
  const gateway = createGateway({
    applicationClient: createApplicationApiClient({
      baseUrl: "http://tkl-api.example.test",
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            error: { code: "unauthenticated", message: "bad token\r\nX-Injected: yes" }
          }),
          { status: 401, headers: { "content-type": "application/json" } }
        )
    }),
    auditLogger: silentAuditLogger
  });
  const server = createServer(
    createMcpRequestListener({ gateway, sessionStore: createSessionStore() })
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const { port } = server.address();
  assert.equal(typeof application.handle, "function");

  const malformedTarget = await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write("POST /mcp HTTP/1.1\r\nHost: a b\r\nContent-Length: 0\r\n\r\n");
    });
    let received = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("timed out waiting for a response to a malformed request target"));
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });
  assert.match(malformedTarget, /^HTTP\/1\.1 4\d\d/);

  const post = async (body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { authorization: AUTHORIZATION, "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    });

  const initialize = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: LATEST_PROTOCOL_VERSION }
  });
  const sessionId = initialize.headers.get("mcp-session-id");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sessionId });

  const response = await post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_knowledge_conflicts", arguments: { productId: PRODUCT_ID } }
    },
    { "mcp-session-id": sessionId }
  );

  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    'Bearer realm="tkl-mcp", error="invalid_token", '
    + 'error_description="The presented credential was rejected."'
  );
  assert.equal(response.headers.get("x-injected"), null);
});

test("MCP-103 bounds transport traffic per credential before allocating a session", async (t) => {
  const transport = await startTransport({
    transportRateLimiter: {
      assertWithinLimit() {
        throw new SecurityError(429, "rate_limit_exceeded", "Too many requests. Please retry later.");
      }
    }
  });
  t.after(() => transport.close());

  const response = await transport.post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: LATEST_PROTOCOL_VERSION }
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.equal((await response.json()).error.code, -32000);
});

test("MCP-103 keeps the unauthenticated correlated health route available", async (t) => {  const transport = await startTransport();
  t.after(() => transport.close());

  const response = await transport.request("GET", "/health");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "healthy");
  assert.equal(
    body.components.some((component) => component.component === "mcp-gateway"),
    true
  );
});

test("MCP-103 surfaces an upstream authorization failure as a 401 without leaking internals", async (t) => {
  const transport = await startTransport();
  t.after(() => transport.close());

  const initialize = await fetch(`${transport.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: OTHER_AUTHORIZATION,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION }
    })
  });
  const sessionId = initialize.headers.get("mcp-session-id");
  await fetch(`${transport.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: OTHER_AUTHORIZATION,
      "content-type": "application/json",
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  });

  const response = await fetch(`${transport.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: OTHER_AUTHORIZATION,
      "content-type": "application/json",
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_knowledge_conflicts", arguments: { productId: PRODUCT_ID } }
    })
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, -32000);
  assert.match(response.headers.get("www-authenticate"), /^Bearer realm="tkl-mcp", error="invalid_token"/);
  assert.equal(JSON.stringify(body).includes(OTHER_AUTHORIZATION), false);
});
