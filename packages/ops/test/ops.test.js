import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  credentialReferenceEnvVarName,
  createEnvCredentialResolver,
  createAuditSink,
  createEnvIdentityAdapter,
  createConfiguredAuthenticator,
  createIdentityClaimsMapper,
  createIdentityVerifier,
  loadProductConfiguration,
  validateDeploymentEnvironment,
} from "../src/index.js";
import { PolicyError } from "../../policy/src/index.js";

const TEST_ISSUER = "https://identity.example.test/tenant/v2.0";
const TEST_AUDIENCE = "api://tkl";
const TEST_NOW_MS = Date.UTC(2026, 8, 12, 18, 0, 0);

function createSigningFixture({ kid = "test-key-1" } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey,
    jwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
    },
  };
}

function signJwt({
  privateKey,
  kid = "test-key-1",
  payload,
  algorithm = "RS256",
  headerOverrides = {},
}) {
  const encodedHeader = Buffer.from(
    JSON.stringify({ alg: algorithm, kid, typ: "JWT", ...headerOverrides }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function identityEnv(overrides = {}) {
  return {
    TKL_IDENTITY_PROVIDER: "oidc",
    TKL_IDENTITY_ISSUER: TEST_ISSUER,
    TKL_IDENTITY_AUDIENCE: TEST_AUDIENCE,
    TKL_IDENTITY_JWKS_URI: "https://identity.example.test/keys",
    ...overrides,
  };
}

function validIdentityPayload(overrides = {}) {
  return {
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    sub: "carlos@solera.com",
    exp: Math.floor(TEST_NOW_MS / 1_000) + 300,
    iat: Math.floor(TEST_NOW_MS / 1_000) - 30,
    roles: ["reader"],
    scp: "knowledge:read coverage:read",
    tkl_products: ["fl-titling"],
    tid: "solera",
    ...overrides,
  };
}

function jsonResponse(value) {
  return { ok: true, async text() { return JSON.stringify(value); } };
}

test("derives a deterministic env var name for a secret:// reference", () => {
  assert.equal(credentialReferenceEnvVarName("secret://jira/fl-titling"), "TKL_SECRET__JIRA__FL_TITLING");
});

test("passes an env:// reference through as its own explicit variable name", () => {
  assert.equal(credentialReferenceEnvVarName("env://TESTRAIL_API_KEY"), "TESTRAIL_API_KEY");
});

test("rejects an unsupported credential reference scheme", () => {
  assert.throws(() => credentialReferenceEnvVarName("ftp://nope"), TypeError);
});

test("resolves a secret:// reference from its mapped environment variable", async () => {
  const resolver = createEnvCredentialResolver({ env: { TKL_SECRET__JIRA__FL_TITLING: "token-value" } });
  assert.equal(await resolver.resolve("secret://jira/fl-titling"), "token-value");
});

test("fails closed when the mapped environment variable is missing", async () => {
  const resolver = createEnvCredentialResolver({ env: {} });
  await assert.rejects(() => resolver.resolve("secret://jira/fl-titling"), /did not resolve/);
});

test("fails closed when the mapped environment variable is empty", async () => {
  const resolver = createEnvCredentialResolver({ env: { TKL_SECRET__JIRA__FL_TITLING: "   " } });
  await assert.rejects(() => resolver.resolve("secret://jira/fl-titling"), /did not resolve/);
});

test("never leaks the resolved secret value in a thrown error", async () => {
  const resolver = createEnvCredentialResolver({ env: {} });
  try {
    await resolver.resolve("secret://jira/fl-titling");
    assert.fail("expected resolve to throw");
  } catch (error) {
    assert.equal(String(error.message).includes("token-value"), false);
  }
});

test("rejects a malformed credential reference before resolving anything", async () => {
  const resolver = createEnvCredentialResolver({ env: {} });
  await assert.rejects(() => resolver.resolve("not-a-reference"), TypeError);
});

test("builds a console audit sink by default", () => {
  assert.equal(createAuditSink({ destination: "console" }), console);
});

test("builds a stdout audit sink that writes one JSON line per event", () => {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    createAuditSink({ destination: "stdout" }).info({ eventType: "api.request" });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(chunks.length, 1);
  assert.deepEqual(JSON.parse(chunks[0]), { eventType: "api.request" });
});

test("builds a discarding audit sink for tests", () => {
  const sink = createAuditSink({ destination: "none" });
  assert.doesNotThrow(() => sink.info({ eventType: "api.request" }));
});

test("rejects an unsupported audit destination instead of silently defaulting", () => {
  assert.throws(() => createAuditSink({ destination: "syslog" }), TypeError);
});

test("loads product configuration from default path", () => {
  const config = loadProductConfiguration({ productId: "fl-titling" });
  assert.equal(config?.productId, "fl-titling");
  assert.ok(Array.isArray(config?.enabledPlugins));
});

test("createEnvIdentityAdapter requires an explicitly injected verifier", () => {
  assert.throws(
    () => createEnvIdentityAdapter({ env: { TKL_IDENTITY_PROVIDER: "entra-id" } }),
    /No identity verifier is wired/,
  );
});

test("createEnvIdentityAdapter maps verified provider claims onto the auth context", async () => {
  const adapter = createEnvIdentityAdapter({
    env: { TKL_IDENTITY_PROVIDER: "entra-id", TKL_TENANT_ID: "solera" },
    verifyToken: async (token) => {
      assert.equal(token, "signed-provider-token");
      return {
        sub: "carlos@solera.com",
        roles: ["reader"],
        permissions: ["knowledge:read"],
        productIds: ["fl-titling"],
        tenantId: "solera",
      };
    },
  });
  const authContext = await adapter.authenticate("signed-provider-token");
  assert.equal(authContext.subject, "carlos@solera.com");
  assert.deepEqual(authContext.roles, ["reader"]);
  assert.deepEqual(authContext.permissions, ["knowledge:read"]);
  assert.deepEqual(authContext.productIds, ["fl-titling"]);
  assert.equal(authContext.tenantId, "solera");
});

test("createEnvIdentityAdapter never fabricates reader or wildcard access from sparse claims", async () => {
  const adapter = createEnvIdentityAdapter({
    env: { TKL_IDENTITY_PROVIDER: "entra-id", TKL_TENANT_ID: "solera", TKL_PRODUCT_ID: "fl-titling" },
    verifyToken: async () => ({ sub: "carlos@solera.com" }),
  });
  const authContext = await adapter.authenticate("signed-provider-token");
  assert.deepEqual(authContext.roles, []);
  assert.deepEqual(authContext.permissions, []);
  assert.deepEqual(authContext.productIds, []);
  assert.equal(authContext.tenantId, undefined);
});

test("createEnvIdentityAdapter rejects verified claims for another tenant", async () => {
  const adapter = createEnvIdentityAdapter({
    env: { TKL_TENANT_ID: "solera" },
    verifyToken: async () => ({ sub: "attacker", roles: ["reader"], tenantId: "other-tenant" }),
  });
  await assert.rejects(() => adapter.authenticate("signed-provider-token"), /cannot access this tenant/);
});

test("createEnvIdentityAdapter rejects malformed claim collections", async () => {
  const adapter = createEnvIdentityAdapter({
    env: {},
    verifyToken: async () => ({ sub: "carlos", roles: "admin" }),
  });
  await assert.rejects(() => adapter.authenticate("signed-provider-token"), /must be an array of non-empty strings/);
});

test("createEnvIdentityAdapter rejects wildcard product access from every mapper", async () => {
  const adapter = createEnvIdentityAdapter({
    env: {},
    verifyToken: async () => ({
      sub: "carlos",
      roles: ["reader"],
      permissions: ["knowledge:read"],
      productIds: ["*"],
    }),
  });
  await assert.rejects(
    () => adapter.authenticate("signed-provider-token"),
    (error) => error instanceof PolicyError && error.code === "invalid_auth_context",
  );
});

test("createConfiguredAuthenticator refuses to build a production authenticator without a verifier", () => {
  assert.throws(
    () =>
      createConfiguredAuthenticator({
        env: { NODE_ENV: "production", TKL_IDENTITY_PROVIDER: "entra-id", TKL_TENANT_ID: "solera" },
      }),
    /No identity verifier is wired/,
  );
});

test("createConfiguredAuthenticator refuses the static token path whenever an identity provider is configured", () => {
  assert.throws(
    () =>
      createConfiguredAuthenticator({
        env: { TKL_IDENTITY_PROVIDER: "entra-id", TKL_AUTH_TOKENS: '{"dev-token":{"subject":"carlos"}}' },
      }),
    /No identity verifier is wired/,
  );
});

test("createConfiguredAuthenticator rejects an arbitrary production bearer token", async () => {
  const authenticator = createConfiguredAuthenticator({
    env: { NODE_ENV: "production", TKL_IDENTITY_PROVIDER: "entra-id", TKL_TENANT_ID: "solera" },
    verifyToken: async (token) => {
      if (token !== "signed-provider-token") {
        throw new PolicyError(401, "unauthenticated", "The identity token is invalid.");
      }
      return { sub: "carlos@solera.com", roles: ["reader"], permissions: ["knowledge:read"], productIds: ["fl-titling"], tenantId: "solera" };
    },
  });
  await assert.rejects(
    () => authenticator.authenticate("Bearer prod-session-token"),
    (error) => error.status === 401,
  );
});

test("createConfiguredAuthenticator rejects self-asserted JSON admin claims presented as a token", async () => {
  const authenticator = createConfiguredAuthenticator({
    env: { NODE_ENV: "production", TKL_IDENTITY_PROVIDER: "entra-id", TKL_TENANT_ID: "solera" },
    verifyToken: async (token) => {
      if (token !== "signed-provider-token") {
        throw new PolicyError(401, "unauthenticated", "The identity token is invalid.");
      }
      return { sub: "carlos@solera.com", roles: ["reader"], permissions: ["knowledge:read"], productIds: ["fl-titling"], tenantId: "solera" };
    },
  });
  const forged = JSON.stringify({
    sub: "attacker",
    roles: ["admin"],
    permissions: ["knowledge:read"],
    productIds: ["*"],
    tenantId: "solera",
  });
  await assert.rejects(
    () => authenticator.authenticate(`Bearer ${forged}`),
    (error) => error.status === 401,
  );
});

test("createConfiguredAuthenticator authenticates production tokens through the injected verifier", async () => {
  const authenticator = createConfiguredAuthenticator({
    env: { NODE_ENV: "production", TKL_IDENTITY_PROVIDER: "entra-id", TKL_TENANT_ID: "solera" },
    verifyToken: async (token) => {
      if (token !== "signed-provider-token") {
        throw new PolicyError(401, "unauthenticated", "The identity token is invalid.");
      }
      return { sub: "carlos@solera.com", roles: ["reader"], permissions: ["knowledge:read"], productIds: ["fl-titling"], tenantId: "solera" };
    },
  });
  const authContext = await authenticator.authenticate("Bearer signed-provider-token");
  assert.equal(authContext.subject, "carlos@solera.com");
  assert.deepEqual(authContext.roles, ["reader"]);
  assert.deepEqual(authContext.productIds, ["fl-titling"]);
  assert.equal(authContext.tenantId, "solera");
});

test("createIdentityVerifier stays unwired when no provider configuration exists", () => {
  assert.equal(createIdentityVerifier(), undefined);
});

test("createIdentityVerifier rejects partial provider configuration at startup", () => {
  assert.throws(
    () => createIdentityVerifier({ env: { TKL_IDENTITY_ISSUER: TEST_ISSUER } }),
    /TKL_IDENTITY_AUDIENCE is required/,
  );
});

test("createIdentityVerifier verifies an OIDC JWT against a configured JWKS", async () => {
  const signing = createSigningFixture();
  let fetchCount = 0;
  const verifier = createIdentityVerifier({
    env: identityEnv(),
    fetchImpl: async (url) => {
      fetchCount += 1;
      assert.equal(url, "https://identity.example.test/keys");
      return jsonResponse({ keys: [signing.jwk] });
    },
    now: () => TEST_NOW_MS,
  });
  const token = signJwt({ privateKey: signing.privateKey, payload: validIdentityPayload() });

  const claims = await verifier(token);
  assert.equal(claims.sub, "carlos@solera.com");
  assert.equal(claims.iss, TEST_ISSUER);
  await verifier(token);
  assert.equal(fetchCount, 1, "the JWKS should be reused from the bounded cache");
});

test("createIdentityVerifier discovers and validates the provider JWKS URI", async () => {
  const signing = createSigningFixture();
  const requested = [];
  let currentTime = TEST_NOW_MS;
  const verifier = createIdentityVerifier({
    env: identityEnv({ TKL_IDENTITY_JWKS_URI: undefined }),
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === `${TEST_ISSUER}/.well-known/openid-configuration`) {
        return jsonResponse({
          issuer: TEST_ISSUER,
          jwks_uri: "https://identity.example.test/discovered-keys",
        });
      }
      assert.equal(url, "https://identity.example.test/discovered-keys");
      return jsonResponse({ keys: [signing.jwk] });
    },
    now: () => currentTime,
  });
  const token = signJwt({
    privateKey: signing.privateKey,
    payload: validIdentityPayload({ exp: Math.floor(TEST_NOW_MS / 1_000) + 1_000 }),
  });

  await verifier(token);
  currentTime += 301_000;
  await verifier(token);
  assert.deepEqual(requested, [
    `${TEST_ISSUER}/.well-known/openid-configuration`,
    "https://identity.example.test/discovered-keys",
    `${TEST_ISSUER}/.well-known/openid-configuration`,
    "https://identity.example.test/discovered-keys",
  ]);
});

test("createIdentityVerifier preserves an exact bare-host issuer", async () => {
  const issuer = "https://accounts.example.test";
  const signing = createSigningFixture();
  const verifier = createIdentityVerifier({
    env: identityEnv({
      TKL_IDENTITY_ISSUER: issuer,
      TKL_IDENTITY_JWKS_URI: "https://accounts.example.test/keys",
    }),
    fetchImpl: async () => jsonResponse({ keys: [signing.jwk] }),
    now: () => TEST_NOW_MS,
  });
  const token = signJwt({
    privateKey: signing.privateKey,
    payload: validIdentityPayload({ iss: issuer }),
  });

  assert.equal((await verifier(token)).iss, issuer);
});

test("createIdentityVerifier rejects forged, expired, and wrong-audience tokens", async () => {
  const trusted = createSigningFixture();
  const attacker = createSigningFixture();
  const verifier = createIdentityVerifier({
    env: identityEnv(),
    fetchImpl: async () => jsonResponse({ keys: [trusted.jwk] }),
    now: () => TEST_NOW_MS,
  });

  await assert.rejects(
    () => verifier(signJwt({ privateKey: attacker.privateKey, payload: validIdentityPayload() })),
    (error) => error instanceof PolicyError && error.status === 401,
  );
  await assert.rejects(
    () => verifier(signJwt({
      privateKey: trusted.privateKey,
      payload: validIdentityPayload({ exp: Math.floor(TEST_NOW_MS / 1_000) - 120 }),
    })),
    (error) => error instanceof PolicyError && error.status === 401,
  );
  await assert.rejects(
    () => verifier(signJwt({
      privateKey: trusted.privateKey,
      payload: validIdentityPayload({ aud: "api://another-service" }),
    })),
    (error) => error instanceof PolicyError && error.status === 401,
  );
});

test("invalid issuer, audience, or expiry never triggers an outbound key request", async () => {
  const signing = createSigningFixture();
  let fetchCount = 0;
  const verifier = createIdentityVerifier({
    env: identityEnv(),
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({ keys: [signing.jwk] });
    },
    now: () => TEST_NOW_MS,
  });
  const token = signJwt({
    privateKey: signing.privateKey,
    payload: validIdentityPayload({ iss: "https://attacker.example.test" }),
  });

  await assert.rejects(() => verifier(token), (error) => error.status === 401);
  assert.equal(fetchCount, 0);
});

test("unsupported algorithms, critical headers, and future tokens fail before key retrieval", async () => {
  const signing = createSigningFixture();
  let fetchCount = 0;
  const verifier = createIdentityVerifier({
    env: identityEnv(),
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({ keys: [signing.jwk] });
    },
    now: () => TEST_NOW_MS,
  });

  await assert.rejects(
    () => verifier(signJwt({
      privateKey: signing.privateKey,
      payload: validIdentityPayload(),
      algorithm: "HS256",
    })),
    (error) => error.status === 401,
  );
  await assert.rejects(
    () => verifier(signJwt({
      privateKey: signing.privateKey,
      payload: validIdentityPayload(),
      headerOverrides: { crit: ["custom"] },
    })),
    (error) => error.status === 401,
  );
  await assert.rejects(
    () => verifier(signJwt({
      privateKey: signing.privateKey,
      payload: validIdentityPayload({ nbf: Math.floor(TEST_NOW_MS / 1_000) + 120 }),
    })),
    (error) => error.status === 401,
  );
  assert.equal(fetchCount, 0);
});

test("identity provider outages return a generic temporary-unavailability error", async () => {
  const signing = createSigningFixture();
  const verifier = createIdentityVerifier({
    env: identityEnv(),
    fetchImpl: async () => {
      throw new Error("internal network detail");
    },
    now: () => TEST_NOW_MS,
  });
  const token = signJwt({ privateKey: signing.privateKey, payload: validIdentityPayload() });

  await assert.rejects(
    () => verifier(token),
    (error) =>
      error instanceof PolicyError
      && error.status === 503
      && error.code === "identity_provider_unavailable"
      && error.message === "Authentication is temporarily unavailable.",
  );
});

test("identity provider failures are retried at most once per cooldown", async () => {
  const signing = createSigningFixture();
  let fetchCount = 0;
  let currentTime = TEST_NOW_MS;
  const verifier = createIdentityVerifier({
    env: identityEnv(),
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("provider unavailable");
    },
    now: () => currentTime,
  });
  const token = signJwt({ privateKey: signing.privateKey, payload: validIdentityPayload() });

  await assert.rejects(() => verifier(token), (error) => error.status === 503);
  await assert.rejects(() => verifier(token), (error) => error.status === 503);
  assert.equal(fetchCount, 1);

  currentTime += 31_000;
  await assert.rejects(() => verifier(token), (error) => error.status === 503);
  assert.equal(fetchCount, 2);
});

test("unknown key IDs refresh at most once during the cooldown", async () => {
  const trusted = createSigningFixture({ kid: "trusted-key" });
  const attacker = createSigningFixture({ kid: "unknown-key" });
  let fetchCount = 0;
  let currentTime = TEST_NOW_MS;
  const verifier = createIdentityVerifier({
    env: identityEnv(),
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({ keys: [trusted.jwk] });
    },
    now: () => currentTime,
  });
  const valid = signJwt({
    privateKey: trusted.privateKey,
    kid: "trusted-key",
    payload: validIdentityPayload(),
  });
  const unknown = signJwt({
    privateKey: attacker.privateKey,
    kid: "unknown-key",
    payload: validIdentityPayload(),
  });

  await verifier(valid);
  await assert.rejects(() => verifier(unknown), (error) => error.status === 401);
  await assert.rejects(() => verifier(unknown), (error) => error.status === 401);
  assert.equal(fetchCount, 1, "unknown keys must not bypass the refresh cooldown");

  currentTime += 31_000;
  await assert.rejects(() => verifier(unknown), (error) => error.status === 401);
  assert.equal(fetchCount, 2, "one refresh is permitted after the cooldown");
});

test("createIdentityClaimsMapper maps explicit Entra/OIDC claims without fabricating access", () => {
  const mapper = createIdentityClaimsMapper({ env: {} });
  assert.deepEqual(mapper(validIdentityPayload()), {
    subject: "carlos@solera.com",
    roles: ["reader"],
    permissions: ["knowledge:read", "coverage:read"],
    productIds: ["fl-titling"],
    tenantId: "solera",
  });
  assert.deepEqual(mapper({ sub: "subject-only" }), {
    subject: "subject-only",
    roles: [],
    permissions: [],
    productIds: [],
  });
});

test("createIdentityClaimsMapper supports deployment-selected claim names", () => {
  const mapper = createIdentityClaimsMapper({
    env: {
      TKL_IDENTITY_SUBJECT_CLAIM: "oid",
      TKL_IDENTITY_ROLES_CLAIM: "app_roles",
      TKL_IDENTITY_PERMISSIONS_CLAIM: "permissions",
      TKL_IDENTITY_PRODUCTS_CLAIM: "products",
      TKL_IDENTITY_TENANT_CLAIM: "tenant",
    },
  });

  assert.deepEqual(
    mapper({
      oid: "service-principal",
      app_roles: "reader",
      permissions: ["knowledge:read"],
      products: "fl-titling,another-product",
      tenant: "solera",
    }),
    {
      subject: "service-principal",
      roles: ["reader"],
      permissions: ["knowledge:read"],
      productIds: ["fl-titling", "another-product"],
      tenantId: "solera",
    },
  );
});

test("createIdentityClaimsMapper rejects wildcard product access from token claims", () => {
  const mapper = createIdentityClaimsMapper({ env: {} });
  assert.throws(
    () => mapper(validIdentityPayload({ tkl_products: ["*"] })),
    (error) => error instanceof PolicyError && error.code === "invalid_auth_context",
  );
});

test("createConfiguredAuthenticator uses an injected verifier outside production", async () => {
  const authenticator = createConfiguredAuthenticator({
    env: {},
    verifyToken: async () => ({
      sub: "staging-subject",
      roles: [],
      permissions: [],
      productIds: [],
    }),
  });
  assert.equal((await authenticator.authenticate("Bearer signed-token")).subject, "staging-subject");
});

test("the production authenticator verifies and maps an OIDC token end to end", async () => {
  const signing = createSigningFixture();
  const env = identityEnv({ NODE_ENV: "production", TKL_TENANT_ID: "solera" });
  const verifyToken = createIdentityVerifier({
    env,
    fetchImpl: async () => jsonResponse({ keys: [signing.jwk] }),
    now: () => TEST_NOW_MS,
  });
  const authenticator = createConfiguredAuthenticator({
    env,
    verifyToken,
    mapClaims: createIdentityClaimsMapper({ env }),
  });
  const token = signJwt({ privateKey: signing.privateKey, payload: validIdentityPayload() });

  const authContext = await authenticator.authenticate(`Bearer ${token}`);
  assert.deepEqual(authContext, {
    subject: "carlos@solera.com",
    roles: ["reader"],
    permissions: ["knowledge:read", "coverage:read"],
    productIds: ["fl-titling"],
    tenantId: "solera",
  });
});

test("createConfiguredAuthenticator authenticates development tokens via static token map", async () => {
  const authenticator = createConfiguredAuthenticator({
    env: {
      TKL_AUTH_TOKENS: JSON.stringify({
        "dev-token": {
          subject: "carlos",
          roles: ["reader"],
          permissions: ["knowledge:read"],
          productIds: ["fl-titling"],
        },
      }),
    },
  });
  const authContext = await authenticator.authenticate("Bearer dev-token");
  assert.equal(authContext.subject, "carlos");
  assert.deepEqual(authContext.productIds, ["fl-titling"]);
});

test("passes a fully configured production environment", () => {
  const report = validateDeploymentEnvironment({
    isProduction: true,
    identityVerifier: async () => ({ sub: "carlos@solera.com" }),
    env: {
      PORT: "3000",
      TKL_TENANT_ID: "solera",
      TKL_AUDIT_DESTINATION: "stdout",
      TKL_IDENTITY_PROVIDER: "entra-id",
      TKL_REQUIRE_TLS: "true",
      TKL_SECRET__GITHUB__FL_TITLING: "token-value",
    },
  });
  assert.equal(report.ready, true);
  assert.equal(report.environment, "production");
  assert.ok(report.checklist.every((item) => item.status !== "fail"));
});

test("fails closed in production when no identity verifier is wired", () => {
  const report = validateDeploymentEnvironment({
    isProduction: true,
    env: {
      PORT: "3000",
      TKL_TENANT_ID: "solera",
      TKL_AUDIT_DESTINATION: "stdout",
      TKL_IDENTITY_PROVIDER: "entra-id",
      TKL_REQUIRE_TLS: "true",
    },
  });
  assert.equal(report.ready, false);
  const verifier = report.checklist.find((item) => item.id === "identity_verifier");
  assert.equal(verifier.status, "fail");
  assert.match(verifier.detail, /only a label/);
});

test("fails closed in production when a development identity token map is configured", () => {
  const report = validateDeploymentEnvironment({
    isProduction: true,
    identityVerifier: async () => ({ sub: "carlos@solera.com" }),
    env: {
      PORT: "3000",
      TKL_TENANT_ID: "solera",
      TKL_AUDIT_DESTINATION: "stdout",
      TKL_IDENTITY_PROVIDER: "entra-id",
      TKL_IDENTITY_TOKENS: '{"token":{}}',
      TKL_REQUIRE_TLS: "true",
    },
  });
  assert.equal(report.ready, false);
  assert.equal(report.checklist.find((item) => item.id === "identity_provider").status, "fail");
});

test("fails closed on a production environment still using the development static token map", () => {
  const report = validateDeploymentEnvironment({
    isProduction: true,
    env: {
      PORT: "3000",
      TKL_TENANT_ID: "solera",
      TKL_AUDIT_DESTINATION: "stdout",
      TKL_AUTH_TOKENS: '{"dev-token":{}}',
      TKL_REQUIRE_TLS: "true",
    },
  });
  assert.equal(report.ready, false);
  const identity = report.checklist.find((item) => item.id === "identity_provider");
  assert.equal(identity.status, "fail");
});

test("fails closed on whitespace or non-string TKL_IDENTITY_PROVIDER in production", () => {
  const whitespaceReport = validateDeploymentEnvironment({
    isProduction: true,
    env: {
      PORT: "3000",
      TKL_TENANT_ID: "solera",
      TKL_AUDIT_DESTINATION: "stdout",
      TKL_IDENTITY_PROVIDER: "   ",
      TKL_REQUIRE_TLS: "true",
    },
  });
  assert.equal(whitespaceReport.ready, false);
  assert.equal(whitespaceReport.checklist.find((item) => item.id === "identity_provider").status, "fail");
});

test("fails closed on a production environment missing TLS enforcement", () => {
  const report = validateDeploymentEnvironment({
    isProduction: true,
    env: {
      PORT: "3000",
      TKL_TENANT_ID: "solera",
      TKL_AUDIT_DESTINATION: "stdout",
      TKL_IDENTITY_PROVIDER: "entra-id",
    },
  });
  assert.equal(report.ready, false);
  assert.equal(report.checklist.find((item) => item.id === "transport_security").status, "fail");
});

test("skips production-only controls (never silently passes them) outside production", () => {
  const report = validateDeploymentEnvironment({ isProduction: false, env: {} });
  assert.equal(report.ready, true);
  assert.equal(report.checklist.find((item) => item.id === "identity_provider").status, "skipped");
  assert.equal(report.checklist.find((item) => item.id === "identity_verifier").status, "skipped");
  assert.equal(report.checklist.find((item) => item.id === "transport_security").status, "skipped");
  assert.equal(report.checklist.find((item) => item.id === "secret_resolution").status, "skipped");
});

test("fails closed on an invalid PORT in any environment", () => {
  const report = validateDeploymentEnvironment({ isProduction: false, env: { PORT: "not-a-port" } });
  assert.equal(report.ready, false);
  assert.equal(report.checklist.find((item) => item.id === "port").status, "fail");

  const partialNumeric = validateDeploymentEnvironment({ isProduction: false, env: { PORT: "3000abc" } });
  assert.equal(partialNumeric.ready, false);
  assert.equal(partialNumeric.checklist.find((item) => item.id === "port").status, "fail");
});

test("verifies enabled-plugin credential references resolve in production", () => {
  const productConfig = {
    enabledPlugins: ["connector.github"],
    credentialRefs: {
      "connector.jira": "secret://jira/fl-titling",
      "connector.github": "secret://github/fl-titling",
    },
  };
  const failing = validateDeploymentEnvironment({
    isProduction: true,
    productConfig,
    env: {
      PORT: "3000",
      TKL_TENANT_ID: "solera",
      TKL_AUDIT_DESTINATION: "stdout",
      TKL_IDENTITY_PROVIDER: "entra-id",
      TKL_REQUIRE_TLS: "true",
    },
  });
  assert.equal(failing.ready, false);
  assert.match(failing.checklist.find((item) => item.id === "secret_resolution").detail, /connector\.github/);

  const passing = validateDeploymentEnvironment({
    isProduction: true,
    productConfig,
    identityVerifier: async () => ({ sub: "carlos@solera.com" }),
    env: {
      PORT: "3000",
      TKL_TENANT_ID: "solera",
      TKL_AUDIT_DESTINATION: "stdout",
      TKL_IDENTITY_PROVIDER: "entra-id",
      TKL_REQUIRE_TLS: "true",
      TKL_SECRET__GITHUB__FL_TITLING: "token-value",
    },
  });
  assert.equal(passing.ready, true);
});

test("fails closed in production when an enabled plugin lacks a credential reference definition", () => {
  const report = validateDeploymentEnvironment({
    isProduction: true,
    productConfig: {
      enabledPlugins: ["connector.github"],
      credentialRefs: {},
    },
    env: {
      PORT: "3000",
      TKL_TENANT_ID: "solera",
      TKL_AUDIT_DESTINATION: "stdout",
      TKL_IDENTITY_PROVIDER: "entra-id",
      TKL_REQUIRE_TLS: "true",
      TKL_SECRET__GITHUB__FL_TITLING: "token-value",
    },
  });
  assert.equal(report.ready, false);
  assert.equal(report.checklist.find((item) => item.id === "secret_resolution").status, "fail");
});

test("ignores credential references for plugins that are not enabled", () => {
  const report = validateDeploymentEnvironment({
    isProduction: true,
    productConfig: {
      enabledPlugins: [],
      credentialRefs: { "connector.jira": "secret://jira/fl-titling" },
    },
    env: {
      PORT: "3000",
      TKL_TENANT_ID: "solera",
      TKL_AUDIT_DESTINATION: "stdout",
      TKL_IDENTITY_PROVIDER: "entra-id",
      TKL_REQUIRE_TLS: "true",
    },
  });
  assert.equal(report.checklist.find((item) => item.id === "secret_resolution").status, "pass");
});
