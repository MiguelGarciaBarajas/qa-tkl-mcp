import { randomUUID, timingSafeEqual } from "node:crypto";
import { sha256, stableJson } from "../../../packages/contracts/src/index.js";
import { ApiError } from "./errors.js";
import { InMemoryApprovedActionStore } from "./approved-action-store.js";

export const APPROVED_ACTION_DEFINITIONS = Object.freeze({
  "testrail.case.create": Object.freeze({
    source: "testrail",
    requiredPermission: "actions:testrail-case-create",
    risk: "high",
    summary: "Create a TestRail case from an approved preview.",
  }),
  "testrail.case.update": Object.freeze({
    source: "testrail",
    requiredPermission: "actions:testrail-case-update",
    risk: "high",
    summary: "Update one TestRail case from an approved field-level preview.",
  }),
  "github.branch.create": Object.freeze({
    source: "github",
    requiredPermission: "actions:github-branch-create",
    risk: "medium",
    summary: "Create one GitHub branch from an approved base revision.",
  }),
  "github.pull-request.create": Object.freeze({
    source: "github",
    requiredPermission: "actions:github-pull-request-create",
    risk: "high",
    summary: "Open one GitHub pull request from an approved branch.",
  }),
});

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const APPROVAL_TTL_MS = 5 * 60 * 1000;

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function requestHash(value) {
  return sha256(stableJson(value));
}

function findByIdempotency(records, subject, key) {
  return records.find(
    (record) => record.subject === subject && record.idempotencyKey === key,
  );
}

function blockedReason() {
  return {
    code: "external_writes_not_configured",
    message:
      "External write credentials and execution policy are not configured for this environment.",
  };
}

export function permissionForApprovedAction(actionType) {
  const definition = APPROVED_ACTION_DEFINITIONS[actionType];
  if (!definition) {
    throw new ApiError(400, "invalid_request", "actionType is not supported.", {
      parameter: "actionType",
      allowed: Object.keys(APPROVED_ACTION_DEFINITIONS),
    });
  }
  return definition.requiredPermission;
}

export function createApprovedActionService({
  tenantId = "solera",
  productId,
  store,
  auditLogger,
  now = () => new Date(),
  sourceVersionReader,
  actionExecutor,
  executableActionTypes = [],
} = {}) {
  const stores = new Map();
  const executableTypes = new Set(executableActionTypes);

  function storeFor(scopedProductId) {
    if (store) return store;
    if (!stores.has(scopedProductId)) {
      stores.set(
        scopedProductId,
        new InMemoryApprovedActionStore({ tenantId, productId: scopedProductId }),
      );
    }
    return stores.get(scopedProductId);
  }

  function isExecutable(actionType) {
    return typeof actionExecutor === "function" && executableTypes.has(actionType);
  }

  async function audit(event) {
    if (auditLogger?.record) await auditLogger.record(event);
  }

  function assertServiceScope(requestProductId) {
    if (productId && productId !== requestProductId) {
      throw new ApiError(403, "product_access_denied", "The action store is bound to another product.");
    }
  }

  return {
    async createPreview(request) {
      assertServiceScope(request.productId);
      permissionForApprovedAction(request.actionType);
      const definition = APPROVED_ACTION_DEFINITIONS[request.actionType];
      const createdAt = now().toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + PREVIEW_TTL_MS).toISOString();
      const immutable = {
        schemaVersion: 1,
        tenantId,
        productId: request.productId,
        subject: request.subject,
        actionType: request.actionType,
        target: request.target,
        changes: request.changes,
        sourceVersions: request.sourceVersions,
        requiredPermission: definition.requiredPermission,
      };
      const previewHash = requestHash(immutable);
      const record = {
        id: `preview:${randomUUID()}`,
        ...immutable,
        previewHash,
        requestHash: requestHash({
          ...immutable,
          idempotencyKey: request.idempotencyKey,
        }),
        idempotencyKey: request.idempotencyKey,
        risk: definition.risk,
        summary: definition.summary,
        executable: isExecutable(request.actionType),
        executionStatus: isExecutable(request.actionType) ? "ready" : "blocked",
        blockReason: isExecutable(request.actionType) ? null : blockedReason(),
        createdAt,
        expiresAt,
      };
      const result = storeFor(request.productId).transact((snapshot) => {
        const existing = findByIdempotency(
          snapshot.previews,
          request.subject,
          request.idempotencyKey,
        );
        if (existing) {
          if (!safeEqual(existing.requestHash, record.requestHash)) {
            throw new ApiError(
              409,
              "idempotency_conflict",
              "The idempotency key was already used for a different action preview.",
            );
          }
          return existing;
        }
        snapshot.previews.push(record);
        return record;
      });
      await audit({
        eventType: "approved_action.preview",
        operation: "preview_approved_action",
        subject: request.subject,
        productId: request.productId,
        actionType: request.actionType,
        previewId: result.id,
        previewHash: result.previewHash,
        outcome: result.executionStatus,
      });
      return { preview: result };
    },

    async approve(request) {
      assertServiceScope(request.productId);
      const approvedAt = now().toISOString();
      const result = storeFor(request.productId).transact((snapshot) => {
        const preview = snapshot.previews.find((candidate) => candidate.id === request.previewId);
        if (!preview) {
          throw new ApiError(404, "action_preview_not_found", "Action preview was not found.");
        }
        assertBoundPreview(preview, request);
        if (Date.parse(preview.expiresAt) <= Date.parse(approvedAt)) {
          throw new ApiError(409, "action_preview_expired", "Action preview has expired.");
        }
        const approvalRequestHash = requestHash({
          previewId: request.previewId,
          previewHash: request.previewHash,
          actionType: request.actionType,
        });
        const existing = findByIdempotency(
          snapshot.approvals,
          request.subject,
          request.idempotencyKey,
        );
        if (existing) {
          if (!safeEqual(existing.requestHash, approvalRequestHash)) {
            throw new ApiError(
              409,
              "idempotency_conflict",
              "The idempotency key was already used for a different approval.",
            );
          }
          return existing;
        }
        if (snapshot.approvals.some((approval) => approval.previewId === preview.id)) {
          throw new ApiError(
            409,
            "action_preview_already_approved",
            "The action preview already has its one-time approval.",
          );
        }
        const approval = {
          id: `approval:${randomUUID()}`,
          previewId: preview.id,
          previewHash: preview.previewHash,
          tenantId,
          productId: preview.productId,
          subject: request.subject,
          actionType: preview.actionType,
          requiredPermission: preview.requiredPermission,
          idempotencyKey: request.idempotencyKey,
          requestHash: approvalRequestHash,
          status: "approved",
          approvedAt,
          expiresAt: new Date(
            Math.min(Date.parse(preview.expiresAt), Date.parse(approvedAt) + APPROVAL_TTL_MS),
          ).toISOString(),
          consumedAt: null,
        };
        snapshot.approvals.push(approval);
        return approval;
      });
      await audit({
        eventType: "approved_action.approval",
        operation: "approve_action_preview",
        subject: request.subject,
        productId: request.productId,
        actionType: request.actionType,
        previewId: request.previewId,
        approvalId: result.id,
        previewHash: request.previewHash,
        outcome: "approved",
      });
      return { approval: result };
    },

    async execute(request) {
      assertServiceScope(request.productId);
      const attemptedAt = now().toISOString();
      const scopedStore = storeFor(request.productId);
      const snapshot = scopedStore.read();
      const approval = snapshot.approvals.find((candidate) => candidate.id === request.approvalId);
      if (!approval) {
        throw new ApiError(404, "action_approval_not_found", "Action approval was not found.");
      }
      const preview = snapshot.previews.find((candidate) => candidate.id === approval.previewId);
      if (!preview) {
        throw new ApiError(409, "action_preview_missing", "The approved preview is unavailable.");
      }
      assertBoundApproval(approval, preview, request);

      const executionRequestHash = requestHash({
        approvalId: request.approvalId,
        previewHash: request.previewHash,
        actionType: request.actionType,
        sourceVersions: request.sourceVersions,
      });
      const existing = findByIdempotency(
        snapshot.executions,
        request.subject,
        request.idempotencyKey,
      );
      if (existing) {
        if (!safeEqual(existing.requestHash, executionRequestHash)) {
          throw new ApiError(
            409,
            "idempotency_conflict",
            "The idempotency key was already used for a different execution.",
          );
        }
        return { execution: existing };
      }
      if (approval.status !== "approved" || approval.consumedAt !== null) {
        throw new ApiError(409, "action_approval_consumed", "The one-time approval was already used.");
      }
      if (Date.parse(approval.expiresAt) <= Date.parse(attemptedAt)) {
        throw new ApiError(409, "action_approval_expired", "The one-time approval has expired.");
      }
      assertSourceVersionsMatch(preview.sourceVersions, request.sourceVersions);
      if (typeof sourceVersionReader === "function") {
        const currentVersions = await sourceVersionReader({
          tenantId,
          productId: request.productId,
          actionType: request.actionType,
          sourceVersions: preview.sourceVersions,
        });
        assertSourceVersionsMatch(
          preview.sourceVersions,
          currentVersions,
          "stale_source_version",
        );
      }

      if (!isExecutable(preview.actionType)) {
        const execution = {
          id: `execution:${randomUUID()}`,
          approvalId: approval.id,
          previewId: preview.id,
          previewHash: preview.previewHash,
          tenantId,
          productId: preview.productId,
          subject: request.subject,
          actionType: preview.actionType,
          idempotencyKey: request.idempotencyKey,
          requestHash: executionRequestHash,
          status: "blocked",
          externalCallMade: false,
          reason: blockedReason(),
          attemptedAt,
          completedAt: attemptedAt,
          recovery: {
            required: false,
            instructions: "No external change occurred; no rollback is required.",
          },
        };
        const stored = consumeApprovalAndStoreExecution(scopedStore, approval.id, execution);
        await auditExecution(stored);
        return { execution: stored };
      }

      const execution = {
        id: `execution:${randomUUID()}`,
        approvalId: approval.id,
        previewId: preview.id,
        previewHash: preview.previewHash,
        tenantId,
        productId: preview.productId,
        subject: request.subject,
        actionType: preview.actionType,
        idempotencyKey: request.idempotencyKey,
        requestHash: executionRequestHash,
        status: "executing",
        externalCallMade: false,
        reason: null,
        attemptedAt,
        completedAt: null,
        recovery: {
          required: true,
          instructions: "Check TestRail before retrying if the process stops during execution.",
        },
      };
      consumeApprovalAndStoreExecution(scopedStore, approval.id, execution);
      try {
        const externalResult = await actionExecutor({
          productId: preview.productId,
          actionType: preview.actionType,
          target: preview.target,
          changes: preview.changes,
        });
        const stored = updateExecution(scopedStore, execution.id, {
          status: "succeeded",
          externalCallMade: true,
          result: externalResult,
          completedAt: now().toISOString(),
          recovery: {
            required: false,
            instructions:
              "The TestRail case was created. Further changes require a separate approved action.",
          },
        });
        await auditExecution(stored);
        return { execution: stored };
      } catch (error) {
        const safeError = error instanceof ApiError
          ? error
          : new ApiError(502, "source_write_failed", "The external action failed.");
        const partialWrite = safeError.code === "partial_source_write";
        const stored = updateExecution(scopedStore, execution.id, {
          status: "failed",
          externalCallMade: partialWrite,
          reason: { code: safeError.code, message: safeError.message },
          completedAt: now().toISOString(),
          recovery: {
            required: partialWrite,
            instructions: partialWrite
              ? `TestRail section S${safeError.details?.sectionId ?? "unknown"} was created. `
                + "Select that section and approve a new case-creation preview before retrying."
              : "No confirmed external change was recorded. Verify TestRail before retrying.",
          },
        });
        await auditExecution(stored);
        return { execution: stored };
      }
    },

    records(scopedProductId) {
      assertServiceScope(scopedProductId);
      return storeFor(scopedProductId).read();
    },
  };

  async function auditExecution(execution) {
    await audit({
      eventType: "approved_action.execution",
      operation: "execute_approved_action",
      subject: execution.subject,
      productId: execution.productId,
      actionType: execution.actionType,
      previewId: execution.previewId,
      approvalId: execution.approvalId,
      executionId: execution.id,
      previewHash: execution.previewHash,
      outcome: execution.status,
      externalCallMade: execution.externalCallMade,
    });
  }
}

function consumeApprovalAndStoreExecution(store, approvalId, execution) {
  return store.transact((draft) => {
    const durableApproval = draft.approvals.find((candidate) => candidate.id === approvalId);
    if (durableApproval.status !== "approved" || durableApproval.consumedAt !== null) {
      throw new ApiError(
        409,
        "action_approval_consumed",
        "The one-time approval was already used.",
      );
    }

    durableApproval.status = "consumed";
    durableApproval.consumedAt = execution.attemptedAt;
    draft.executions.push(execution);
    return execution;
  });
}

function updateExecution(store, executionId, changes) {
  return store.transact((draft) => {
    const execution = draft.executions.find((candidate) => candidate.id === executionId);
    if (!execution) {
      throw new ApiError(409, "action_execution_missing", "The action execution is unavailable.");
    }
    Object.assign(execution, changes);
    return execution;
  });
}

function assertBoundPreview(preview, request) {
  if (
    preview.productId !== request.productId
    || preview.subject !== request.subject
    || preview.actionType !== request.actionType
    || !safeEqual(preview.previewHash, request.previewHash)
  ) {
    throw new ApiError(
      409,
      "action_preview_mismatch",
      "Approval does not match the immutable preview, subject, action type, and product scope.",
    );
  }
}

function assertBoundApproval(approval, preview, request) {
  if (
    approval.productId !== request.productId
    || approval.subject !== request.subject
    || approval.actionType !== request.actionType
    || !safeEqual(approval.previewHash, request.previewHash)
    || !safeEqual(preview.previewHash, request.previewHash)
  ) {
    throw new ApiError(
      409,
      "action_approval_mismatch",
      "Execution does not match the approved immutable preview, subject, action type, and product scope.",
    );
  }
}

function assertSourceVersionsMatch(expected, actual, code = "source_version_mismatch") {
  if (!safeEqual(requestHash(expected), requestHash(actual))) {
    throw new ApiError(
      409,
      code,
      code === "stale_source_version"
        ? "Source data changed after preview; generate and approve a new preview."
        : "Execution source versions do not match the approved preview.",
    );
  }
}
