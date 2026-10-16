import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { stableJson } from "@tkl/contracts";

/**
 * Durable-encryption primitives for `ING-105`. Every snapshot written to disk is
 * AES-256-GCM encrypted with a random 96-bit IV. The envelope's non-secret
 * metadata (envelope/schema version, tenant, product, key reference) is bound
 * into the authentication tag as additional authenticated data (AAD), so
 * tampering with those visible fields fails decryption even though they are
 * never encrypted themselves.
 *
 * This module never reads a key from configuration and never falls back to
 * plaintext: callers must inject a `KeyResolver` that returns key material at
 * runtime (for example backed by a secret manager or KMS). There is no secret
 * manager implementation here; see the package README for integration
 * guidance.
 */

export const ENCRYPTION_ALGORITHM = "aes-256-gcm" as const;
export const ENVELOPE_VERSION = 1 as const;
export const IV_LENGTH_BYTES = 12; // 96-bit IV, required/recommended size for GCM.
export const KEY_LENGTH_BYTES = 32; // AES-256 key.

export type KeyMaterial = string | Buffer | Uint8Array;

/**
 * Resolves a key reference (for example "secret://raw-evidence/fl-titling") to
 * raw AES-256 key material. May be synchronous or asynchronous. The resolved
 * key must never be logged, persisted, or attached to a thrown error.
 */
export type KeyResolver = (
  keyRef: string,
  scope: { tenantId: string; productId: string },
) => KeyMaterial | Promise<KeyMaterial>;

export interface EnvelopeMetadata {
  envelopeVersion: number;
  algorithm: string;
  tenantId: string;
  productId: string;
  schemaVersion: number;
  keyRef: string;
}

export interface EncryptedEnvelope extends EnvelopeMetadata {
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** Raised when key material is missing, the wrong length, or otherwise unusable. */
export class InvalidKeyMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKeyMaterialError";
  }
}

/**
 * Raised when a durable/temp envelope fails authenticated decryption: wrong
 * key, corruption, or tampering of ciphertext or authenticated metadata. The
 * message never includes ciphertext, key material, or plaintext content.
 */
export class EnvelopeIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeIntegrityError";
  }
}

/** Raised when an envelope declares an envelope/schema version newer than supported. */
export class UnsupportedEnvelopeVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEnvelopeVersionError";
  }
}

/** Raised when an envelope's authenticated tenant/product scope does not match the caller. */
export class EnvelopeScopeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeScopeMismatchError";
  }
}

export function normalizeKeyMaterial(material: KeyMaterial): Buffer {
  let buffer: Buffer;
  if (typeof material === "string") {
    if (material.length === 0) {
      throw new InvalidKeyMaterialError("Encryption key material must not be an empty string");
    }
    buffer = Buffer.from(material, "base64");
  } else if (material instanceof Uint8Array) {
    buffer = Buffer.from(material);
  } else {
    throw new InvalidKeyMaterialError(
      "Encryption key material must be a base64 string, Buffer, or Uint8Array",
    );
  }
  if (buffer.length !== KEY_LENGTH_BYTES) {
    throw new InvalidKeyMaterialError(
      `Encryption key material must decode to exactly ${KEY_LENGTH_BYTES} bytes for AES-256-GCM`,
    );
  }
  return buffer;
}

/** Encrypts an arbitrary JSON-serializable snapshot into a versioned, authenticated envelope. */
export function encryptEnvelope(
  content: unknown,
  key: Buffer,
  metadata: Omit<EnvelopeMetadata, "envelopeVersion" | "algorithm">,
): EncryptedEnvelope {
  const envelopeMetadata: EnvelopeMetadata = {
    envelopeVersion: ENVELOPE_VERSION,
    algorithm: ENCRYPTION_ALGORITHM,
    ...metadata,
  };
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(stableJson(envelopeMetadata as never), "utf-8"));
  const plaintext = Buffer.from(JSON.stringify(content), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ...envelopeMetadata,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypts and authenticates an envelope. Throws `EnvelopeIntegrityError` for any
 * corruption, wrong key, or tampering of ciphertext/metadata detected by the GCM
 * authentication tag. Callers should check scope and version with
 * `assertEnvelopeScope`/`assertSupportedEnvelopeVersion` first for cheaper,
 * clearer failures, but authentication is enforced here regardless.
 */
export function decryptEnvelope(envelope: EncryptedEnvelope, key: Buffer): unknown {
  const { iv, authTag, ciphertext, ...metadata } = envelope;
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    decipher.setAAD(Buffer.from(stableJson(metadata as never), "utf-8"));
    plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  } catch {
    throw new EnvelopeIntegrityError(
      "Raw evidence snapshot failed integrity verification (tampered, corrupt, or wrong key)",
    );
  }
  try {
    return JSON.parse(plaintext.toString("utf-8"));
  } catch {
    throw new EnvelopeIntegrityError("Raw evidence snapshot decrypted to invalid content");
  }
}

export function assertEnvelopeShape(value: unknown): asserts value is EncryptedEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new EnvelopeIntegrityError("Raw evidence snapshot envelope must be an object");
  }
  const candidate = value as Record<string, unknown>;
  for (const field of [
    "envelopeVersion",
    "algorithm",
    "tenantId",
    "productId",
    "schemaVersion",
    "keyRef",
    "iv",
    "authTag",
    "ciphertext",
  ]) {
    if (!(field in candidate)) {
      throw new EnvelopeIntegrityError(`Raw evidence snapshot envelope is missing "${field}"`);
    }
  }
  if (
    typeof candidate.envelopeVersion !== "number"
    || typeof candidate.schemaVersion !== "number"
    || typeof candidate.tenantId !== "string"
    || typeof candidate.productId !== "string"
    || typeof candidate.keyRef !== "string"
    || typeof candidate.algorithm !== "string"
    || typeof candidate.iv !== "string"
    || typeof candidate.authTag !== "string"
    || typeof candidate.ciphertext !== "string"
  ) {
    throw new EnvelopeIntegrityError("Raw evidence snapshot envelope has an invalid field type");
  }
}

export function assertSupportedEnvelopeVersion(envelope: EncryptedEnvelope): void {
  if (envelope.envelopeVersion > ENVELOPE_VERSION) {
    throw new UnsupportedEnvelopeVersionError(
      `Raw evidence snapshot envelope version ${envelope.envelopeVersion} is newer than ` +
        `supported version ${ENVELOPE_VERSION}`,
    );
  }
  if (envelope.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new UnsupportedEnvelopeVersionError(
      `Raw evidence snapshot envelope algorithm "${envelope.algorithm}" is not supported`,
    );
  }
}

export function assertSupportedSchemaVersion(envelope: EncryptedEnvelope, supported: number): void {
  if (envelope.schemaVersion > supported) {
    throw new UnsupportedEnvelopeVersionError(
      `Raw evidence snapshot schema ${envelope.schemaVersion} is newer than supported schema ${supported}`,
    );
  }
}

export function assertEnvelopeScope(
  envelope: EncryptedEnvelope,
  tenantId: string,
  productId: string,
): void {
  if (envelope.tenantId !== tenantId || envelope.productId !== productId) {
    throw new EnvelopeScopeMismatchError(
      `Raw evidence snapshot scope ${envelope.tenantId}/${envelope.productId} does not match ` +
        `${tenantId}/${productId}`,
    );
  }
}

export async function resolveKeyMaterial(
  resolveKey: KeyResolver,
  keyRef: string,
  scope: { tenantId: string; productId: string },
): Promise<Buffer> {
  if (typeof resolveKey !== "function") {
    throw new InvalidKeyMaterialError("A key resolver function is required");
  }
  if (typeof keyRef !== "string" || keyRef.length === 0) {
    throw new InvalidKeyMaterialError("keyRef is required to resolve encryption key material");
  }
  let material: KeyMaterial;
  try {
    material = await resolveKey(keyRef, scope);
  } catch {
    throw new InvalidKeyMaterialError("Key resolver failed to resolve encryption key material");
  }
  if (material === undefined || material === null) {
    throw new InvalidKeyMaterialError("Key resolver returned no key material");
  }
  return normalizeKeyMaterial(material);
}
