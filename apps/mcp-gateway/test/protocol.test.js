import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/gateway.js";
import {
  assertProtocolVersionHeader,
  createMcpProtocol,
  JSON_RPC_ERROR_CODES,
  JsonRpcError,
  jsonRpcErrorResponse,
  jsonRpcResult,
  LATEST_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  parseJsonRpcMessage,
  SERVER_CAPABILITIES,
  SUPPORTED_PROTOCOL_VERSIONS,
  toJsonRpcError
} from "../src/protocol.js";
import { SecurityError } from "../../../packages/security/src/index.js";

function makeProtocol() {
  const handled = [];
  const gateway = createGateway({
    applicationClient: {
      async listKnowledgeConflicts(input) {
        handled.push(input);
        return { conflicts: [], provenance: [] };
      }
    },
    auditLogger: { async record() {} }
  });
  return { protocol: createMcpProtocol({ gateway }), gateway, handled };
}

test("initialize negotiates a supported protocol version and declares read-only capabilities", () => {
  const { protocol } = makeProtocol();

  const result = protocol.initialize({
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "coverage-analyst", version: "1.0.0" }
  });

  assert.equal(result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.deepEqual(result.capabilities, SERVER_CAPABILITIES);
  assert.deepEqual(Object.keys(result.capabilities).sort(), ["resources", "tools"]);
  assert.equal(result.capabilities.tools.listChanged, false);
  assert.equal(result.capabilities.resources.subscribe, false);
  assert.equal(result.serverInfo.name, "tkl-mcp-gateway");
  assert.match(result.instructions, /read-only/i);
});

test("initialize accepts every supported protocol revision without downgrading it", () => {
  const { protocol } = makeProtocol();

  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(protocol.initialize({ protocolVersion: version }).protocolVersion, version);
  }
});

test("initialize rejects an unsupported protocol version and reports the supported list", () => {
  const { protocol } = makeProtocol();

  assert.throws(
    () => protocol.initialize({ protocolVersion: "1999-01-01" }),
    (error) =>
      error instanceof JsonRpcError
      && error.code === JSON_RPC_ERROR_CODES.invalidParams
      && error.data.supported.includes(LATEST_PROTOCOL_VERSION)
  );
});

test("initialize rejects a missing or non-string protocol version", () => {
  const { protocol } = makeProtocol();

  assert.throws(
    () => protocol.initialize({}),
    (error) => error.code === JSON_RPC_ERROR_CODES.invalidParams
  );
  assert.throws(
    () => negotiateProtocolVersion(2025),
    (error) => error.code === JSON_RPC_ERROR_CODES.invalidParams
  );
});

test("initialize rejects malformed capabilities and clientInfo params", () => {
  const { protocol } = makeProtocol();

  assert.throws(
    () => protocol.initialize({ protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: [] }),
    (error) => error.code === JSON_RPC_ERROR_CODES.invalidParams
  );
  assert.throws(
    () => protocol.initialize({ protocolVersion: LATEST_PROTOCOL_VERSION, clientInfo: "agent" }),
    (error) => error.code === JSON_RPC_ERROR_CODES.invalidParams
  );
});

test("parses a well-formed JSON-RPC request and notification", () => {
  assert.deepEqual(
    parseJsonRpcMessage({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    { id: 7, method: "tools/list", params: {}, isNotification: false }
  );
  assert.deepEqual(
    parseJsonRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" }),
    { id: undefined, method: "notifications/initialized", params: {}, isNotification: true }
  );
});

test("rejects malformed JSON-RPC envelopes", () => {
  const cases = [
    [{ id: 1, method: "tools/list" }, JSON_RPC_ERROR_CODES.invalidRequest],
    [{ jsonrpc: "1.0", id: 1, method: "tools/list" }, JSON_RPC_ERROR_CODES.invalidRequest],
    [{ jsonrpc: "2.0", id: 1 }, JSON_RPC_ERROR_CODES.invalidRequest],
    [{ jsonrpc: "2.0", id: null, method: "tools/list" }, JSON_RPC_ERROR_CODES.invalidRequest],
    [{ jsonrpc: "2.0", id: { nested: true }, method: "tools/list" }, JSON_RPC_ERROR_CODES.invalidRequest],
    ["tools/list", JSON_RPC_ERROR_CODES.invalidRequest],
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: [] }, JSON_RPC_ERROR_CODES.invalidParams]
  ];

  for (const [message, expectedCode] of cases) {
    assert.throws(
      () => parseJsonRpcMessage(message),
      (error) => error instanceof JsonRpcError && error.code === expectedCode && error.status === 400,
      `expected ${JSON.stringify(message)} to be rejected`
    );
  }
});

test("rejects JSON-RPC batches instead of fanning out gateway work", () => {
  assert.throws(
    () => parseJsonRpcMessage([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" }
    ]),
    (error) => error.code === JSON_RPC_ERROR_CODES.invalidRequest && /batch/i.test(error.message)
  );
});

test("validates the MCP-Protocol-Version header against the negotiated session version", () => {
  assert.equal(assertProtocolVersionHeader(undefined, "2025-06-18"), "2025-06-18");
  assert.equal(assertProtocolVersionHeader("2025-06-18", "2025-06-18"), "2025-06-18");
  assert.throws(
    () => assertProtocolVersionHeader("2024-01-01", "2025-06-18"),
    (error) => error.status === 400 && error.data.supported.length === SUPPORTED_PROTOCOL_VERSIONS.length
  );
  assert.throws(
    () => assertProtocolVersionHeader("2024-11-05", "2025-06-18"),
    (error) => error.status === 400 && error.data.negotiated === "2025-06-18"
  );
});

test("defaults the protocol version to the specification default when no session applies", () => {
  assert.equal(assertProtocolVersionHeader(undefined, undefined), "2025-03-26");
});

test("dispatch answers ping and the empty static resource list without the gateway", async () => {
  const { protocol } = makeProtocol();

  assert.deepEqual(await protocol.dispatch("ping"), {});
  assert.deepEqual(await protocol.dispatch("resources/list"), { resources: [] });
});

test("dispatch rejects a repeated initialize on an established session", async () => {
  const { protocol } = makeProtocol();

  await assert.rejects(
    protocol.dispatch("initialize", { protocolVersion: LATEST_PROTOCOL_VERSION }),
    (error) => error.code === JSON_RPC_ERROR_CODES.invalidRequest && error.status === 400
  );
});

test("dispatch routes capability methods through the existing gateway allowlist", async () => {
  const { protocol, handled } = makeProtocol();

  const tools = await protocol.dispatch("tools/list");
  const call = await protocol.dispatch("tools/call", {
    name: "list_knowledge_conflicts",
    arguments: { productId: "fl-titling" }
  });
  const templates = await protocol.dispatch("resources/templates/list");

  assert.equal(tools.tools.length, 5);
  assert.equal(call.isError, false);
  assert.equal(templates.resourceTemplates.length, 4);
  assert.deepEqual(handled, [{ productId: "fl-titling" }]);
});

test("dispatch keeps denying methods outside the read-only allowlist", async () => {
  const { protocol } = makeProtocol();

  for (const method of ["tools/write", "resources/write", "resources/subscribe", "prompts/list"]) {
    await assert.rejects(
      protocol.dispatch(method, {}),
      (error) => error.code === "method_not_found",
      `expected ${method} to be denied`
    );
  }
});

test("maps gateway error codes onto standard JSON-RPC error codes", () => {
  const cases = [
    ["invalid_arguments", JSON_RPC_ERROR_CODES.invalidParams],
    ["tool_not_found", JSON_RPC_ERROR_CODES.invalidParams],
    ["method_not_found", JSON_RPC_ERROR_CODES.methodNotFound],
    ["resource_not_found", JSON_RPC_ERROR_CODES.resourceNotFound],
    ["invalid_resource_uri", JSON_RPC_ERROR_CODES.invalidParams],
    ["application_capability_unavailable", JSON_RPC_ERROR_CODES.internalError]
  ];

  for (const [code, expected] of cases) {
    const error = Object.assign(new Error("denied"), { code, status: 400 });
    const mapped = toJsonRpcError(error);
    assert.equal(mapped.code, expected, `expected ${code} to map to ${expected}`);
    assert.equal(mapped.status, 200);
  }
});

test("maps security failures to their HTTP status without losing the JSON-RPC shape", () => {
  const mapped = toJsonRpcError(
    new SecurityError(429, "rate_limit_exceeded", "Too many requests. Please retry later.", {
      retryAfterMs: 1000
    })
  );

  assert.equal(mapped.code, JSON_RPC_ERROR_CODES.transport);
  assert.equal(mapped.status, 429);
  assert.deepEqual(mapped.data, { retryAfterMs: 1000 });
});

test("forwards upstream authorization failures and hides every other internal failure", () => {
  const upstream = Object.assign(new Error("The token is expired."), {
    code: "application_api_error",
    status: 401
  });
  assert.equal(toJsonRpcError(upstream).status, 401);

  const internal = new Error("connect ECONNREFUSED 10.0.0.5:3000");
  const mapped = toJsonRpcError(internal);
  assert.equal(mapped.code, JSON_RPC_ERROR_CODES.internalError);
  assert.equal(mapped.message, "The MCP request could not be completed.");
  assert.equal(mapped.message.includes("ECONNREFUSED"), false);
});

test("builds JSON-RPC response envelopes", () => {
  assert.deepEqual(jsonRpcResult(1, { ok: true }), {
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true }
  });
  assert.deepEqual(
    jsonRpcErrorResponse(undefined, new JsonRpcError(-32600, "bad", { data: { a: 1 } })),
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "bad", data: { a: 1 } } }
  );
});
