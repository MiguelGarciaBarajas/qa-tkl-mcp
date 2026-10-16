import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/app.js";

const auth = {
  subject: "context-operator",
  tenantId: "solera",
  roles: ["reader"],
  permissions: ["knowledge:read", "connections:read", "connections:sync"],
  productIds: ["fl-titling"]
};

function request(application, method, path, authContext = auth) {
  const url = new URL(path, "http://localhost");
  return application.handle({
    method,
    pathname: url.pathname,
    url,
    authContext,
    correlationId: "context-job-test"
  });
}

test("context job APIs validate, authorize, scope, refresh, and cancel", async () => {
  const calls = [];
  const ticketContextCoordinator = {
    async get(request) {
      calls.push(["get", request]);
      return { productId: request.productId, issueKey: request.issueKey, state: "complete" };
    },
    async enqueue(request) {
      calls.push(["enqueue", request]);
      return { productId: request.productId, issueKey: request.issueKey, state: "pending" };
    },
    async cancel(request) {
      calls.push(["cancel", request]);
      return { productId: request.productId, issueKey: request.issueKey, state: "cancelled" };
    }
  };
  const application = createApplication({ ticketContextCoordinator });

  const get = await request(
    application,
    "GET",
    "/v1/context-jobs/stt-3731?productId=fl-titling"
  );
  assert.equal(get.status, 200);
  assert.equal(get.body.job.issueKey, "STT-3731");

  const refresh = await request(
    application,
    "POST",
    "/v1/context-jobs/STT-3731/refresh?productId=fl-titling"
  );
  assert.equal(refresh.status, 202);
  assert.equal(calls[1][1].force, true);

  const cancel = await request(
    application,
    "DELETE",
    "/v1/context-jobs/STT-3731?productId=fl-titling"
  );
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.job.state, "cancelled");

  const invalid = await request(
    application,
    "GET",
    "/v1/context-jobs/not-a-ticket?productId=fl-titling"
  );
  assert.equal(invalid.status, 400);

  const forbidden = await request(
    application,
    "POST",
    "/v1/context-jobs/STT-3731/refresh?productId=fl-titling",
    { ...auth, permissions: ["knowledge:read"] }
  );
  assert.equal(forbidden.status, 403);

  const outOfScope = await request(
    application,
    "GET",
    "/v1/context-jobs/STT-3731?productId=other-product"
  );
  assert.equal(outOfScope.status, 403);
});

test("operations endpoint is authenticated, product-scoped, rate-limited, and strict", async () => {
  const requests = [];
  const application = createApplication({
    ticketContextCoordinator: {
      async operations(request) {
        requests.push(request);
        return {
          durable: { jobStates: {}, totalJobs: 0, deliveryReceipts: 0 },
          memory: {
            queued: 0,
            active: 0,
            delayedRetry: 0,
            paused: false,
            oldestQueuedAgeMs: null
          }
        };
      }
    }
  });

  const response = await request(
    application,
    "GET",
    "/v1/context-operations?productId=fl-titling"
  );
  assert.equal(response.status, 200);
  assert.deepEqual(requests, [{ productId: "fl-titling" }]);

  const forbidden = await request(
    application,
    "GET",
    "/v1/context-operations?productId=fl-titling",
    { ...auth, permissions: ["knowledge:read"] }
  );
  assert.equal(forbidden.status, 403);

  const outOfScope = await request(
    application,
    "GET",
    "/v1/context-operations?productId=other-product"
  );
  assert.equal(outOfScope.status, 403);

  const unsupported = await request(
    application,
    "GET",
    "/v1/context-operations?productId=fl-titling&source=jira"
  );
  assert.equal(unsupported.status, 400);
});

test("Jira webhook endpoint returns only a fast disposition", async () => {
  const received = [];
  const application = createApplication({
    jiraWebhookService: {
      async handle(request) {
        received.push(request);
        return {
          disposition: "ignored:not-hot",
          job: { issueKey: "must-not-be-returned" }
        };
      }
    }
  });
  const url = new URL("/v1/webhooks/jira", "http://localhost");
  const rawBody = Buffer.from("{}");
  const response = await application.handle({
    method: "POST",
    pathname: url.pathname,
    url,
    rawBody,
    headers: { "x-hub-signature-256": "redacted-by-service" },
    correlationId: "jira-webhook-test"
  });

  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { disposition: "ignored:not-hot" });
  assert.equal(received[0].rawBody, rawBody);

  const spoofedProduct = new URL(
    "/v1/webhooks/jira?productId=other-product",
    "http://localhost"
  );
  const rejected = await application.handle({
    method: "POST",
    pathname: spoofedProduct.pathname,
    url: spoofedProduct,
    rawBody,
    headers: {},
    correlationId: "jira-webhook-spoof-test"
  });
  assert.equal(rejected.status, 400);
  assert.equal(received.length, 1);
});

test("public health includes only aggregate ticket-context status and reasons", async () => {
  const application = createApplication({
    ticketContextCoordinator: {
      async health() {
        return {
          status: "degraded",
          reasons: ["capacity_high"],
          productId: "must-not-leak",
          issueKey: "STT-SECRET"
        };
      }
    }
  });
  const response = await request(application, "GET", "/health", undefined);
  const component = response.body.dependencies.components.find(
    (entry) => entry.component === "ticket-context"
  );

  assert.equal(response.body.status, "degraded");
  assert.equal(component.status, "degraded");
  assert.deepEqual(component.reasons, ["capacity_high"]);
  assert.equal(JSON.stringify(response.body).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(response.body).includes("STT-SECRET"), false);
});
