import test from "node:test";
import assert from "node:assert/strict";
import {
  createReasoningPlan,
  finalizeReasoningMetadata,
} from "../src/agents/product-reasoning-planner.js";
import { createAskFeedbackService } from "../src/agents/ask-feedback-service.js";

test("creates a bounded product plan for customer and owner questions", () => {
  const plan = createReasoningPlan({
    question: "Why can a deal have both an individual and business owner?",
    intent: "knowledge-search",
  });

  assert.equal(plan.domain, "customer-owner");
  assert.ok(plan.sources.includes("jira"));
  assert.ok(plan.sources.includes("confluence"));
  assert.equal(plan.investigation.required, false);
  assert.equal(plan.evidenceMode, "documented");
});

test("marks live questions as requiring an explicit investigation provider", () => {
  const plan = createReasoningPlan({
    question: "What is happening now in the owner screen and browser network?",
    intent: "knowledge-search",
  });
  const metadata = finalizeReasoningMetadata(plan, {
    items: [{ id: "claim:1", title: "Documented owner rule" }],
  });

  assert.equal(metadata.domain, "customer-owner");
  assert.equal(metadata.investigation.status, "not-enabled");
  assert.match(metadata.investigation.stopReason, /provider is not enabled/i);
  assert.equal(metadata.claims[0].type, "fact");
});

test("feedback is queued for review and does not mutate knowledge", () => {
  const service = createAskFeedbackService({
    now: () => "2026-09-18T12:00:00.000Z",
    createId: () => "feedback-1",
  });
  const entry = service.submit({
    runId: "ask-run-1",
    productId: "fl-titling",
    reviewerId: "qa-user",
    disposition: "incorrect",
    note: "The answer omitted the business-owner rule.",
    correction: { expectedDomain: "customer-owner" },
  });

  assert.equal(entry.status, "pending-review");
  assert.equal(service.list({ productId: "fl-titling" }).length, 1);
  assert.equal(service.list({ productId: "other-product" }).length, 0);
});
