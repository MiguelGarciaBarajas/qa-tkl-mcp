import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createApplication } from "../src/app.js";
import { createApiServer, MAX_REQUEST_BODY_BYTES } from "../src/http-server.js";
import { createJiraWebhookService } from "../src/jira-webhook-service.js";

const SECRET = "test-webhook-key-test-webhook-key";

function payload(overrides = {}) {
  return {
    webhookEvent: "jira:issue_updated",
    timestamp: Date.parse("2026-09-15T18:00:00.000Z"),
    issue: {
      key: "STT-3731",
      fields: { project: { key: "STT" } }
    },
    ...overrides
  };
}

function signedRequest(body, deliveryId = "delivery-123") {
  const rawBody = Buffer.from(
    typeof body === "string" ? body : JSON.stringify(body)
  );
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-atlassian-webhook-identifier": deliveryId,
      "x-hub-signature-256":
        `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`
    }
  };
}

function harness({ disposition = "accepted" } = {}) {
  const invalidations = [];
  const rejections = [];
  const service = createJiraWebhookService({
    productId: "fl-titling",
    allowedProjects: ["STT"],
    secret: SECRET,
    ticketContextCoordinator: {
      async invalidate(request) {
        invalidations.push(request);
        return { disposition };
      },
      async recordInvalidationRejection(request) {
        rejections.push(request);
      }
    }
  });
  return { service, invalidations, rejections };
}

test("verifies Jira HMAC before parsing and routes a canonical issue to the fixed product", async () => {
  const { service, invalidations } = harness();
  const result = await service.handle(signedRequest(payload()));

  assert.equal(result.disposition, "accepted");
  assert.deepEqual(invalidations, [{
    productId: "fl-titling",
    issueKey: "STT-3731",
    source: "jira",
    eventId: "delivery-123",
    observedAt: "2026-09-15T18:00:00.000Z"
  }]);
});

test("acknowledges a signed unknown ticket without creating work", async () => {
  const { service, invalidations } = harness({ disposition: "ignored:not-hot" });
  const result = await service.handle(signedRequest(payload(), "delivery-cold"));

  assert.equal(result.disposition, "ignored:not-hot");
  assert.equal(invalidations.length, 1);
});

test("fails closed for invalid signatures without leaking signature or payload", async () => {
  const { service, invalidations, rejections } = harness();
  const request = signedRequest(payload({
    confidential: "payload-must-not-leak"
  }));
  request.headers["x-hub-signature-256"] = `sha256=${"0".repeat(64)}`;

  await assert.rejects(
    () => service.handle(request),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "invalid_webhook_signature");
      assert.doesNotMatch(JSON.stringify(error), /payload-must-not-leak|0{64}/);
      return true;
    }
  );
  assert.equal(invalidations.length, 0);
  assert.equal(rejections.length, 0);
});

test("rejects signed malformed, unsupported, and wrong-project deliveries", async () => {
  const { service, invalidations, rejections } = harness();

  await assert.rejects(
    () => service.handle(signedRequest("{malformed", "delivery-malformed")),
    (error) => error.status === 400 && error.code === "invalid_webhook"
  );
  await assert.rejects(
    () => service.handle(signedRequest(payload({
      webhookEvent: "jira:worklog_updated"
    }), "delivery-unsupported")),
    (error) => error.status === 400 && error.code === "unsupported_webhook_event"
  );
  await assert.rejects(
    () => service.handle(signedRequest(payload({
      issue: {
        key: "OPS-1",
        fields: { project: { key: "OPS" } }
      }
    }), "delivery-scope")),
    (error) => error.status === 403 && error.code === "webhook_scope_rejected"
  );

  assert.equal(invalidations.length, 0);
  assert.equal(rejections.length, 3);
});

test("enforces the shared 64 KiB body cap before webhook handling", async (t) => {
  let authenticated = false;
  let handled = false;
  const auditEvents = [];
  const application = createApplication({
    jiraWebhookService: {
      async handle() {
        handled = true;
        return { disposition: "accepted" };
      }
    }
  });
  const server = createApiServer({
    application,
    authenticator: {
      async authenticate() {
        authenticated = true;
        throw new Error("webhook must not use bearer authentication");
      }
    },
    auditLogger: {
      async record(event) {
        auditEvents.push(event);
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  const oversized = "sensitive-payload-".padEnd(MAX_REQUEST_BODY_BYTES + 1, "x");

  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/webhooks/jira`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-atlassian-webhook-identifier": "delivery-oversized",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`
      },
      body: oversized
    }
  );
  const result = await response.json();
  assert.equal(response.status, 413);
  assert.equal(result.error.code, "payload_too_large");
  assert.equal(authenticated, false);
  assert.equal(handled, false);
  assert.doesNotMatch(JSON.stringify(auditEvents), /sensitive-payload|0{64}/);
});
