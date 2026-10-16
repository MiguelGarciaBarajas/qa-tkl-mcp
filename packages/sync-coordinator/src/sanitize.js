// `@tkl/observability` (and `@tkl/ops`) publish no package entry point, so
// the repository convention -- used by `apps/api`, `apps/mcp-gateway`, and
// the existing integration tests -- is a relative import of their source.
import { redact } from "../../observability/src/index.js";

/**
 * Sanitization guard for everything OPS-101 emits (run summaries, retention
 * reports, audit events, health snapshots).
 *
 * The coordinator builds these objects field by field from identifiers,
 * counts, timestamps, and fixed enum strings, so in principle nothing
 * sensitive can reach them. This module is the enforcement that the "in
 * principle" stays true as the code changes: every emitted object is passed
 * through `@tkl/observability`'s `redact` (which masks credential-shaped
 * keys) and then asserted to contain no credential references, no URLs, and
 * no filesystem paths, which are the three shapes most likely to leak in
 * through a future field or a connector-supplied value such as a checkpoint
 * cursor.
 */

const CREDENTIAL_LIKE = /(secret:\/\/|env:\/\/|bearer\s|authorization)/i;
const URL_LIKE = /[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const WINDOWS_PATH_LIKE = /[A-Za-z]:[\\/]/;
const PATH_SEPARATOR_LIKE = /[\\/]/;

export class SanitizationError extends Error {
  constructor(path, reason) {
    super(`Emitted operations data at "${path}" is not sanitized: ${reason}`);
    this.name = "SanitizationError";
  }
}

function assertSafeString(value, path) {
  if (CREDENTIAL_LIKE.test(value)) {
    throw new SanitizationError(path, "contains a credential-shaped value");
  }
  if (URL_LIKE.test(value)) {
    throw new SanitizationError(path, "contains a URL");
  }
  if (WINDOWS_PATH_LIKE.test(value) || PATH_SEPARATOR_LIKE.test(value)) {
    throw new SanitizationError(path, "contains a filesystem path separator");
  }
}

function walk(value, path) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    assertSafeString(value, path);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") {
    throw new SanitizationError(path, `unsupported value type "${typeof value}"`);
  }
  for (const [key, entry] of Object.entries(value)) {
    assertSafeString(key, `${path}.${key}`);
    walk(entry, `${path}.${key}`);
  }
}

/**
 * Redacts credential-shaped keys and then fails closed if anything
 * credential-, URL-, or path-shaped survives. Returns the redacted value so
 * callers always emit the checked object rather than the original.
 */
export function sanitizeOperationsData(value, path = "data") {
  const redacted = redact(value);
  walk(redacted, path);
  return redacted;
}
