export const MAX_MCP_BODY_BYTES = 1024 * 1024;

export class SecurityError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "SecurityError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function securityHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}

export function requireJsonContentType(contentType) {
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new SecurityError(415, "unsupported_media_type", "MCP requests must use application/json.");
  }
}

export function requireAuthorizationHeader(authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new SecurityError(401, "unauthenticated", "Authentication is required.");
  }
}

export function assertBodySize(size) {
  if (size > MAX_MCP_BODY_BYTES) {
    throw new SecurityError(413, "payload_too_large", "MCP request payload is too large.");
  }
}

/**
 * Fixed-window rate limiter keyed by an arbitrary caller-supplied string (typically
 * `${tenantId}:${subject}` or `${tenantId}:${productId}`). Bounds request volume per
 * key without external infrastructure; production deployments may replace this with a
 * shared-store limiter while preserving the same `assertWithinLimit` boundary.
 */
export function createRateLimiter({
  limit = 60,
  windowMs = 60_000,
  now = () => Date.now()
} = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("limit must be a positive integer");
  }
  if (!Number.isInteger(windowMs) || windowMs < 1) {
    throw new TypeError("windowMs must be a positive integer");
  }

  const windows = new Map();

  return {
    assertWithinLimit(key) {
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("A rate limit key is required");
      }
      const currentTime = now();
      const existing = windows.get(key);
      if (!existing || currentTime - existing.windowStart >= windowMs) {
        windows.set(key, { windowStart: currentTime, count: 1 });
        return;
      }
      if (existing.count >= limit) {
        const retryAfterMs = windowMs - (currentTime - existing.windowStart);
        throw new SecurityError(
          429,
          "rate_limit_exceeded",
          "Too many requests. Please retry later.",
          { retryAfterMs: Math.max(retryAfterMs, 0) }
        );
      }
      existing.count += 1;
    }
  };
}
