import test from "node:test";
import assert from "node:assert/strict";
import { createAuditLogger, createHealthRegistry, redact } from "../src/index.js";

test("redacts sensitive fields recursively", () => {
  assert.deepEqual(
    redact({ authorization: "Bearer secret", nested: { apiKey: "value" } }),
    { authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]" } }
  );
});

test("records a structured audit event through the injected sink", async () => {
  const events = [];
  const logger = createAuditLogger({ sink: { info: (event) => events.push(event) } });

  const event = await logger.record({
    eventType: "api.request",
    correlationId: "correlation-1",
    authorization: "Bearer secret",
    outcome: "success"
  });

  assert.equal(events.length, 1);
  assert.equal(event.authorization, "[REDACTED]");
  assert.equal(event.correlationId, "correlation-1");
});

test("correlates registered component health into a single redacted report", () => {
  const registry = createHealthRegistry({ correlationId: "correlation-1" });

  registry.record("jira-connector", {
    status: "healthy",
    credentialRef: "secret-ref",
    records: 12,
    retries: 0,
    failures: 0
  });
  registry.record("mcp-gateway", { status: "healthy" });

  const report = registry.report();

  assert.equal(report.correlationId, "correlation-1");
  assert.equal(report.status, "healthy");
  assert.equal(report.components.length, 2);
  const jira = report.components.find((entry) => entry.component === "jira-connector");
  assert.equal(jira.records, 12);
  assert.ok(jira.checkedAt);
});

test("reports degraded status when any correlated component is unhealthy", () => {
  const registry = createHealthRegistry();
  registry.record("api", { status: "healthy" });
  registry.record("github-connector", { status: "degraded", failures: 3 });

  assert.equal(registry.report().status, "degraded");
});

test("reports unknown status when no components have been recorded", () => {
  assert.equal(createHealthRegistry().report().status, "unknown");
});

test("redacts sensitive fields recorded on component health", () => {
  const registry = createHealthRegistry();
  registry.record("testrail-connector", { status: "healthy", credentialRef: "abc", apiKey: "should-not-leak" });

  const [component] = registry.report().components;
  assert.equal(component.credentialRef, "[REDACTED]");
  assert.equal(component.apiKey, "[REDACTED]");
});

test("rejects health records missing a component name or status", () => {
  const registry = createHealthRegistry();
  assert.throws(() => registry.record("", { status: "healthy" }), TypeError);
  assert.throws(() => registry.record("api", {}), TypeError);
});
