import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  EnvelopeIntegrityError,
  EnvelopeScopeMismatchError,
  InvalidKeyMaterialError,
  UnsupportedEnvelopeVersionError,
  assertEnvelopeScope,
  assertSupportedEnvelopeVersion,
  assertSupportedSchemaVersion,
  decryptEnvelope,
  encryptEnvelope,
  normalizeKeyMaterial,
  resolveKeyMaterial,
} from "./crypto.ts";

const scope = { tenantId: "solera", productId: "fl-titling" };

test("encryptEnvelope/decryptEnvelope round-trips arbitrary JSON content", () => {
  const key = randomBytes(32);
  const content = { records: [{ source: "jira", credential: "super-secret-token" }] };
  const envelope = encryptEnvelope(content, key, {
    tenantId: scope.tenantId,
    productId: scope.productId,
    schemaVersion: 1,
    keyRef: "secret://credential-vault/fl-titling",
  });

  assert.deepEqual(decryptEnvelope(envelope, key), content);
});

test("the encrypted envelope never contains the plaintext credential", () => {
  const key = randomBytes(32);
  const envelope = encryptEnvelope(
    { credential: "super-secret-token" },
    key,
    { tenantId: scope.tenantId, productId: scope.productId, schemaVersion: 1, keyRef: "secret://x" },
  );
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes("super-secret-token"), false);
});

test("decryptEnvelope throws EnvelopeIntegrityError for the wrong key", () => {
  const key = randomBytes(32);
  const wrongKey = randomBytes(32);
  const envelope = encryptEnvelope(
    { credential: "token" },
    key,
    { tenantId: scope.tenantId, productId: scope.productId, schemaVersion: 1, keyRef: "secret://x" },
  );
  assert.throws(() => decryptEnvelope(envelope, wrongKey), EnvelopeIntegrityError);
});

test("decryptEnvelope throws EnvelopeIntegrityError for tampered ciphertext", () => {
  const key = randomBytes(32);
  const envelope = encryptEnvelope(
    { credential: "token" },
    key,
    { tenantId: scope.tenantId, productId: scope.productId, schemaVersion: 1, keyRef: "secret://x" },
  );
  const tampered = { ...envelope, ciphertext: Buffer.from("tampered-bytes-here").toString("base64") };
  assert.throws(() => decryptEnvelope(tampered, key), EnvelopeIntegrityError);
});

test("decryptEnvelope throws EnvelopeIntegrityError when authenticated metadata is tampered", () => {
  const key = randomBytes(32);
  const envelope = encryptEnvelope(
    { credential: "token" },
    key,
    { tenantId: scope.tenantId, productId: scope.productId, schemaVersion: 1, keyRef: "secret://x" },
  );
  // tenantId is bound into AAD, so silently editing it must fail authentication.
  const tampered = { ...envelope, tenantId: "attacker-tenant" };
  assert.throws(() => decryptEnvelope(tampered, key), EnvelopeIntegrityError);
});

test("assertEnvelopeScope throws EnvelopeScopeMismatchError on a scope mismatch", () => {
  const key = randomBytes(32);
  const envelope = encryptEnvelope(
    { credential: "token" },
    key,
    { tenantId: "solera", productId: "fl-titling", schemaVersion: 1, keyRef: "secret://x" },
  );
  assert.throws(() => assertEnvelopeScope(envelope, "other-tenant", "fl-titling"), EnvelopeScopeMismatchError);
});

test("assertSupportedEnvelopeVersion throws for a version newer than supported", () => {
  const key = randomBytes(32);
  const envelope = encryptEnvelope(
    { credential: "token" },
    key,
    { tenantId: "solera", productId: "fl-titling", schemaVersion: 1, keyRef: "secret://x" },
  );
  assert.throws(
    () => assertSupportedEnvelopeVersion({ ...envelope, envelopeVersion: 999 }),
    UnsupportedEnvelopeVersionError,
  );
});

test("assertSupportedSchemaVersion throws for a schema newer than supported", () => {
  const key = randomBytes(32);
  const envelope = encryptEnvelope(
    { credential: "token" },
    key,
    { tenantId: "solera", productId: "fl-titling", schemaVersion: 5, keyRef: "secret://x" },
  );
  assert.throws(() => assertSupportedSchemaVersion(envelope, 1), UnsupportedEnvelopeVersionError);
});

test("normalizeKeyMaterial accepts a 32-byte Buffer/base64 string and rejects the wrong length", () => {
  const key = randomBytes(32);
  assert.deepEqual(normalizeKeyMaterial(key), key);
  assert.deepEqual(normalizeKeyMaterial(key.toString("base64")), key);
  assert.throws(() => normalizeKeyMaterial(randomBytes(16)), InvalidKeyMaterialError);
  assert.throws(() => normalizeKeyMaterial(""), InvalidKeyMaterialError);
});

test("resolveKeyMaterial invokes the injected resolver with keyRef and scope and normalizes its result", async () => {
  const key = randomBytes(32);
  let seenArgs;
  const resolved = await resolveKeyMaterial(
    (keyRef, resolvedScope) => {
      seenArgs = { keyRef, resolvedScope };
      return key;
    },
    "secret://credential-vault/fl-titling",
    scope,
  );
  assert.deepEqual(resolved, key);
  assert.deepEqual(seenArgs, { keyRef: "secret://credential-vault/fl-titling", resolvedScope: scope });
});

test("resolveKeyMaterial throws InvalidKeyMaterialError when the resolver throws or returns nothing", async () => {
  await assert.rejects(
    () =>
      resolveKeyMaterial(
        () => {
          throw new Error("boom");
        },
        "secret://x",
        scope,
      ),
    InvalidKeyMaterialError,
  );
  await assert.rejects(
    () => resolveKeyMaterial(() => undefined, "secret://x", scope),
    InvalidKeyMaterialError,
  );
});
