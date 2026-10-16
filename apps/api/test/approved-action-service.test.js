import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createApplication } from "../src/app.js";
import { createApprovedActionService } from "../src/approved-action-service.js";
import { ApiError } from "../src/errors.js";
import {
  createPersistentApprovedActionStore,
  InMemoryApprovedActionStore,
} from "../src/approved-action-store.js";

const action = {
  productId: "fl-titling",
  subject: "qa-reviewer",
  actionType: "testrail.case.update",
  target: { caseId: "1201" },
  changes: { title: "Verify title workflow" },
  sourceVersions: [{ source: "testrail", sourceId: "1201", sourceVersion: "7" }],
};

const createAction = {
  productId: "fl-titling",
  subject: "qa-reviewer",
  actionType: "testrail.case.create",
  target: { sectionId: "1201" },
  changes: { title: "Verify valid VIN", refs: "STT-100" },
  sourceVersions: [{ source: "jira", sourceId: "STT-100", sourceVersion: "7" }],
};

function auth(permissions = ["actions:testrail-case-update"]) {
  return {
    subject: "qa-reviewer",
    tenantId: "solera",
    roles: ["quality-reviewer"],
    permissions,
    productIds: ["fl-titling"],
  };
}

async function apiRequest(application, path, body, authContext = auth()) {
  const url = new URL(path, "http://localhost");
  return application.handle({
    method: "POST",
    pathname: url.pathname,
    url,
    body,
    authContext,
  });
}

test("blocked environment keeps preview, approval, execution, and audit contracts separate", async () => {
  const events = [];
  const service = createApprovedActionService({
    auditLogger: { async record(event) { events.push(event); } },
  });
  const application = createApplication({
    approvedActionService: service,
    auditLogger: { async record(event) { events.push(event); } },
  });

  const previewResponse = await apiRequest(
    application,
    "/v1/actions/previews?productId=fl-titling",
    {
      actionType: action.actionType,
      target: action.target,
      changes: action.changes,
      sourceVersions: action.sourceVersions,
      idempotencyKey: "preview-1201",
    },
  );
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.body.preview.executable, false);
  assert.equal(previewResponse.body.preview.executionStatus, "blocked");
  assert.equal(
    previewResponse.body.preview.blockReason.code,
    "external_writes_not_configured",
  );
  assert.match(previewResponse.body.preview.previewHash, /^[a-f0-9]{64}$/);

  const approvalResponse = await apiRequest(
    application,
    "/v1/actions/approvals?productId=fl-titling",
    {
      actionType: action.actionType,
      previewId: previewResponse.body.preview.id,
      previewHash: previewResponse.body.preview.previewHash,
      idempotencyKey: "approve-1201",
    },
  );
  assert.equal(approvalResponse.status, 200);
  assert.equal(approvalResponse.body.approval.subject, "qa-reviewer");
  assert.equal(approvalResponse.body.approval.status, "approved");

  const executionResponse = await apiRequest(
    application,
    "/v1/actions/executions?productId=fl-titling",
    {
      actionType: action.actionType,
      approvalId: approvalResponse.body.approval.id,
      previewHash: previewResponse.body.preview.previewHash,
      sourceVersions: action.sourceVersions,
      idempotencyKey: "execute-1201",
    },
  );
  assert.equal(executionResponse.status, 200);
  assert.equal(executionResponse.body.execution.status, "blocked");
  assert.equal(executionResponse.body.execution.externalCallMade, false);
  assert.equal(
    executionResponse.body.execution.reason.code,
    "external_writes_not_configured",
  );
  assert.equal(
    events.some((event) =>
      event.eventType === "approved_action.execution"
      && event.outcome === "blocked"
      && event.externalCallMade === false),
    true,
  );
});

test("executes an approved TestRail case creation exactly once", async () => {
  const calls = [];
  const service = createApprovedActionService({
    executableActionTypes: ["testrail.case.create"],
    actionExecutor: async (request) => {
      calls.push(request);
      return {
        source: "testrail",
        externalId: "4455",
        url: "https://testrail.example/index.php?/cases/view/4455",
        title: request.changes.title,
      };
    },
  });
  const { preview } = await service.createPreview({
    ...createAction,
    idempotencyKey: "preview-create-4455",
  });
  assert.equal(preview.executable, true);
  assert.equal(preview.executionStatus, "ready");

  const { approval } = await service.approve({
    productId: createAction.productId,
    subject: createAction.subject,
    actionType: createAction.actionType,
    previewId: preview.id,
    previewHash: preview.previewHash,
    idempotencyKey: "approve-create-4455",
  });
  const request = {
    productId: createAction.productId,
    subject: createAction.subject,
    actionType: createAction.actionType,
    approvalId: approval.id,
    previewHash: preview.previewHash,
    sourceVersions: createAction.sourceVersions,
    idempotencyKey: "execute-create-4455",
  };
  const first = await service.execute(request);
  const retry = await service.execute(request);

  assert.equal(first.execution.status, "succeeded");
  assert.equal(first.execution.externalCallMade, true);
  assert.equal(first.execution.result.externalId, "4455");
  assert.equal(retry.execution.id, first.execution.id);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target, { sectionId: "1201" });
});

test("records recovery details when a section is created but case creation fails", async () => {
  const service = createApprovedActionService({
    executableActionTypes: ["testrail.case.create"],
    actionExecutor: async () => {
      throw new ApiError(
        502,
        "partial_source_write",
        "TestRail created the section, but case creation failed.",
        { sectionId: "3301" },
      );
    },
  });
  const { preview } = await service.createPreview({
    ...createAction,
    target: { suiteId: "128951", newSectionName: "Automation candidates" },
    idempotencyKey: "preview-partial-write",
  });
  const { approval } = await service.approve({
    productId: createAction.productId,
    subject: createAction.subject,
    actionType: createAction.actionType,
    previewId: preview.id,
    previewHash: preview.previewHash,
    idempotencyKey: "approve-partial-write",
  });

  const { execution } = await service.execute({
    productId: createAction.productId,
    subject: createAction.subject,
    actionType: createAction.actionType,
    approvalId: approval.id,
    previewHash: preview.previewHash,
    sourceVersions: createAction.sourceVersions,
    idempotencyKey: "execute-partial-write",
  });

  assert.equal(execution.status, "failed");
  assert.equal(execution.externalCallMade, true);
  assert.equal(execution.recovery.required, true);
  assert.match(execution.recovery.instructions, /S3301/);
});

test("requires the least-privilege action-specific permission", async () => {
  const application = createApplication();
  const response = await apiRequest(
    application,
    "/v1/actions/previews?productId=fl-titling",
    {
      actionType: action.actionType,
      target: action.target,
      changes: action.changes,
      sourceVersions: action.sourceVersions,
      idempotencyKey: "preview-denied",
    },
    auth(["coverage:read"]),
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "forbidden");
  assert.equal(
    response.body.error.details.permission,
    "actions:testrail-case-update",
  );

  const adminResponse = await apiRequest(
    application,
    "/v1/actions/previews?productId=fl-titling",
    {
      actionType: action.actionType,
      target: action.target,
      changes: action.changes,
      sourceVersions: action.sourceVersions,
      idempotencyKey: "preview-admin-denied",
    },
    {
      ...auth([]),
      roles: ["admin"],
    },
  );
  assert.equal(adminResponse.status, 403);
  assert.equal(adminResponse.body.error.details.permission, "actions:testrail-case-update");
});

test("rejects preview hash, subject, and source-version mismatches", async () => {
  const service = createApprovedActionService();
  const { preview } = await service.createPreview({
    ...action,
    idempotencyKey: "preview-binding",
  });

  await assert.rejects(
    service.approve({
      productId: action.productId,
      subject: action.subject,
      actionType: action.actionType,
      previewId: preview.id,
      previewHash: "0".repeat(64),
      idempotencyKey: "approve-wrong-hash",
    }),
    (error) => error.code === "action_preview_mismatch",
  );
  await assert.rejects(
    service.approve({
      productId: action.productId,
      subject: "another-reviewer",
      actionType: action.actionType,
      previewId: preview.id,
      previewHash: preview.previewHash,
      idempotencyKey: "approve-wrong-subject",
    }),
    (error) => error.code === "action_preview_mismatch",
  );

  const { approval } = await service.approve({
    productId: action.productId,
    subject: action.subject,
    actionType: action.actionType,
    previewId: preview.id,
    previewHash: preview.previewHash,
    idempotencyKey: "approve-binding",
  });
  await assert.rejects(
    service.execute({
      productId: action.productId,
      subject: action.subject,
      actionType: action.actionType,
      approvalId: approval.id,
      previewHash: preview.previewHash,
      sourceVersions: [{ ...action.sourceVersions[0], sourceVersion: "8" }],
      idempotencyKey: "execute-stale-request",
    }),
    (error) => error.code === "source_version_mismatch",
  );
});

test("one-time approval and idempotency prevent duplicate execution", async () => {
  const service = createApprovedActionService();
  const { preview } = await service.createPreview({
    ...action,
    idempotencyKey: "preview-once",
  });

  const { approval } = await service.approve({
    productId: action.productId,
    subject: action.subject,
    actionType: action.actionType,
    previewId: preview.id,
    previewHash: preview.previewHash,
    idempotencyKey: "approve-once",
  });
  const request = {
    productId: action.productId,
    subject: action.subject,
    actionType: action.actionType,
    approvalId: approval.id,
    previewHash: preview.previewHash,
    sourceVersions: action.sourceVersions,
    idempotencyKey: "execute-once",
  };

  const first = await service.execute(request);
  const retry = await service.execute(request);
  assert.equal(retry.execution.id, first.execution.id);
  await assert.rejects(
    service.execute({ ...request, idempotencyKey: "execute-twice" }),
    (error) => error.code === "action_approval_consumed",
  );
});

test("atomically permits exactly one approval per preview", async () => {
  const service = createApprovedActionService();
  const { preview } = await service.createPreview({
    ...action,
    idempotencyKey: "preview-single-approval",
  });
  const approve = (idempotencyKey) => service.approve({
    productId: action.productId,
    subject: action.subject,
    actionType: action.actionType,
    previewId: preview.id,
    previewHash: preview.previewHash,
    idempotencyKey,
  });

  const attempts = await Promise.allSettled([
    approve("approve-single-first"),
    approve("approve-single-second"),
  ]);
  const successful = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");

  assert.equal(successful.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "action_preview_already_approved");
  assert.equal(service.records(action.productId).approvals.length, 1);

  const retry = await approve(
    successful[0].value.approval.idempotencyKey,
  );
  assert.equal(retry.approval.id, successful[0].value.approval.id);
});

test("expired previews and approvals cannot authorize execution", async () => {
  let current = new Date("2026-09-14T08:00:00.000Z");
  const service = createApprovedActionService({ now: () => current });
  const { preview } = await service.createPreview({
    ...action,
    idempotencyKey: "preview-expiry",
  });
  current = new Date("2026-09-14T08:16:00.000Z");
  await assert.rejects(
    service.approve({
      productId: action.productId,
      subject: action.subject,
      actionType: action.actionType,
      previewId: preview.id,
      previewHash: preview.previewHash,
      idempotencyKey: "approve-expired-preview",
    }),
    (error) => error.code === "action_preview_expired",
  );

  current = new Date("2026-09-14T09:00:00.000Z");
  const second = await service.createPreview({
    ...action,
    idempotencyKey: "preview-approval-expiry",
  });
  const { approval } = await service.approve({
    productId: action.productId,
    subject: action.subject,
    actionType: action.actionType,
    previewId: second.preview.id,
    previewHash: second.preview.previewHash,
    idempotencyKey: "approve-approval-expiry",
  });
  current = new Date("2026-09-14T09:06:00.000Z");
  await assert.rejects(
    service.execute({
      productId: action.productId,
      subject: action.subject,
      actionType: action.actionType,
      approvalId: approval.id,
      previewHash: second.preview.previewHash,
      sourceVersions: action.sourceVersions,
      idempotencyKey: "execute-expired-approval",
    }),
    (error) => error.code === "action_approval_expired",
  );
});

test("stale local source data fails closed before the blocked execution record", async () => {
  const service = createApprovedActionService({
    sourceVersionReader: async () => [
      { source: "testrail", sourceId: "1201", sourceVersion: "8" },
    ],
  });
  const { preview } = await service.createPreview({
    ...action,
    idempotencyKey: "preview-stale",
  });
  const { approval } = await service.approve({
    productId: action.productId,
    subject: action.subject,
    actionType: action.actionType,
    previewId: preview.id,
    previewHash: preview.previewHash,
    idempotencyKey: "approve-stale",
  });

  await assert.rejects(
    service.execute({
      productId: action.productId,
      subject: action.subject,
      actionType: action.actionType,
      approvalId: approval.id,
      previewHash: preview.previewHash,
      sourceVersions: action.sourceVersions,
      idempotencyKey: "execute-stale",
    }),
    (error) => error.code === "stale_source_version",
  );
});

test("persistent store reloads local approval and action records without secrets", async () => {
  const dataDirectory = resolve(
    "apps",
    "api",
    "data",
    "local",
    `approved-action-test-${process.pid}`,
  );
  rmSync(dataDirectory, { recursive: true, force: true });
  try {
    const firstStore = createPersistentApprovedActionStore({
      dataDirectory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const firstService = createApprovedActionService({
      productId: "fl-titling",
      store: firstStore,
    });
    const { preview } = await firstService.createPreview({
      ...action,
      idempotencyKey: "preview-durable",
    });
    await firstService.approve({
      productId: action.productId,
      subject: action.subject,
      actionType: action.actionType,
      previewId: preview.id,
      previewHash: preview.previewHash,
      idempotencyKey: "approve-durable",
    });

    const reloaded = createPersistentApprovedActionStore({
      dataDirectory,
      tenantId: "solera",
      productId: "fl-titling",
    }).read();
    assert.equal(reloaded.previews.length, 1);
    assert.equal(reloaded.approvals.length, 1);
    const keys = collectKeys(reloaded);
    assert.equal(keys.some((key) => /^(token|secret|password|credential|authorization)$/i.test(key)), false);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("persistent store recovers a lock left by a terminated owner", () => {
  const dataDirectory = resolve(
    "apps",
    "api",
    "data",
    "local",
    `approved-action-dead-lock-test-${process.pid}`,
  );
  const directory = join(dataDirectory, "solera", "fl-titling");
  const lockPath = join(directory, "approved-actions.json.lock");
  rmSync(dataDirectory, { recursive: true, force: true });
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: 424242,
      createdAt: "2026-09-14T08:00:00.000Z",
      token: "00000000-0000-4000-8000-000000000001",
    })}\n`);

    const store = createPersistentApprovedActionStore({
      dataDirectory,
      tenantId: "solera",
      productId: "fl-titling",
      isProcessAlive: () => false,
    });

    assert.equal(store.read().revision, 0);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("persistent store recovers an old legacy lock after its TTL", () => {
  const dataDirectory = resolve(
    "apps",
    "api",
    "data",
    "local",
    `approved-action-legacy-lock-test-${process.pid}`,
  );
  const directory = join(dataDirectory, "solera", "fl-titling");
  const lockPath = join(directory, "approved-actions.json.lock");
  rmSync(dataDirectory, { recursive: true, force: true });
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(lockPath, "");
    const oldTimestamp = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oldTimestamp, oldTimestamp);

    const store = createPersistentApprovedActionStore({
      dataDirectory,
      tenantId: "solera",
      productId: "fl-titling",
      staleLockMs: 1_000,
    });

    assert.equal(store.read().revision, 0);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("persistent store finishes stale-lock recovery left by another crash", () => {
  const dataDirectory = resolve(
    "apps",
    "api",
    "data",
    "local",
    `approved-action-recovery-lock-test-${process.pid}`,
  );
  const directory = join(dataDirectory, "solera", "fl-titling");
  const lockPath = join(directory, "approved-actions.json.lock");
  rmSync(dataDirectory, { recursive: true, force: true });
  try {
    mkdirSync(directory, { recursive: true });
    const contents = `${JSON.stringify({
      schemaVersion: 1,
      pid: 424242,
      createdAt: "2026-09-14T08:00:00.000Z",
      token: "00000000-0000-4000-8000-000000000001",
    })}\n`;
    writeFileSync(lockPath, contents);
    const observed = statSync(lockPath);
    const fingerprint = createHash("sha256")
      .update(contents)
      .update(`${observed.dev}:${observed.ino}:${observed.size}:${observed.mtimeMs}`)
      .digest("hex")
      .slice(0, 24);
    linkSync(lockPath, `${lockPath}.stale-${fingerprint}`);

    const store = createPersistentApprovedActionStore({
      dataDirectory,
      tenantId: "solera",
      productId: "fl-titling",
      isProcessAlive: () => false,
    });

    assert.equal(store.read().revision, 0);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("persistent store keeps active contention safe and retryable", () => {
  const dataDirectory = resolve(
    "apps",
    "api",
    "data",
    "local",
    `approved-action-active-lock-test-${process.pid}`,
  );
  rmSync(dataDirectory, { recursive: true, force: true });
  try {
    const store = createPersistentApprovedActionStore({
      dataDirectory,
      tenantId: "solera",
      productId: "fl-titling",
    });

    store.transact(() => {
      assert.throws(
        () => createPersistentApprovedActionStore({
          dataDirectory,
          tenantId: "solera",
          productId: "fl-titling",
        }),
        (error) =>
          error.status === 503
          && error.code === "approved_action_store_busy"
          && error.details.retryable === true,
      );
    });

    assert.equal(createPersistentApprovedActionStore({
      dataDirectory,
      tenantId: "solera",
      productId: "fl-titling",
    }).read().revision, 1);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("API surfaces active persistent-store contention as retryable", async () => {
  const dataDirectory = resolve(
    "apps",
    "api",
    "data",
    "local",
    `approved-action-api-lock-test-${process.pid}`,
  );
  rmSync(dataDirectory, { recursive: true, force: true });
  try {
    const store = createPersistentApprovedActionStore({
      dataDirectory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const application = createApplication({
      approvedActionService: createApprovedActionService({
        productId: "fl-titling",
        store,
      }),
    });

    let response;
    store.transact(() => {
      response = apiRequest(
        application,
        "/v1/actions/previews?productId=fl-titling",
        {
          actionType: action.actionType,
          target: action.target,
          changes: action.changes,
          sourceVersions: action.sourceVersions,
          idempotencyKey: "preview-busy-store",
        },
      );
    });

    assert.equal((await response).status, 503);
    assert.equal((await response).body.error.code, "approved_action_store_busy");
    assert.equal((await response).body.error.details.retryable, true);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

function collectKeys(value) {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => [key, ...collectKeys(entry)]);
}
