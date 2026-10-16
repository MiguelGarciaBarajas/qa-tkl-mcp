import test from "node:test";
import assert from "node:assert/strict";
import {
  CredentialVaultNotFoundError,
  CredentialVaultScopeError,
  CredentialVaultValidationError,
  InMemoryCredentialVault,
} from "./store.ts";

function vault(overrides = {}) {
  let counter = 0;
  return new InMemoryCredentialVault({
    tenantId: "solera",
    productId: "fl-titling",
    now: () => `2026-01-0${(counter += 1)}T00:00:00.000Z`,
    ...overrides,
  });
}

const baseInput = {
  tenantId: "solera",
  productId: "fl-titling",
  source: "jira",
  ownerSubject: "qa-lead@example.com",
  config: { baseUrl: "https://jira.example.com", allowedProjects: ["STT"] },
};

test("upsertConnection creates a validating record when a credential is supplied and returns sanitized metadata", async () => {
  const store = vault();
  const metadata = await store.upsertConnection({ ...baseInput, credential: "super-secret-token" });

  assert.equal(metadata.status, "validating");
  assert.equal(metadata.hasCredential, true);
  assert.equal(metadata.ownerSubject, "qa-lead@example.com");
  assert.deepEqual(metadata.config, { baseUrl: "https://jira.example.com", allowedProjects: ["STT"] });
  assert.equal(metadata.createdAt, metadata.updatedAt);
  assert.equal("credential" in metadata, false);
});

test("upsertConnection without a credential defaults to not-connected for a new record", async () => {
  const store = vault();
  const metadata = await store.upsertConnection(baseInput);
  assert.equal(metadata.status, "not-connected");
  assert.equal(metadata.hasCredential, false);
});

test("upsertConnection preserves status/timestamps on config-only updates and refreshes updatedAt", async () => {
  const store = vault();
  const created = await store.upsertConnection({ ...baseInput, credential: "token-1" });
  await store.updateStatus({
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    status: "connected",
    lastValidatedAt: "2026-02-01T00:00:00.000Z",
  });

  const updated = await store.upsertConnection({
    ...baseInput,
    ownerSubject: "new-owner@example.com",
  });

  assert.equal(updated.status, "connected", "status must be preserved when no credential/status is given");
  assert.equal(updated.ownerSubject, "new-owner@example.com");
  assert.equal(updated.createdAt, created.createdAt);
  assert.notEqual(updated.updatedAt, created.updatedAt);
  assert.equal(updated.hasCredential, true, "existing credential must survive a config-only update");
});

test("rotating a credential resets status to validating even if not explicitly requested", async () => {
  const store = vault();
  await store.upsertConnection({ ...baseInput, credential: "token-1" });
  await store.updateStatus({
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    status: "connected",
  });
  const rotated = await store.upsertConnection({ ...baseInput, credential: "token-2" });
  assert.equal(rotated.status, "validating");
});

test("list/get never expose a credential field, even implicitly as undefined", async () => {
  const store = vault();
  await store.upsertConnection({ ...baseInput, credential: "super-secret-token" });

  const got = store.get("solera", "fl-titling", "jira");
  const listed = store.list("solera", "fl-titling");

  assert.equal(Object.prototype.hasOwnProperty.call(got, "credential"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(listed[0], "credential"), false);
  assert.equal(JSON.stringify(got).includes("super-secret-token"), false);
  assert.equal(JSON.stringify(listed).includes("super-secret-token"), false);
});

test("resolveCredential returns the raw value for trusted callers only", async () => {
  const store = vault();
  await store.upsertConnection({ ...baseInput, credential: "super-secret-token" });
  assert.equal(await store.resolveCredential("solera", "fl-titling", "jira"), "super-secret-token");
});

test("resolveCredential returns undefined when no credential has ever been stored", async () => {
  const store = vault();
  await store.upsertConnection(baseInput);
  assert.equal(await store.resolveCredential("solera", "fl-titling", "jira"), undefined);
});

test("updateStatus never accepts or mutates the stored credential", async () => {
  const store = vault();
  await store.upsertConnection({ ...baseInput, credential: "super-secret-token" });
  const updated = await store.updateStatus({
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    status: "error",
    error: { code: "http_401", category: "authorization", message: "Token rejected" },
  });

  assert.equal(updated.status, "error");
  assert.deepEqual(updated.error, { code: "http_401", category: "authorization", message: "Token rejected" });
  assert.equal(await store.resolveCredential("solera", "fl-titling", "jira"), "super-secret-token");
  assert.equal("credential" in updated, false);
});

test("updateStatus throws CredentialVaultNotFoundError when no record exists yet", async () => {
  const store = vault();
  await assert.rejects(
    () =>
      store.updateStatus({
        tenantId: "solera",
        productId: "fl-titling",
        source: "jira",
        status: "connected",
      }),
    CredentialVaultNotFoundError,
  );
});

test("disconnect destroys the credential, clears error/connectedAt, and marks not-connected", async () => {
  const store = vault();
  await store.upsertConnection({ ...baseInput, credential: "super-secret-token" });
  await store.updateStatus({
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    status: "connected",
    connectedAt: "2026-01-05T00:00:00.000Z",
    error: { code: "x", category: "provider", message: "stale warning" },
  });

  const disconnected = await store.disconnect({ tenantId: "solera", productId: "fl-titling", source: "jira" });

  assert.equal(disconnected.status, "not-connected");
  assert.equal(disconnected.hasCredential, false);
  assert.equal(disconnected.connectedAt, null);
  assert.equal(disconnected.error, null);
  assert.equal(await store.resolveCredential("solera", "fl-titling", "jira"), undefined);
});

test("disconnect throws CredentialVaultNotFoundError when no record exists yet", async () => {
  const store = vault();
  await assert.rejects(
    () => store.disconnect({ tenantId: "solera", productId: "fl-titling", source: "jira" }),
    CredentialVaultNotFoundError,
  );
});

test("cross-scope calls are rejected with CredentialVaultScopeError", async () => {
  const store = vault();
  await assert.rejects(
    () => store.upsertConnection({ ...baseInput, tenantId: "other-tenant" }),
    CredentialVaultScopeError,
  );
  assert.throws(() => store.get("other-tenant", "fl-titling", "jira"), CredentialVaultScopeError);
  assert.throws(() => store.list("solera", "other-product"), CredentialVaultScopeError);
});

test("two vault instances for different scopes never see each other's records", async () => {
  const storeA = vault();
  const storeB = new InMemoryCredentialVault({ tenantId: "solera", productId: "other-product" });
  await storeA.upsertConnection({ ...baseInput, credential: "token-a" });
  await storeB.upsertConnection({
    ...baseInput,
    productId: "other-product",
    credential: "token-b",
  });

  assert.equal(await storeA.resolveCredential("solera", "fl-titling", "jira"), "token-a");
  assert.equal(await storeB.resolveCredential("solera", "other-product", "jira"), "token-b");
  assert.equal(storeA.list("solera", "fl-titling").length, 1);
  assert.equal(storeB.list("solera", "other-product").length, 1);
});

test("multiple sources within one scope are isolated from each other", async () => {
  const store = vault();
  await store.upsertConnection({ ...baseInput, source: "jira", credential: "jira-token" });
  await store.upsertConnection({ ...baseInput, source: "github", config: { repositories: ["org/repo"] }, credential: "gh-token" });

  assert.equal(await store.resolveCredential("solera", "fl-titling", "jira"), "jira-token");
  assert.equal(await store.resolveCredential("solera", "fl-titling", "github"), "gh-token");
  assert.equal(store.list("solera", "fl-titling").length, 2);
});

test("rejects unsupported source IDs", async () => {
  const store = vault();
  await assert.rejects(
    () => store.upsertConnection({ ...baseInput, source: "slack" }),
    CredentialVaultValidationError,
  );
});

test("rejects unsupported status values", async () => {
  const store = vault();
  await store.upsertConnection(baseInput);
  await assert.rejects(
    () =>
      store.updateStatus({
        tenantId: "solera",
        productId: "fl-titling",
        source: "jira",
        status: "totally-connected",
      }),
    CredentialVaultValidationError,
  );
});

test("validates every documented status value is accepted", async () => {
  const store = vault();
  await store.upsertConnection(baseInput);
  const statuses = [
    "not-connected",
    "validating",
    "connected",
    "syncing",
    "stale",
    "authorization-expired",
    "error",
    "disabled",
  ];
  for (const status of statuses) {
    const result = await store.updateStatus({
      tenantId: "solera",
      productId: "fl-titling",
      source: "jira",
      status,
    });
    assert.equal(result.status, status);
  }
});

test("rejects an empty or over-long ownerSubject", async () => {
  const store = vault();
  await assert.rejects(
    () => store.upsertConnection({ ...baseInput, ownerSubject: "" }),
    CredentialVaultValidationError,
  );
  await assert.rejects(
    () => store.upsertConnection({ ...baseInput, ownerSubject: "x".repeat(321) }),
    CredentialVaultValidationError,
  );
});

test("rejects config values/arrays exceeding length or count limits", async () => {
  const store = vault();
  await assert.rejects(
    () => store.upsertConnection({ ...baseInput, config: { baseUrl: "x".repeat(2049) } }),
    CredentialVaultValidationError,
  );
  await assert.rejects(
    () =>
      store.upsertConnection({
        ...baseInput,
        config: { allowedProjects: Array.from({ length: 101 }, (_, i) => `P${i}`) },
      }),
    CredentialVaultValidationError,
  );
  await assert.rejects(
    () => store.upsertConnection({ ...baseInput, config: { allowedProjects: [] } }),
    CredentialVaultValidationError,
  );
});

test("rejects an over-long credential", async () => {
  const store = vault();
  await assert.rejects(
    () => store.upsertConnection({ ...baseInput, credential: "x".repeat(8193) }),
    CredentialVaultValidationError,
  );
});

for (const secretLikeKey of [
  "apiKey",
  "Authorization",
  "password",
  "privateKey",
  "secretToken",
  "token",
  "credential",
  "API_KEY",
]) {
  test(`rejects secret-like config key "${secretLikeKey}"`, async () => {
    const store = vault();
    await assert.rejects(
      () => store.upsertConnection({ ...baseInput, config: { [secretLikeKey]: "value" } }),
      CredentialVaultValidationError,
    );
  });
}

test("rejects malformed connection error metadata and sanitizes valid error metadata to code/category/message only", async () => {
  const store = vault();
  await store.upsertConnection(baseInput);

  await assert.rejects(
    () =>
      store.updateStatus({
        tenantId: "solera",
        productId: "fl-titling",
        source: "jira",
        status: "error",
        error: { code: "x", category: "not-a-real-category", message: "y" },
      }),
    CredentialVaultValidationError,
  );

  const updated = await store.updateStatus({
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    status: "error",
    error: {
      code: "http_500",
      category: "provider",
      message: "Upstream error",
      // Extra fields below must never survive sanitization.
      stack: "Error: boom\n at internal (secret/path.js:1:1)",
      responseBody: { token: "should-never-be-stored" },
    },
  });

  assert.deepEqual(updated.error, { code: "http_500", category: "provider", message: "Upstream error" });
  assert.equal("stack" in updated.error, false);
  assert.equal("responseBody" in updated.error, false);
});

test("mutating a returned metadata object never affects the store's internal state", async () => {
  const store = vault();
  await store.upsertConnection({ ...baseInput, credential: "token" });
  const metadata = store.get("solera", "fl-titling", "jira");
  metadata.config.baseUrl = "https://tampered.example.com";
  metadata.ownerSubject = "attacker@example.com";

  const fresh = store.get("solera", "fl-titling", "jira");
  assert.equal(fresh.config.baseUrl, "https://jira.example.com");
  assert.equal(fresh.ownerSubject, "qa-lead@example.com");
});
