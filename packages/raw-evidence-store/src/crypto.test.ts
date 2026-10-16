import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  EnvelopeIntegrityError,
  InvalidKeyMaterialError,
  UnsupportedEnvelopeVersionError,
  assertEnvelopeScope,
  assertEnvelopeShape,
  assertSupportedEnvelopeVersion,
  assertSupportedSchemaVersion,
  decryptEnvelope,
  encryptEnvelope,
  normalizeKeyMaterial,
  resolveKeyMaterial,
} from "./crypto.ts";

function key(): Buffer {
  return randomBytes(32);
}

test("round-trips content through an authenticated AES-256-GCM envelope", () => {
  const content = { records: [{ idempotencyKey: "jira:STT-1:1" }], checkpoints: {}, history: [] };
  const envelope = encryptEnvelope(content, key(), {
    tenantId: "solera",
    productId: "fl-titling",
    schemaVersion: 1,
    keyRef: "secret://raw-evidence/fl-titling",
  });

  assert.equal(envelope.envelopeVersion, 1);
  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.equal(Buffer.from(envelope.iv, "base64").length, 12);
  assert.equal(Buffer.from(envelope.authTag, "base64").length, 16);
});

test("decrypts with the same key and rejects the wrong key", () => {
  const content = { records: [], checkpoints: {}, history: [] };
  const correctKey = key();
  const envelope = encryptEnvelope(content, correctKey, {
    tenantId: "solera",
    productId: "fl-titling",
    schemaVersion: 1,
    keyRef: "secret://raw-evidence/fl-titling",
  });

  assert.deepEqual(decryptEnvelope(envelope, correctKey), content);
  assert.throws(() => decryptEnvelope(envelope, key()), EnvelopeIntegrityError);
});

test("fails closed when authenticated metadata is tampered after encryption", () => {
  const correctKey = key();
  const envelope = encryptEnvelope(
    { records: [], checkpoints: {}, history: [] },
    correctKey,
    { tenantId: "solera", productId: "fl-titling", schemaVersion: 1, keyRef: "secret://raw-evidence/fl-titling" },
  );

  const tampered = { ...envelope, productId: "other-product" };
  assert.throws(() => decryptEnvelope(tampered, correctKey), EnvelopeIntegrityError);
});

test("fails closed when ciphertext bytes are tampered", () => {
  const correctKey = key();
  const envelope = encryptEnvelope(
    { records: [], checkpoints: {}, history: [] },
    correctKey,
    { tenantId: "solera", productId: "fl-titling", schemaVersion: 1, keyRef: "secret://raw-evidence/fl-titling" },
  );
  const ciphertextBytes = Buffer.from(envelope.ciphertext, "base64");
  ciphertextBytes[0] ^= 0xff;
  const tampered = { ...envelope, ciphertext: ciphertextBytes.toString("base64") };

  assert.throws(() => decryptEnvelope(tampered, correctKey), EnvelopeIntegrityError);
});

test("ciphertext never contains the plaintext payload or scope-identifying content", () => {
  const secretMarker = "SECRET-PAYLOAD-MARKER-tenant-alpha-credential-xyz";
  const envelope = encryptEnvelope(
    { records: [{ payload: secretMarker }], checkpoints: {}, history: [] },
    key(),
    { tenantId: "solera", productId: "fl-titling", schemaVersion: 1, keyRef: "secret://raw-evidence/fl-titling" },
  );

  const serialized = JSON.stringify(envelope);
  assert.doesNotMatch(serialized, /SECRET-PAYLOAD-MARKER/);
});

test("assertSupportedEnvelopeVersion rejects a future envelope version", () => {
  const envelope = encryptEnvelope(
    { records: [], checkpoints: {}, history: [] },
    key(),
    { tenantId: "solera", productId: "fl-titling", schemaVersion: 1, keyRef: "secret://raw-evidence/fl-titling" },
  );
  assert.throws(
    () => assertSupportedEnvelopeVersion({ ...envelope, envelopeVersion: 99 }),
    UnsupportedEnvelopeVersionError,
  );
});

test("assertSupportedSchemaVersion rejects a future schema version", () => {
  const envelope = encryptEnvelope(
    { records: [], checkpoints: {}, history: [] },
    key(),
    { tenantId: "solera", productId: "fl-titling", schemaVersion: 99, keyRef: "secret://raw-evidence/fl-titling" },
  );
  assert.throws(() => assertSupportedSchemaVersion(envelope, 1), UnsupportedEnvelopeVersionError);
});

test("assertEnvelopeScope rejects a scope mismatch before decryption is attempted", () => {
  const envelope = encryptEnvelope(
    { records: [], checkpoints: {}, history: [] },
    key(),
    { tenantId: "solera", productId: "fl-titling", schemaVersion: 1, keyRef: "secret://raw-evidence/fl-titling" },
  );
  assert.throws(() => assertEnvelopeScope(envelope, "solera", "other-product"), /does not match/);
});

test("assertEnvelopeShape rejects malformed or incomplete envelopes", () => {
  assert.throws(() => assertEnvelopeShape(null), EnvelopeIntegrityError);
  assert.throws(() => assertEnvelopeShape({ envelopeVersion: 1 }), EnvelopeIntegrityError);
});

test("normalizeKeyMaterial requires exactly 32 bytes and rejects other lengths", () => {
  assert.equal(normalizeKeyMaterial(Buffer.alloc(32, 7)).length, 32);
  assert.equal(normalizeKeyMaterial(randomBytes(32).toString("base64")).length, 32);
  assert.throws(() => normalizeKeyMaterial(Buffer.alloc(16)), InvalidKeyMaterialError);
  assert.throws(() => normalizeKeyMaterial(""), InvalidKeyMaterialError);
  assert.throws(() => normalizeKeyMaterial(42 as never), InvalidKeyMaterialError);
});

test("resolveKeyMaterial fails closed on a missing or throwing resolver, never falling back to plaintext", async () => {
  await assert.rejects(
    () => resolveKeyMaterial(undefined as never, "secret://x", { tenantId: "t", productId: "p" }),
    InvalidKeyMaterialError,
  );
  await assert.rejects(
    () => resolveKeyMaterial(() => { throw new Error("vault unreachable"); }, "secret://x", {
      tenantId: "t",
      productId: "p",
    }),
    InvalidKeyMaterialError,
  );
  await assert.rejects(
    () => resolveKeyMaterial(() => undefined as never, "secret://x", { tenantId: "t", productId: "p" }),
    InvalidKeyMaterialError,
  );
});

test("resolveKeyMaterial supports an async resolver returning valid key material", async () => {
  const material = randomBytes(32);
  const resolved = await resolveKeyMaterial(
    async (keyRef) => {
      assert.equal(keyRef, "secret://raw-evidence/fl-titling");
      return material;
    },
    "secret://raw-evidence/fl-titling",
    { tenantId: "solera", productId: "fl-titling" },
  );
  assert.deepEqual(resolved, material);
});
