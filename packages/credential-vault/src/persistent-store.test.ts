import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  PersistentCredentialVault,
  createPersistentCredentialVault,
} from "./persistent-store.ts";
import { EnvelopeIntegrityError } from "./crypto.ts";
import { CredentialVaultNotFoundError, CredentialVaultValidationError } from "./store.ts";

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "tkl-credential-vault-"));
  return Promise.resolve()
    .then(() => run(directory))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}

function makeKeyResolver(key) {
  return async () => key;
}

const baseOptions = (directory, key) => ({
  dataDirectory: directory,
  tenantId: "solera",
  productId: "fl-titling",
  keyRef: "secret://credential-vault/fl-titling",
  resolveKey: makeKeyResolver(key),
});

const jiraInput = {
  tenantId: "solera",
  productId: "fl-titling",
  source: "jira",
  ownerSubject: "qa-lead@example.com",
  config: { baseUrl: "https://jira.example.com", allowedProjects: ["STT"] },
};

test("upsertConnection persists durably and the on-disk file never contains the plaintext credential", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "super-secret-token" });

    const raw = readFileSync(store.storagePath, "utf-8");
    assert.equal(raw.includes("super-secret-token"), false, "raw file must never contain the credential");
    assert.equal(raw.includes("qa-lead@example.com"), false, "raw file must be fully encrypted, not just the credential field");

    const parsed = JSON.parse(raw);
    assert.equal(parsed.algorithm, "aes-256-gcm");
    assert.ok(typeof parsed.ciphertext === "string" && parsed.ciphertext.length > 0);
    assert.ok(typeof parsed.iv === "string" && parsed.iv.length > 0);
    assert.ok(typeof parsed.authTag === "string" && parsed.authTag.length > 0);
  }));

test("no temp file is left behind after a successful mutation", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "token" });
    assert.equal(existsSync(`${store.storagePath}.tmp`), false);
  }));

test("data (including the credential) survives a simulated restart", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "super-secret-token" });
    await store.updateStatus({
      tenantId: "solera",
      productId: "fl-titling",
      source: "jira",
      status: "connected",
      lastValidatedAt: "2026-01-01T00:00:00.000Z",
    });

    const restarted = await createPersistentCredentialVault(baseOptions(directory, key));
    const metadata = restarted.get("solera", "fl-titling", "jira");
    assert.equal(metadata.status, "connected");
    assert.equal(metadata.hasCredential, true);
    assert.equal(await restarted.resolveCredential("solera", "fl-titling", "jira"), "super-secret-token");
  }));

test("scope isolation: different tenant/product directories never leak records into each other", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const storeA = await createPersistentCredentialVault({
      ...baseOptions(directory, key),
      tenantId: "solera",
      productId: "fl-titling",
    });
    const storeB = await createPersistentCredentialVault({
      ...baseOptions(directory, key),
      tenantId: "solera",
      productId: "other-product",
    });

    await storeA.upsertConnection({ ...jiraInput, credential: "token-a" });
    await storeB.upsertConnection({ ...jiraInput, productId: "other-product", credential: "token-b" });

    assert.notEqual(storeA.storagePath, storeB.storagePath);
    assert.equal(storeA.list("solera", "fl-titling").length, 1);
    assert.equal(storeB.list("solera", "other-product").length, 1);
    assert.equal(await storeA.resolveCredential("solera", "fl-titling", "jira"), "token-a");
    assert.equal(await storeB.resolveCredential("solera", "other-product", "jira"), "token-b");
  }));

test("restart with the wrong key fails closed with EnvelopeIntegrityError", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const wrongKey = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "token" });

    await assert.rejects(
      () => createPersistentCredentialVault(baseOptions(directory, wrongKey)),
      EnvelopeIntegrityError,
    );
  }));

test("tampering with the on-disk ciphertext fails closed with EnvelopeIntegrityError", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "token" });

    const envelope = JSON.parse(readFileSync(store.storagePath, "utf-8"));
    envelope.ciphertext = Buffer.from("tampered-bytes").toString("base64");
    writeFileSync(store.storagePath, JSON.stringify(envelope));

    await assert.rejects(
      () => createPersistentCredentialVault(baseOptions(directory, key)),
      EnvelopeIntegrityError,
    );
  }));

test("tampering with authenticated envelope metadata fails closed with EnvelopeIntegrityError", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "token" });

    const envelope = JSON.parse(readFileSync(store.storagePath, "utf-8"));
    envelope.keyRef = "secret://credential-vault/tampered";
    writeFileSync(store.storagePath, JSON.stringify(envelope));

    await assert.rejects(() => createPersistentCredentialVault(baseOptions(directory, key)));
  }));

test("corrupt (non-JSON) durable snapshot fails closed instead of starting empty", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "token" });

    writeFileSync(store.storagePath, "{ not valid json ][");

    await assert.rejects(() => createPersistentCredentialVault(baseOptions(directory, key)));
  }));

test("corrupt (truncated) durable snapshot fails closed", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "token" });

    const raw = readFileSync(store.storagePath, "utf-8");
    writeFileSync(store.storagePath, raw.slice(0, Math.floor(raw.length / 2)));

    await assert.rejects(() => createPersistentCredentialVault(baseOptions(directory, key)));
  }));

test("list/get never expose the credential field on a durable vault either", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "super-secret-token" });

    const got = store.get("solera", "fl-titling", "jira");
    const listed = store.list("solera", "fl-titling");
    assert.equal(Object.prototype.hasOwnProperty.call(got, "credential"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(listed[0], "credential"), false);
    assert.equal(JSON.stringify(got).includes("super-secret-token"), false);
    assert.equal(JSON.stringify(listed).includes("super-secret-token"), false);
  }));

test("full lifecycle: connect, validate, reconnect with rotated credential, then disconnect", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));

    const created = await store.upsertConnection({ ...jiraInput, credential: "token-1" });
    assert.equal(created.status, "validating");

    const validated = await store.updateStatus({
      tenantId: "solera",
      productId: "fl-titling",
      source: "jira",
      status: "connected",
      connectedAt: "2026-01-01T00:00:00.000Z",
      lastValidatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(validated.status, "connected");
    assert.equal(await store.resolveCredential("solera", "fl-titling", "jira"), "token-1");

    const rotated = await store.upsertConnection({ ...jiraInput, credential: "token-2" });
    assert.equal(rotated.status, "validating", "rotating the credential must force revalidation");
    assert.equal(await store.resolveCredential("solera", "fl-titling", "jira"), "token-2");

    const reconnected = await store.updateStatus({
      tenantId: "solera",
      productId: "fl-titling",
      source: "jira",
      status: "connected",
    });
    assert.equal(reconnected.status, "connected");

    const disconnected = await store.disconnect({ tenantId: "solera", productId: "fl-titling", source: "jira" });
    assert.equal(disconnected.status, "not-connected");
    assert.equal(disconnected.hasCredential, false);
    assert.equal(await store.resolveCredential("solera", "fl-titling", "jira"), undefined);

    // Survives restart in its final, disconnected state.
    const restarted = await createPersistentCredentialVault(baseOptions(directory, key));
    const metadata = restarted.get("solera", "fl-titling", "jira");
    assert.equal(metadata.status, "not-connected");
    assert.equal(metadata.hasCredential, false);
  }));

test("updateStatus on a durable vault requires an existing record", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
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
  }));

test("a failed durable write rolls back in-memory state and never advances the visible record", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const failingFsOperations = {
      async writeFileDurable() {
        throw new Error("simulated disk failure");
      },
      async rename() {
        throw new Error("should not be reached");
      },
      async syncDirectory() {},
      async removeTempFile() {},
    };
    const store = await createPersistentCredentialVault({
      ...baseOptions(directory, key),
      fsOperations: failingFsOperations,
    });

    await assert.rejects(() => store.upsertConnection({ ...jiraInput, credential: "token" }));
    assert.equal(store.get("solera", "fl-titling", "jira"), undefined);
    assert.equal(existsSync(store.storagePath), false);
  }));

test("concurrent mutations on one instance are serialized: no lost updates, no corrupted file", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "token" });

    const statuses = ["validating", "connected", "syncing", "stale", "error", "connected"];
    await Promise.all(
      statuses.map((status, index) =>
        store.updateStatus({
          tenantId: "solera",
          productId: "fl-titling",
          source: "jira",
          status,
          lastSyncAt: `2026-01-0${(index % 9) + 1}T00:00:00.000Z`,
        }),
      ),
    );

    // Whichever order they settled in, the file must always be valid/decryptable
    // and the in-memory + on-disk final status must agree.
    const finalStatus = store.get("solera", "fl-titling", "jira").status;
    assert.ok(statuses.includes(finalStatus));

    const restarted = await createPersistentCredentialVault(baseOptions(directory, key));
    assert.equal(restarted.get("solera", "fl-titling", "jira").status, finalStatus);
  }));

test("concurrent upserts across different sources in the same scope all land", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));

    await Promise.all([
      store.upsertConnection({ ...jiraInput, source: "jira", credential: "jira-token" }),
      store.upsertConnection({
        ...jiraInput,
        source: "github",
        config: { repositories: ["org/repo"] },
        credential: "gh-token",
      }),
      store.upsertConnection({
        ...jiraInput,
        source: "testrail",
        config: { baseUrl: "https://testrail.example.com", projectId: "1", suiteIds: ["1"] },
        credential: "tr-token",
      }),
    ]);

    assert.equal(store.list("solera", "fl-titling").length, 3);
    assert.equal(await store.resolveCredential("solera", "fl-titling", "jira"), "jira-token");
    assert.equal(await store.resolveCredential("solera", "fl-titling", "github"), "gh-token");
    assert.equal(await store.resolveCredential("solera", "fl-titling", "testrail"), "tr-token");

    const restarted = await createPersistentCredentialVault(baseOptions(directory, key));
    assert.equal(restarted.list("solera", "fl-titling").length, 3);
  }));

test("a crash-before-rename temp file (valid content) is promoted safely on restart", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "token" });

    // Simulate a crash right after the temp write but before the durable
    // file existed at all: move the durable file to become the "leftover" temp.
    const tempPath = `${store.storagePath}.tmp`;
    rmSync(tempPath, { force: true });
    const durableBytes = readFileSync(store.storagePath);
    rmSync(store.storagePath);
    writeFileSync(tempPath, durableBytes);

    const recovered = await createPersistentCredentialVault(baseOptions(directory, key));
    assert.equal(existsSync(tempPath), false);
    assert.equal(existsSync(recovered.storagePath), true);
    assert.equal(await recovered.resolveCredential("solera", "fl-titling", "jira"), "token");
  }));

test("a stale temp file next to a valid durable snapshot is discarded, keeping the durable snapshot", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await store.upsertConnection({ ...jiraInput, credential: "token" });

    const tempPath = `${store.storagePath}.tmp`;
    writeFileSync(tempPath, "garbage-leftover-bytes-from-a-previous-crash");

    const recovered = await createPersistentCredentialVault(baseOptions(directory, key));
    assert.equal(existsSync(tempPath), false);
    assert.equal(await recovered.resolveCredential("solera", "fl-titling", "jira"), "token");
  }));

test("PersistentCredentialVault rejects a keyRef that does not match the secret://|env:// convention", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    assert.throws(() => {
      // eslint-disable-next-line no-new
      new PersistentCredentialVault({ ...baseOptions(directory, key), keyRef: "not-a-valid-ref" });
    }, TypeError);
  }));

test("methods throw before initialize() has completed", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = new PersistentCredentialVault(baseOptions(directory, key));
    assert.throws(() => store.get("solera", "fl-titling", "jira"));
    await assert.rejects(() => store.upsertConnection({ ...jiraInput, credential: "token" }));
    await store.initialize();
    assert.doesNotThrow(() => store.get("solera", "fl-titling", "jira"));
  }));

test("validation still runs on a durable vault (rejects secret-like config keys)", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await createPersistentCredentialVault(baseOptions(directory, key));
    await assert.rejects(
      () => store.upsertConnection({ ...jiraInput, config: { apiKey: "test-value" } }),
      CredentialVaultValidationError,
    );
    assert.equal(store.get("solera", "fl-titling", "jira"), undefined);
  }));
