import test from "node:test";
import assert from "node:assert/strict";
import {
  bearerChallenge,
  isProtectedResourceMetadataPath,
  loadProtectedResourceMetadata,
  PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceMetadataUrl
} from "../src/oauth-metadata.js";

const CONFIGURED_ENV = {
  TKL_MCP_RESOURCE_URI: "https://tkl.example.com/mcp",
  TKL_MCP_AUTHORIZATION_SERVERS: "https://login.example.com/tenant-a",
  TKL_MCP_SCOPES_SUPPORTED: "tkl.knowledge.read, tkl.coverage.read",
  TKL_MCP_RESOURCE_DOCUMENTATION: "https://tkl.example.com/docs/mcp"
};

test("publishes only configured issuer and resource values", () => {
  const metadata = loadProtectedResourceMetadata({ env: CONFIGURED_ENV, isProduction: true });

  assert.deepEqual(metadata, {
    resource: "https://tkl.example.com/mcp",
    authorization_servers: ["https://login.example.com/tenant-a"],
    bearer_methods_supported: ["header"],
    scopes_supported: ["tkl.knowledge.read", "tkl.coverage.read"],
    resource_documentation: "https://tkl.example.com/docs/mcp"
  });
});

test("omits optional members rather than inventing them", () => {
  const metadata = loadProtectedResourceMetadata({
    env: {
      TKL_MCP_RESOURCE_URI: "https://tkl.example.com/mcp",
      TKL_MCP_AUTHORIZATION_SERVERS: "https://login.example.com/tenant-a"
    },
    isProduction: true
  });

  assert.equal("scopes_supported" in metadata, false);
  assert.equal("resource_documentation" in metadata, false);
});

test("accepts several authorization servers", () => {
  const metadata = loadProtectedResourceMetadata({
    env: {
      TKL_MCP_RESOURCE_URI: "https://tkl.example.com/mcp",
      TKL_MCP_AUTHORIZATION_SERVERS:
        "https://login.example.com/tenant-a, https://login.example.com/tenant-b"
    },
    isProduction: true
  });

  assert.deepEqual(metadata.authorization_servers, [
    "https://login.example.com/tenant-a",
    "https://login.example.com/tenant-b"
  ]);
});

test("fails closed in production when no OAuth metadata is configured", () => {
  assert.throws(
    () => loadProtectedResourceMetadata({ env: {}, isProduction: true }),
    /OAuth protected-resource metadata is not configured/
  );
});

test("returns undefined outside production when no OAuth metadata is configured", () => {
  assert.equal(loadProtectedResourceMetadata({ env: {}, isProduction: false }), undefined);
});

test("rejects partial configuration in every environment", () => {
  assert.throws(
    () =>
      loadProtectedResourceMetadata({
        env: { TKL_MCP_RESOURCE_URI: "https://tkl.example.com/mcp" },
        isProduction: false
      }),
    /TKL_MCP_AUTHORIZATION_SERVERS is required/
  );
  assert.throws(
    () =>
      loadProtectedResourceMetadata({
        env: { TKL_MCP_AUTHORIZATION_SERVERS: "https://login.example.com/tenant-a" },
        isProduction: false
      }),
    /TKL_MCP_RESOURCE_URI is required/
  );
});

test("rejects metadata values that are not publishable URLs", () => {
  const invalid = [
    ["TKL_MCP_RESOURCE_URI", "tkl-mcp", /absolute URL/],
    ["TKL_MCP_RESOURCE_URI", "ftp://tkl.example.com/mcp", /must use https/],
    ["TKL_MCP_AUTHORIZATION_SERVERS", "https://user:secret@login.example.com", /must not embed credentials/],
    ["TKL_MCP_AUTHORIZATION_SERVERS", "https://login.example.com/#token", /must not include a fragment/]
  ];

  for (const [variable, value, expected] of invalid) {
    assert.throws(
      () =>
        loadProtectedResourceMetadata({
          env: { ...CONFIGURED_ENV, [variable]: value },
          isProduction: true
        }),
      expected,
      `expected ${variable}=${value} to be rejected`
    );
  }
});

test("requires https in production but allows local http during development", () => {
  const env = {
    TKL_MCP_RESOURCE_URI: "http://localhost:3100/mcp",
    TKL_MCP_AUTHORIZATION_SERVERS: "http://localhost:8080/realms/tkl"
  };

  assert.throws(
    () => loadProtectedResourceMetadata({ env, isProduction: true }),
    /must use https in production/
  );
  assert.equal(
    loadProtectedResourceMetadata({ env, isProduction: false }).resource,
    "http://localhost:3100/mcp"
  );
});

test("never copies unrelated environment values into the metadata document", () => {
  const metadata = loadProtectedResourceMetadata({
    env: {
      ...CONFIGURED_ENV,
      TKL_SECRET__TESTRAIL__FL_TITLING: "super-secret-value",
      TKL_AUTH_TOKENS: "token-map"
    },
    isProduction: true
  });

  const serialized = JSON.stringify(metadata);
  assert.equal(serialized.includes("super-secret-value"), false);
  assert.equal(serialized.includes("token-map"), false);
});

test("derives the RFC 9728 metadata URL from the resource path", () => {
  assert.equal(
    protectedResourceMetadataUrl({ resource: "https://tkl.example.com/mcp" }),
    "https://tkl.example.com/.well-known/oauth-protected-resource/mcp"
  );
  assert.equal(
    protectedResourceMetadataUrl({ resource: "https://tkl.example.com/" }),
    "https://tkl.example.com/.well-known/oauth-protected-resource"
  );
});

test("recognizes both metadata locations", () => {
  assert.equal(isProtectedResourceMetadataPath(PROTECTED_RESOURCE_METADATA_PATH), true);
  assert.equal(isProtectedResourceMetadataPath(`${PROTECTED_RESOURCE_METADATA_PATH}/mcp`), true);
  assert.equal(isProtectedResourceMetadataPath("/.well-known/openid-configuration"), false);
});

test("builds a bearer challenge that points at metadata only when it is configured", () => {
  const metadata = loadProtectedResourceMetadata({ env: CONFIGURED_ENV, isProduction: true });

  assert.equal(
    bearerChallenge({ metadata, error: "invalid_token", errorDescription: "Authentication is required." }),
    'Bearer realm="tkl-mcp", error="invalid_token", error_description="Authentication is required.", '
    + 'resource_metadata="https://tkl.example.com/.well-known/oauth-protected-resource/mcp"'
  );
  assert.equal(bearerChallenge({ metadata: undefined }), 'Bearer realm="tkl-mcp"');
});

test("escapes quoted challenge parameters instead of letting them break out", () => {
  const challenge = bearerChallenge({
    metadata: undefined,
    error: 'invalid"_token',
    errorDescription: 'injected", resource_metadata="https://attacker.example.com/meta'
  });

  assert.equal(
    challenge,
    'Bearer realm="tkl-mcp", error="invalid\\"_token", '
    + 'error_description="injected\\", resource_metadata=\\"https://attacker.example.com/meta"'
  );
});

test("strips control characters that would split a response header", () => {
  const challenge = bearerChallenge({
    metadata: undefined,
    error: "invalid_token",
    errorDescription: "bad token\r\nX-Injected: yes"
  });

  assert.equal(challenge.includes("\r"), false);
  assert.equal(challenge.includes("\n"), false);
  assert.equal(
    challenge,
    'Bearer realm="tkl-mcp", error="invalid_token", error_description="bad tokenX-Injected: yes"'
  );
});
