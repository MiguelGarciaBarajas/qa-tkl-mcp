import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MCP_BODY_BYTES,
  SecurityError,
  assertBodySize,
  createRateLimiter,
  requireAuthorizationHeader,
  requireJsonContentType,
  securityHeaders
} from "../src/index.js";

test("publishes secure response headers", () => {
  assert.equal(securityHeaders()["x-content-type-options"], "nosniff");
  assert.equal(securityHeaders()["x-frame-options"], "DENY");
});

test("rejects unsafe MCP content types and missing auth", () => {
  assert.throws(
    () => requireJsonContentType("text/plain"),
    (error) => error instanceof SecurityError && error.code === "unsupported_media_type"
  );
  assert.throws(
    () => requireAuthorizationHeader(undefined),
    (error) => error instanceof SecurityError && error.code === "unauthenticated"
  );
});

test("limits MCP request body size", () => {
  assert.throws(
    () => assertBodySize(MAX_MCP_BODY_BYTES + 1),
    (error) => error instanceof SecurityError && error.code === "payload_too_large"
  );
});

test("rate limiter allows requests within the window and blocks over-limit callers", () => {
  let currentTime = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => currentTime });

  limiter.assertWithinLimit("subject-a");
  limiter.assertWithinLimit("subject-a");
  assert.throws(
    () => limiter.assertWithinLimit("subject-a"),
    (error) => error instanceof SecurityError && error.code === "rate_limit_exceeded" && error.status === 429
  );

  // A different key is tracked independently.
  limiter.assertWithinLimit("subject-b");
});

test("rate limiter resets the window after it elapses", () => {
  let currentTime = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => currentTime });

  limiter.assertWithinLimit("subject-a");
  assert.throws(() => limiter.assertWithinLimit("subject-a"));

  currentTime = 1500;
  assert.doesNotThrow(() => limiter.assertWithinLimit("subject-a"));
});

test("rate limiter validates its configuration and key", () => {
  assert.throws(() => createRateLimiter({ limit: 0 }), TypeError);
  assert.throws(() => createRateLimiter({ windowMs: 0 }), TypeError);
  const limiter = createRateLimiter();
  assert.throws(() => limiter.assertWithinLimit(""), TypeError);
});
