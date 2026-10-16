import { ApiError } from "./errors.js";
import { SOURCE_IDS } from "../../../packages/contracts/src/index.js";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CLAIM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const REVIEW_NOTE_MAX_LENGTH = 2000;
const MAX_APPROVED_CLAIM_IDS = 50;
const SOURCE_CONFIG_VALUE_MAX_LENGTH = 2048;
const SOURCE_CREDENTIAL_MAX_LENGTH = 8192;
const MAX_GITHUB_REPOSITORIES = 50;
const GITHUB_REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GITHUB_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GITHUB_REPOSITORY_PURPOSES = new Set([
  "application",
  "test-automation",
  "quality-evidence",
  "documentation",
  "shared-library",
  "other"
]);
const GITHUB_REPOSITORY_LIFECYCLES = new Set([
  "active",
  "maintenance",
  "deprecated",
  "archived"
]);
const JIRA_WORK_ITEM_PATTERN = /^[A-Z]{2,}[A-Z0-9_]*-\d+$/;
const ASK_TKL_QUESTION_MAX_LENGTH = 2000;
const ACTION_ID_PATTERN = /^(?:preview|approval):[0-9a-f-]{36}$/;
const ACTION_HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ACTION_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,255}$/;
const ACTION_TYPES = new Set([
  "testrail.case.create",
  "testrail.case.update",
  "github.branch.create",
  "github.pull-request.create",
]);
const SOURCE_CONFIG_KEYS = {
  jira: new Set(["baseUrl", "allowedProjects", "allowedJql"]),
  github: new Set(["apiUrl", "webBaseUrl", "repositories"]),
  testrail: new Set(["baseUrl", "username", "projectId", "suiteScope", "suiteIds"]),
  confluence: new Set([
    "baseUrl",
    "username",
    "authMode",
    "spaceKeys",
    "contentScope",
    "rootPageRefs",
    "rootPageUrls"
  ]),
  reportportal: new Set(["baseUrl", "project"])
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireQueryValue(searchParams, name, pattern, message) {
  const value = searchParams.get(name);
  if (!value || !pattern.test(value)) {
    throw new ApiError(400, "invalid_request", message, { parameter: name });
  }
  return value;
}

export function validateProductId(searchParams) {
  return requireQueryValue(
    searchParams,
    "productId",
    PRODUCT_ID_PATTERN,
    "productId is required and must contain only letters, numbers, '.', '_' or '-'."
  );
}

export function validateResourceId(searchParams, name) {
  return requireQueryValue(
    searchParams,
    name,
    RESOURCE_ID_PATTERN,
    `${name} is required and contains invalid characters.`
  );
}

export function parseLimit(searchParams) {
  const rawLimit = searchParams.get("limit");
  if (rawLimit === null) {
    return 20;
  }

  if (!/^[0-9]+$/.test(rawLimit)) {
    throw new ApiError(400, "invalid_request", "limit must be an integer from 1 to 100.", {
      parameter: "limit"
    });
  }

  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, "invalid_request", "limit must be an integer from 1 to 100.", {
      parameter: "limit"
    });
  }
  return limit;
}

export function parseOffset(searchParams) {
  const rawOffset = searchParams.get("offset");
  if (rawOffset === null) return 0;
  if (!/^[0-9]+$/.test(rawOffset)) {
    throw new ApiError(400, "invalid_request", "offset must be a non-negative integer.", {
      parameter: "offset"
    });
  }
  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(offset)) {
    throw new ApiError(400, "invalid_request", "offset must be a non-negative integer.", {
      parameter: "offset"
    });
  }
  return offset;
}

export function parseSearchRequest(url) {
  return {
    productId: validateProductId(url.searchParams),
    source: validateSource(url.searchParams),
    query: url.searchParams.get("query") ?? "",
    limit: parseLimit(url.searchParams),
    offset: parseOffset(url.searchParams)
  };
}

export function parseArtifactResolveRequest(url) {
  const productId = validateProductId(url.searchParams);
  const query = (url.searchParams.get("query") ?? "").trim();
  if (query.length < 1 || query.length > 200) {
    throw new ApiError(
      400,
      "invalid_request",
      "query must contain between 1 and 200 characters.",
      { parameter: "query" }
    );
  }
  return {
    productId,
    query,
    limit: Math.min(parseLimit(url.searchParams), 20)
  };
}

export function parseEvidenceGraphRequest(url) {
  const productId = validateProductId(url.searchParams);
  const entityId = (url.searchParams.get("entityId") ?? "").trim();
  if (
    entityId.length === 0
    || entityId.length > 255
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/.test(entityId)
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "entityId is required and contains invalid characters.",
      { parameter: "entityId" },
    );
  }
  return { productId, entityId };
}

export function parseResourceRequest(url, resourceName) {
  return {
    productId: validateProductId(url.searchParams),
    source: validateSource(url.searchParams),
    [resourceName]: validateResourceId(url.searchParams, resourceName)
  };
}

export function parseProductRequest(url) {
  return {
    productId: validateProductId(url.searchParams),
    source: validateSource(url.searchParams)
  };
}

export function parseTicketContextOperationsRequest(url) {
  const unsupported = [...url.searchParams.keys()].find((key) => key !== "productId");
  if (unsupported) {
    throw new ApiError(
      400,
      "invalid_request",
      "The ticket context operations request contains an unsupported parameter.",
      { parameter: unsupported }
    );
  }
  return { productId: validateProductId(url.searchParams) };
}

export function parseTicketContextJobRequest(url, pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/v1/context-jobs/([^/]+)/${suffix}$`)
    : /^\/v1\/context-jobs\/([^/]+)$/;
  const match = pathname.match(pattern);
  let issueKey = "";
  try {
    issueKey = decodeURIComponent(match?.[1] ?? "").trim().toUpperCase();
  } catch {
    issueKey = "";
  }
  if (!JIRA_WORK_ITEM_PATTERN.test(issueKey)) {
    throw new ApiError(
      400,
      "invalid_request",
      "issueKey must be a Jira key such as STT-3731.",
      { parameter: "issueKey" }
    );
  }
  return {
    productId: validateProductId(url.searchParams),
    issueKey
  };
}

export function parseCoverageContextAgentRequest(
  url,
  body,
  { allowTestRailScope = false } = {},
) {
  const productId = validateProductId(url.searchParams);
  if (!isRecord(body)) {
    throw new ApiError(400, "invalid_request", "A JSON request body is required.");
  }

  const allowedFields = new Set([
    "workItemId",
    ...(allowTestRailScope ? ["suiteId", "sectionId", "designMode"] : []),
  ]);
  const unknownFields = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unknownFields.length > 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "The agent request contains unsupported fields.",
      { parameter: unknownFields[0] },
    );
  }
  const workItemId = typeof body.workItemId === "string"
    ? body.workItemId.trim().toUpperCase()
    : "";
  if (!JIRA_WORK_ITEM_PATTERN.test(workItemId)) {
    throw new ApiError(
      400,
      "invalid_request",
      "workItemId must be a Jira key such as STT-3731.",
      { parameter: "workItemId" },
    );
  }
  if (!allowTestRailScope) return { productId, workItemId };
  const normalizeId = (value) => {
    const text = typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
    return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text).toString() : null;
  };
  const suiteId = normalizeId(body.suiteId);
  const sectionId = normalizeId(body.sectionId);
  const designMode = body.designMode;
  if (
    designMode !== undefined
    && designMode !== "automation-ready"
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "designMode must be automation-ready."
    );
  }
  if ((suiteId && !sectionId) || (!suiteId && sectionId)) {
    throw new ApiError(
      400,
      "invalid_request",
      "suiteId and sectionId must be provided together."
    );
  }
  if (
    (body.suiteId !== undefined && !suiteId)
    || (body.sectionId !== undefined && !sectionId)
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "suiteId and sectionId must be positive integers."
    );
  }
  if (designMode === "automation-ready" && (!suiteId || !sectionId)) {
    throw new ApiError(
      400,
      "invalid_request",
      "Automation-ready design requires suiteId and sectionId."
    );
  }
  return {
    productId,
    workItemId,
    ...(suiteId && sectionId ? { suiteId, sectionId } : {}),
    ...(designMode ? { designMode } : {}),
  };
}

export function parseTestRailCaseImprovementRequest(url, pathname) {
  const productId = validateProductId(url.searchParams);
  const match = pathname.match(
    /^\/v1\/agents\/testrail-improvement\/cases\/C?(\d+)\/runs$/i
  );
  if (!match || BigInt(match[1]) <= 0n) {
    throw new ApiError(
      400,
      "invalid_request",
      "caseId must be a positive TestRail case ID.",
      { parameter: "caseId" }
    );
  }
  return {
    productId,
    caseId: BigInt(match[1]).toString()
  };
}

export function parseReportPortalReliabilityRequest(url, body) {
  const productId = validateProductId(url.searchParams);
  if (!isRecord(body)) {
    throw new ApiError(400, "invalid_request", "A JSON request body is required.");
  }
  const unknownFields = Object.keys(body).filter((key) => key !== "identity");
  if (unknownFields.length > 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "The ReportPortal reliability request contains unsupported fields.",
      { parameter: unknownFields[0] },
    );
  }
  const identity = typeof body.identity === "string" ? body.identity.trim() : "";
  if (identity.length === 0 || identity.length > 500) {
    throw new ApiError(
      400,
      "invalid_request",
      "identity must contain between 1 and 500 characters.",
      { parameter: "identity" },
    );
  }
  if (!/^https?:\/\//i.test(identity)) return { productId, identity };
  try {
    const reportPortalUrl = new URL(identity);
    const hashQuery = reportPortalUrl.hash.includes("?")
      ? reportPortalUrl.hash.slice(reportPortalUrl.hash.indexOf("?") + 1)
      : "";
    const hashParams = new URLSearchParams(hashQuery);
    const nestedParams = new URLSearchParams(hashParams.get("item0Params") ?? "");
    const extractedIdentity =
      nestedParams.get("filter.eq.uniqueId")
      ?? nestedParams.get("filter.eq.codeRef")
      ?? hashParams.get("filter.eq.uniqueId")
      ?? hashParams.get("filter.eq.codeRef");
    if (!extractedIdentity) throw new Error("missing identity");
    return { productId, identity: extractedIdentity, retrievalIdentity: identity };
  } catch {
    throw new ApiError(
      400,
      "invalid_request",
      "ReportPortal URLs must include a uniqueId or codeRef filter.",
      { parameter: "identity" },
    );
  }
}

export function parseAskTklRequest(url, body) {
  const productId = validateProductId(url.searchParams);
  if (!isRecord(body)) {
    throw new ApiError(400, "invalid_request", "A JSON request body is required.");
  }
  const unknownFields = Object.keys(body)
    .filter((key) => !["question", "workItemId"].includes(key));
  if (unknownFields.length > 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "The Ask TKL request contains unsupported fields.",
      { parameter: unknownFields[0] },
    );
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question.length < 3 || question.length > ASK_TKL_QUESTION_MAX_LENGTH) {
    throw new ApiError(
      400,
      "invalid_request",
      `question must contain between 3 and ${ASK_TKL_QUESTION_MAX_LENGTH} characters.`,
      { parameter: "question" },
    );
  }
  let workItemId;
  if (body.workItemId !== undefined) {
    workItemId = typeof body.workItemId === "string"
      ? body.workItemId.trim().toUpperCase()
      : "";
    if (!JIRA_WORK_ITEM_PATTERN.test(workItemId)) {
      throw new ApiError(
        400,
        "invalid_request",
        "workItemId must be a Jira key such as STT-3731.",
        { parameter: "workItemId" },
      );
    }
  }
  return { productId, question, ...(workItemId ? { workItemId } : {}) };
}

export function parseApprovedActionPreviewRequest(url, body) {
    const productId = validateProductId(url.searchParams);
    assertActionBody(body, ["actionType", "target", "changes", "sourceVersions", "idempotencyKey"]);
    const actionType = parseActionType(body.actionType);
    const target = parseActionTarget(actionType, body.target);
    const changes = parseSafeActionObject(body.changes, "changes");
    if (Object.keys(changes).length === 0) {
      throw new ApiError(400, "invalid_request", "changes must not be empty.", {
        parameter: "changes",
      });
    }
    const sourceVersions = parseSourceVersions(body.sourceVersions, actionType);
    return {
      productId,
      actionType,
      target,
      changes,
      sourceVersions,
      idempotencyKey: parseIdempotencyKey(body.idempotencyKey),
    };
  }

  export function parseApprovedActionApprovalRequest(url, body) {
    const productId = validateProductId(url.searchParams);
    assertActionBody(body, ["actionType", "previewId", "previewHash", "idempotencyKey"]);
    return {
      productId,
      actionType: parseActionType(body.actionType),
      previewId: parseActionId(body.previewId, "previewId", "preview"),
      previewHash: parsePreviewHash(body.previewHash),
      idempotencyKey: parseIdempotencyKey(body.idempotencyKey),
    };
  }

  export function parseApprovedActionExecutionRequest(url, body) {
    const productId = validateProductId(url.searchParams);
    assertActionBody(body, [
      "actionType",
      "approvalId",
      "previewHash",
      "sourceVersions",
      "idempotencyKey",
    ]);
    const actionType = parseActionType(body.actionType);
    return {
      productId,
      actionType,
      approvalId: parseActionId(body.approvalId, "approvalId", "approval"),
      previewHash: parsePreviewHash(body.previewHash),
      sourceVersions: parseSourceVersions(body.sourceVersions, actionType),
      idempotencyKey: parseIdempotencyKey(body.idempotencyKey),
    };
  }

  function assertActionBody(body, allowedFields) {
    if (!isRecord(body)) {
      throw new ApiError(400, "invalid_request", "A JSON request body is required.");
    }
    const unknown = Object.keys(body).find((key) => !allowedFields.includes(key));
    if (unknown) {
      throw new ApiError(400, "invalid_request", "The action request contains unsupported fields.", {
        parameter: unknown,
      });
    }
    const missing = allowedFields.find((key) => !(key in body));
    if (missing) {
      throw new ApiError(400, "invalid_request", `${missing} is required.`, {
        parameter: missing,
      });
    }
  }

  function parseActionType(value) {
    if (typeof value !== "string" || !ACTION_TYPES.has(value)) {
      throw new ApiError(400, "invalid_request", "actionType is not supported.", {
        parameter: "actionType",
        allowed: [...ACTION_TYPES],
      });
    }
    return value;
  }

  function parseActionId(value, parameter, prefix) {
    if (
      typeof value !== "string"
      || !ACTION_ID_PATTERN.test(value)
      || !value.startsWith(`${prefix}:`)
    ) {
      throw new ApiError(400, "invalid_request", `${parameter} is invalid.`, { parameter });
    }
    return value;
  }

  function parsePreviewHash(value) {
    if (typeof value !== "string" || !ACTION_HASH_PATTERN.test(value)) {
      throw new ApiError(400, "invalid_request", "previewHash must be a SHA-256 hash.", {
        parameter: "previewHash",
      });
    }
    return value;
  }

  function parseIdempotencyKey(value) {
    if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new ApiError(
        400,
        "invalid_request",
        "idempotencyKey must contain 8-128 safe characters.",
        { parameter: "idempotencyKey" },
      );
    }
    return value;
  }

  function parseActionTarget(actionType, value) {
    const targets = {
      "testrail.case.create": ["sectionId", "suiteId", "newSectionName"],
      "testrail.case.update": ["caseId"],
      "github.branch.create": ["repository", "baseBranch", "branchName"],
      "github.pull-request.create": ["repository", "headBranch", "baseBranch"],
    };
    const required = {
      "testrail.case.create": [],
      "testrail.case.update": ["caseId"],
      "github.branch.create": ["repository", "baseBranch", "branchName"],
      "github.pull-request.create": ["repository", "headBranch", "baseBranch"],
    };
    if (!isRecord(value)) {
      throw new ApiError(400, "invalid_request", "target must be a JSON object.", {
        parameter: "target",
      });
    }
    const unexpected = Object.keys(value).find((key) => !targets[actionType].includes(key));
    if (unexpected) {
      throw new ApiError(400, "invalid_request", `target.${unexpected} is not supported.`, {
        parameter: `target.${unexpected}`,
      });
    }
    for (const key of required[actionType]) {
      if (typeof value[key] !== "string" || !ACTION_VALUE_PATTERN.test(value[key])) {
        throw new ApiError(400, "invalid_request", `target.${key} is required or invalid.`, {
          parameter: `target.${key}`,
        });
      }
    }
    const target = {};
    for (const key of targets[actionType]) {
      if (value[key] !== undefined) {
        if (
          key === "newSectionName"
          && (
            typeof value[key] !== "string"
            || value[key].trim().length === 0
            || value[key].trim().length > 250
          )
        ) {
          throw new ApiError(400, "invalid_request", `target.${key} is invalid.`, {
            parameter: `target.${key}`,
          });
        }
        if (
          key !== "newSectionName"
          && (typeof value[key] !== "string" || !ACTION_VALUE_PATTERN.test(value[key]))
        ) {
          throw new ApiError(400, "invalid_request", `target.${key} is invalid.`, {
            parameter: `target.${key}`,
          });
        }
        target[key] = typeof value[key] === "string" ? value[key].trim() : value[key];
      }
    }
    if (actionType === "testrail.case.create") {
      const hasSectionId = typeof target.sectionId === "string";
      const hasNewSection = typeof target.suiteId === "string"
        && typeof target.newSectionName === "string";
      for (const key of ["sectionId", "suiteId"]) {
        if (
          target[key] !== undefined
          && (!/^\d+$/.test(target[key]) || BigInt(target[key]) <= 0n)
        ) {
          throw new ApiError(400, "invalid_request", `target.${key} must be a positive integer.`, {
            parameter: `target.${key}`,
          });
        }
      }
      if (hasSectionId === hasNewSection) {
        throw new ApiError(
          400,
          "invalid_request",
          "target must identify either one existing sectionId or one suiteId and newSectionName.",
          { parameter: "target" },
        );
      }
    }
    return target;
  }

  function parseSafeActionObject(value, parameter) {
    if (!isRecord(value)) {
      throw new ApiError(400, "invalid_request", `${parameter} must be a JSON object.`, {
        parameter,
      });
    }
    const serialized = JSON.stringify(value);
    if (serialized.length > 16_384) {
      throw new ApiError(400, "invalid_request", `${parameter} is too large.`, { parameter });
    }
    assertSafeJson(value, parameter, 0);
    return structuredClone(value);
  }

  function assertSafeJson(value, path, depth) {
    if (depth > 8) {
      throw new ApiError(400, "invalid_request", `${path} is nested too deeply.`, {
        parameter: path,
      });
    }
    if (Array.isArray(value)) {
      if (value.length > 100) {
        throw new ApiError(400, "invalid_request", `${path} contains too many values.`, {
          parameter: path,
        });
      }
      value.forEach((entry, index) => assertSafeJson(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (/(authorization|token|secret|password|credential|api[-_]?key)/i.test(key)) {
          throw new ApiError(
            400,
            "invalid_request",
            "Action previews must not contain credentials or secret-like fields.",
            { parameter: `${path}.${key}` },
          );
        }
        assertSafeJson(entry, `${path}.${key}`, depth + 1);
      }
      return;
    }
    if (
      value !== null
      && typeof value !== "string"
      && typeof value !== "number"
      && typeof value !== "boolean"
    ) {
      throw new ApiError(400, "invalid_request", `${path} contains an unsupported value.`, {
        parameter: path,
      });
    }
  }

  function parseSourceVersions(value, actionType) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
      throw new ApiError(
        400,
        "invalid_request",
        "sourceVersions must contain between 1 and 20 source version records.",
        { parameter: "sourceVersions" },
      );
    }
    const expectedSource = actionType === "testrail.case.create"
      ? "jira"
      : actionType.startsWith("testrail.") ? "testrail" : "github";
    const parsed = value.map((entry, index) => {
      if (
        !isRecord(entry)
        || entry.source !== expectedSource
        || typeof entry.sourceId !== "string"
        || !ACTION_VALUE_PATTERN.test(entry.sourceId)
        || typeof entry.sourceVersion !== "string"
        || !ACTION_VALUE_PATTERN.test(entry.sourceVersion)
      ) {
        throw new ApiError(
          400,
          "invalid_request",
          `sourceVersions[${index}] must identify a valid ${expectedSource} source and version.`,
          { parameter: `sourceVersions[${index}]` },
        );
      }
      return {
        source: entry.source,
        sourceId: entry.sourceId,
        sourceVersion: entry.sourceVersion,
      };
    });
    return parsed.sort((left, right) =>
      `${left.source}:${left.sourceId}`.localeCompare(`${right.source}:${right.sourceId}`));
  }
export function parseResourceReadRequest(url) {
  const productId = validateProductId(url.searchParams);
  const uri = url.searchParams.get("uri");
  if (!uri || uri.length > 512 || !isValidProductResourceUri(uri, productId)) {
    throw new ApiError(400, "invalid_request", "uri is required and must be a valid TKL resource URI.", {
      parameter: "uri"
    });
  }
  return { productId, uri };
}

function isValidProductResourceUri(uri, productId) {
  try {
    const resource = new URL(uri);
    const segments = resource.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (
      resource.protocol !== "tkl:"
      || resource.hostname !== "products"
      || segments[0] !== productId
    ) {
      return false;
    }
    return (
      (segments.length === 3
        && ["features", "requirements", "traceability"].includes(segments[1]))
      || (segments.length === 5
        && segments[1] === "sources"
        && segments[4] === "provenance")
    );
  } catch {
    return false;
  }
}

export function validateSource(searchParams) {
  const source = searchParams.get("source");
  if (source === null) {
    return undefined;
  }
  if (!SOURCE_IDS.includes(source)) {
    throw new ApiError(400, "invalid_request", "source is not supported.", {
      parameter: "source",
      allowed: SOURCE_IDS
    });
  }
  return source;
}

export function parseKnowledgeConflictReviewRequest(url, body) {
  const productId = validateProductId(url.searchParams);
  const source = validateSource(url.searchParams);

  if (!isRecord(body)) {
    throw new ApiError(400, "invalid_request", "A JSON request body is required.");
  }

  const { conflictId, approvedClaimIds, note } = body;
  if (typeof conflictId !== "string" || !RESOURCE_ID_PATTERN.test(conflictId)) {
    throw new ApiError(
      400,
      "invalid_request",
      "conflictId is required and contains invalid characters.",
      { parameter: "conflictId" }
    );
  }

  if (
    !Array.isArray(approvedClaimIds)
    || approvedClaimIds.length === 0
    || approvedClaimIds.length > MAX_APPROVED_CLAIM_IDS
    || !approvedClaimIds.every((id) => typeof id === "string" && CLAIM_ID_PATTERN.test(id))
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `approvedClaimIds must be a non-empty array of at most ${MAX_APPROVED_CLAIM_IDS} claim IDs.`,
      { parameter: "approvedClaimIds" }
    );
  }

  if (
    note !== undefined
    && (typeof note !== "string" || note.trim().length === 0 || note.length > REVIEW_NOTE_MAX_LENGTH)
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `note must be a non-empty string of at most ${REVIEW_NOTE_MAX_LENGTH} characters when provided.`,
      { parameter: "note" }
    );
  }

  return {
    productId,
    source,
    conflictId,
    approvedClaimIds: [...new Set(approvedClaimIds)],
    note
  };
}

export function parseSourceConnectionRequest(url, pathname, body) {
  const productId = validateProductId(url.searchParams);
  const source = parseSourceConnectionPath(pathname);
  if (!isRecord(body)) {
    throw new ApiError(400, "invalid_request", "A JSON request body is required.");
  }
  if (
    typeof body.credential !== "string"
    || body.credential.trim().length === 0
    || body.credential.length > SOURCE_CREDENTIAL_MAX_LENGTH
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `credential must be a non-empty string of at most ${SOURCE_CREDENTIAL_MAX_LENGTH} characters.`,
      { parameter: "credential" }
    );
  }
  const config = validateSourceConnectionConfig(source, body.config);
  return { productId, source, credential: body.credential, config };
}

export function parseTestRailSuiteDiscoveryRequest(url, body) {
  const productId = validateProductId(url.searchParams);
  if (!isRecord(body)) {
    throw new ApiError(400, "invalid_request", "A JSON request body is required.");
  }
  if (
    typeof body.credential !== "string"
    || body.credential.trim().length === 0
    || body.credential.length > SOURCE_CREDENTIAL_MAX_LENGTH
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `credential must be a non-empty string of at most ${SOURCE_CREDENTIAL_MAX_LENGTH} characters.`,
      { parameter: "credential" }
    );
  }
  const config = validateSourceConnectionConfig("testrail", {
    ...body.config,
    suiteScope: "all"
  });
  return { productId, credential: body.credential, config };
}

export function parseTestRailSectionDiscoveryRequest(url, body) {
  const productId = validateProductId(url.searchParams);
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "suiteId")) {
    throw new ApiError(400, "invalid_request", "A suiteId JSON field is required.");
  }
  const rawSuiteId = typeof body.suiteId === "string" || typeof body.suiteId === "number"
    ? String(body.suiteId).trim()
    : "";
  if (!/^\d+$/.test(rawSuiteId) || BigInt(rawSuiteId) <= 0n) {
    throw new ApiError(400, "invalid_request", "suiteId must be a positive integer.", {
      parameter: "suiteId"
    });
  }
  return { productId, suiteId: BigInt(rawSuiteId).toString() };
}

export function parseConfluencePageDiscoveryRequest(url, body) {
  const productId = validateProductId(url.searchParams);
  if (!isRecord(body)) {
    throw new ApiError(400, "invalid_request", "A JSON request body is required.");
  }
  if (
    typeof body.credential !== "string"
    || body.credential.trim().length === 0
    || body.credential.length > SOURCE_CREDENTIAL_MAX_LENGTH
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `credential must be a non-empty string of at most ${SOURCE_CREDENTIAL_MAX_LENGTH} characters.`,
      { parameter: "credential" }
    );
  }
  if (!isRecord(body.config) || typeof body.config.username !== "string" || !body.config.username.trim()) {
    throw new ApiError(400, "invalid_request", "config.username is required.", {
      parameter: "config.username"
    });
  }
  if (
    !Array.isArray(body.config.rootPageUrls)
    || body.config.rootPageUrls.length === 0
    || body.config.rootPageUrls.length > 20
    || !body.config.rootPageUrls.every(
      (pageUrl) =>
        typeof pageUrl === "string"
        && pageUrl.trim().length > 0
        && pageUrl.length <= SOURCE_CONFIG_VALUE_MAX_LENGTH
    )
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "config.rootPageUrls must contain between 1 and 20 Confluence page URLs.",
      { parameter: "config.rootPageUrls" }
    );
  }
  return {
    productId,
    credential: body.credential,
    config: {
      username: body.config.username.trim(),
      authMode: parseConfluenceAuthMode(body.config.authMode, body.config.rootPageUrls),
      rootPageUrls: [...new Set(body.config.rootPageUrls.map((pageUrl) => pageUrl.trim()))]
    }
  };
}

export function parseSourceConnectionProductRequest(url, pathname) {
  return {
    productId: validateProductId(url.searchParams),
    source: parseSourceConnectionPath(pathname)
  };
}

export function parseGitHubRepositoryProductRequest(url, pathname) {
  const match =
    /^\/v1\/source-connections\/github\/repositories\/([a-z0-9][a-z0-9_-]{0,63})(?:\/(?:test|sync))?$/
      .exec(pathname);
  if (!match) {
    throw new ApiError(404, "not_found", "GitHub repository target was not found.");
  }
  return {
    productId: validateProductId(url.searchParams),
    repositoryId: match[1]
  };
}

export function parseGitHubRepositoryCreateRequest(url, body) {
  return {
    productId: validateProductId(url.searchParams),
    repository: parseGitHubRepositoryBody(body, false)
  };
}

export function parseGitHubRepositoryUpdateRequest(url, pathname, body) {
  return {
    ...parseGitHubRepositoryProductRequest(url, pathname),
    changes: parseGitHubRepositoryBody(body, true)
  };
}

export function parseSourceConnectionPath(pathname) {
  const match = /^\/v1\/source-connections\/([^/]+)(?:\/(?:test|sync))?$/.exec(pathname);
  const source = match?.[1];
  if (!source || !SOURCE_IDS.includes(source)) {
    throw new ApiError(404, "not_found", "Source connection was not found.");
  }
  return source;
}

function validateSourceConnectionConfig(source, value) {
  if (!isRecord(value)) {
    throw new ApiError(400, "invalid_request", "config must be a JSON object.", {
      parameter: "config"
    });
  }
  const allowedKeys = SOURCE_CONFIG_KEYS[source];
  const config = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowedKeys.has(key)) {
      throw new ApiError(400, "invalid_request", `config.${key} is not supported.`, {
        parameter: `config.${key}`
      });
    }
    if (source === "github" && key === "repositories") {
      const entries = typeof entry === "string" ? [entry] : entry;
      if (
        !Array.isArray(entries)
        || entries.length === 0
        || entries.length > MAX_GITHUB_REPOSITORIES
        || !entries.every(
          (item) =>
            typeof item === "string"
            && GITHUB_REPOSITORY_PATTERN.test(
              item.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
            )
        )
      ) {
        throw new ApiError(
          400,
          "invalid_request",
          `config.repositories must contain between 1 and ${MAX_GITHUB_REPOSITORIES} owner/name repositories.`,
          { parameter: "config.repositories" }
        );
      }
      const normalized = entries.map(
        (item) => item.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
      );
      const unique = new Set(normalized.map((item) => item.toLowerCase()));
      if (unique.size !== normalized.length) {
        throw new ApiError(
          400,
          "invalid_request",
          "config.repositories contains duplicate normalized repositories.",
          { parameter: "config.repositories" }
        );
      }
      config[key] = normalized;
    } else if (Array.isArray(entry)) {
      if (
        entry.length === 0
        || entry.length > 100
        || !entry.every((item) =>
        typeof item === "string"
        && item.trim().length > 0
        && item.length <= SOURCE_CONFIG_VALUE_MAX_LENGTH)
      ) {
        throw new ApiError(400, "invalid_request", `config.${key} contains invalid values.`, {
          parameter: `config.${key}`
        });
      }
      config[key] = [...new Set(entry.map((item) => item.trim()))];
    } else if (
      typeof entry !== "string"
      || entry.trim().length === 0
      || entry.length > SOURCE_CONFIG_VALUE_MAX_LENGTH
    ) {
      throw new ApiError(400, "invalid_request", `config.${key} must be a non-empty string.`, {
        parameter: `config.${key}`
      });
    } else {
      config[key] = entry.trim();
    }
  }
  validateRequiredConfig(source, config);
  return config;
}

function validateRequiredConfig(source, config) {
  const requirements = {
    jira: ["baseUrl", "allowedProjects", "allowedJql"],
    github: ["repositories"],
    testrail: ["baseUrl", "username", "projectId"],
    confluence: ["baseUrl", "username", "spaceKeys"],
    reportportal: ["baseUrl", "project"]
  };
  for (const key of requirements[source]) {
    if (!(key in config)) {
      throw new ApiError(400, "invalid_request", `config.${key} is required.`, {
        parameter: `config.${key}`
      });
    }
  }

  if (
    source === "jira"
    && config.allowedProjects.some(
      (project) => project.toUpperCase() === config.allowedJql.toUpperCase()
    )
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `config.allowedJql must be a complete Jira query, for example "project = ${config.allowedProjects[0]}".`,
      { parameter: "config.allowedJql" }
    );
  }
  if (
    source === "github"
    && (
      config.repositories.length < 1
      || config.repositories.length > MAX_GITHUB_REPOSITORIES
    )
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `config.repositories must contain between 1 and ${MAX_GITHUB_REPOSITORIES} allowlisted repositories.`,
      { parameter: "config.repositories" }
    );
  }
  if (
    source === "github"
    && config.apiUrl
    && config.apiUrl !== "https://api.github.com"
    && !config.webBaseUrl
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "config.webBaseUrl is required for a custom GitHub API URL.",
      { parameter: "config.webBaseUrl" }
    );
  }
  if (source === "testrail") {
    const suiteScope = config.suiteScope ?? (config.suiteIds ? "selected" : "all");
    if (!["all", "selected"].includes(suiteScope)) {
      throw new ApiError(
        400,
        "invalid_request",
        'config.suiteScope must be either "all" or "selected".',
        { parameter: "config.suiteScope" }
      );
    }
    config.suiteScope = suiteScope;
    if (suiteScope === "selected" && !config.suiteIds) {
      throw new ApiError(
        400,
        "invalid_request",
        "config.suiteIds is required when config.suiteScope is selected.",
        { parameter: "config.suiteIds" }
      );
    }
    if (suiteScope === "all") delete config.suiteIds;
  }
  if (source === "confluence") {
    const authMode = config.authMode ?? "basic";
    if (!["basic", "bearer"].includes(authMode)) {
      throw new ApiError(
        400,
        "invalid_request",
        'config.authMode must be "basic" or "bearer".',
        { parameter: "config.authMode" }
      );
    }
    config.authMode = authMode;
    const contentScope = config.contentScope ?? "space";
    if (!["tree", "page", "space"].includes(contentScope)) {
      throw new ApiError(
        400,
        "invalid_request",
        'config.contentScope must be "tree", "page", or "space".',
        { parameter: "config.contentScope" }
      );
    }

    config.contentScope = contentScope;
    if (contentScope !== "space") {
      if (!config.rootPageRefs || !config.rootPageUrls) {
        throw new ApiError(
          400,
          "invalid_request",
          "config.rootPageRefs and config.rootPageUrls are required for page-scoped Confluence connections.",
          { parameter: "config.rootPageRefs" }
        );
      }
      if (
        config.rootPageRefs.length !== config.rootPageUrls.length
        || !config.rootPageRefs.every((reference) => /^\d+:[^:]+$/.test(reference))
      ) {
        throw new ApiError(
          400,
          "invalid_request",
          "config.rootPageRefs must align with rootPageUrls and use pageId:spaceKey values.",
          { parameter: "config.rootPageRefs" }
        );
      }
    }

  }
}

function parseGitHubRepositoryBody(body, partial) {
  if (!isRecord(body)) {
    throw new ApiError(400, "invalid_request", "A JSON request body is required.");
  }
  const allowed = partial
    ? new Set(["repository", "url", "purpose", "lifecycle", "enabled"])
    : new Set(["id", "repository", "url", "purpose", "lifecycle", "enabled"]);
  const unexpected = Object.keys(body).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new ApiError(
      400,
      "invalid_request",
      `${unexpected} is not supported for a GitHub repository target.`,
      { parameter: unexpected }
    );
  }
  if (partial && Object.keys(body).length === 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "At least one repository target field must be supplied."
    );
  }
  const parsed = {};
  if (!partial || body.repository !== undefined) {
    if (
      typeof body.repository !== "string"
      || !GITHUB_REPOSITORY_PATTERN.test(
        body.repository.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
      )
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "repository must use owner/name syntax.",
        { parameter: "repository" }
      );
    }
    parsed.repository = body.repository
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "");
  }
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !GITHUB_REPOSITORY_ID_PATTERN.test(body.id)) {
      throw new ApiError(
        400,
        "invalid_request",
        "id must use lower-case letters, numbers, underscores, or hyphens.",
        { parameter: "id" }
      );
    }
    parsed.id = body.id;
  }
  if (body.url !== undefined) {
    let repositoryUrl;
    try {
      repositoryUrl = new URL(body.url);
    } catch {
      throw new ApiError(
        400,
        "invalid_request",
        "url must be a valid absolute HTTP(S) URL.",
        { parameter: "url" }
      );
    }
    if (
      !["https:", "http:"].includes(repositoryUrl.protocol)
      || repositoryUrl.username
      || repositoryUrl.password
      || repositoryUrl.search
      || repositoryUrl.hash
      || body.url.length > SOURCE_CONFIG_VALUE_MAX_LENGTH
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "url must not contain credentials, a query, or a fragment.",
        { parameter: "url" }
      );
    }
    parsed.url = repositoryUrl.toString().replace(/\/$/, "");
  }
  if (body.purpose !== undefined) {
    if (!GITHUB_REPOSITORY_PURPOSES.has(body.purpose)) {
      throw new ApiError(
        400,
        "invalid_request",
        "purpose is not a supported repository purpose.",
        { parameter: "purpose" }
      );
    }
    parsed.purpose = body.purpose;
  }
  if (body.lifecycle !== undefined) {
    if (!GITHUB_REPOSITORY_LIFECYCLES.has(body.lifecycle)) {
      throw new ApiError(
        400,
        "invalid_request",
        "lifecycle is not a supported repository lifecycle.",
        { parameter: "lifecycle" }
      );
    }
    parsed.lifecycle = body.lifecycle;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      throw new ApiError(
        400,
        "invalid_request",
        "enabled must be boolean.",
        { parameter: "enabled" }
      );
    }
    parsed.enabled = body.enabled;
  }
  return parsed;
}

function parseConfluenceAuthMode(value, rootPageUrls) {
  if (value !== undefined && !["basic", "bearer"].includes(value)) {
    throw new ApiError(
      400,
      "invalid_request",
      'config.authMode must be "basic" or "bearer".',
      { parameter: "config.authMode" }
    );
  }
  if (value) return value;
  try {
    return new URL(rootPageUrls[0]).hostname.toLowerCase().endsWith(".atlassian.net")
      ? "basic"
      : "bearer";
  } catch {
    return "bearer";
  }
}
