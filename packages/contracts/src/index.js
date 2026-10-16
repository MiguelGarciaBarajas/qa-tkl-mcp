import { createHash } from "node:crypto";

export const CONTRACT_VERSION = "0.1";
export const PRODUCT_CONFIG_VERSION = "0.1";
export const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
export const CREDENTIAL_REF_PATTERN = /^(?:secret|env):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
export const SOURCE_IDS = [
  "jira",
  "github",
  "testrail",
  "confluence",
  "reportportal",
  "qa-brain",
];
export const RAW_EVIDENCE_CLASSIFICATIONS = ["internal", "confidential", "restricted"];
export const SOURCE_CONFIGURATION_STATUSES = ["ready", "pending-external-input", "disabled"];
export const MAX_INCREMENTAL_LOOKBACK_SECONDS = 31_536_000;
const PRODUCT_CONFIGURATION_KEYS = new Set([
  "configVersion",
  "tenantId",
  "productId",
  "enabledPlugins",
  "plannedPlugins",
  "credentialRefs",
  "sources",
]);
const SECRET_LIKE_KEY_PARTS = [
  "apikey",
  "authorization",
  "credential",
  "password",
  "privatekey",
  "secret",
  "token",
];

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value))
    .digest("hex");
}

export function assertIncrementalLookbackSeconds(value) {
  if (value === undefined || value === null) return undefined;
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_INCREMENTAL_LOOKBACK_SECONDS
  ) {
    throw new TypeError(
      `incrementalLookbackSeconds must be an integer between 0 and `
        + `${MAX_INCREMENTAL_LOOKBACK_SECONDS}`,
    );
  }
  return value;
}

export function sourceTimestampMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return sourceTimestampMillis(Number(trimmed));
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sourceTimestampIso(value) {
  const milliseconds = sourceTimestampMillis(value);
  return milliseconds === null ? undefined : new Date(milliseconds).toISOString();
}

export function assertPluginManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new TypeError("Plugin manifest is required");
  for (const field of ["id", "version", "contractVersion"]) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
      throw new TypeError(`Plugin manifest field "${field}" is required`);
    }
  }
  if (!Array.isArray(manifest.capabilities) || !Array.isArray(manifest.requiredPermissions)) {
    throw new TypeError("Plugin manifest capabilities and requiredPermissions must be arrays");
  }
  return manifest;
}

export function assertRawEvidenceRecord(record) {
  for (const field of [
    "tenantId", "productId", "source", "sourceId", "sourceVersion",
    "observedAt", "contentType", "contentHash", "payload"
  ]) {
    if (!(field in (record ?? {}))) throw new TypeError(`Raw evidence field "${field}" is required`);
  }
  if (!RAW_EVIDENCE_CLASSIFICATIONS.includes(record.classification)) {
    throw new TypeError("Raw evidence classification is invalid");
  }
  return record;
}

export function createRawEvidenceRecord(input) {
  const record = { ...input, contentHash: input.contentHash ?? sha256(input.payload) };
  return assertRawEvidenceRecord(record);
}

export function validateProductConfiguration(value) {
  const errors = [];
  if (!isRecord(value)) return { valid: false, errors: ["Product configuration must be an object"] };
  for (const key of Object.keys(value)) {
    if (!PRODUCT_CONFIGURATION_KEYS.has(key)) {
      errors.push(`Product configuration field "${key}" is not allowed`);
    }
  }
  if (value.configVersion !== PRODUCT_CONFIG_VERSION) {
    errors.push(`configVersion must be "${PRODUCT_CONFIG_VERSION}"`);
  }
  for (const field of ["tenantId", "productId"]) {
    if (typeof value[field] !== "string" || !PRODUCT_ID_PATTERN.test(value[field])) {
      errors.push(`${field} is invalid`);
    }
  }

  const enabledPlugins = validatePluginList(value.enabledPlugins, "enabledPlugins", errors);
  const plannedPlugins = validatePluginList(
    value.plannedPlugins === undefined ? [] : value.plannedPlugins,
    "plannedPlugins",
    errors,
  );
  const overlap = enabledPlugins.find((id) => plannedPlugins.includes(id));
  if (overlap) errors.push(`Plugin "${overlap}" cannot be both enabled and planned`);

  if (!isRecord(value.credentialRefs)) {
    errors.push("credentialRefs must be an object");
  } else {
    for (const [pluginId, reference] of Object.entries(value.credentialRefs)) {
      if (!PLUGIN_ID_PATTERN.test(pluginId)) errors.push(`credentialRefs key "${pluginId}" is invalid`);
      if (typeof reference !== "string" || !CREDENTIAL_REF_PATTERN.test(reference)) {
        errors.push(`Credential reference for "${pluginId}" is invalid`);
      }
    }
    for (const pluginId of [...enabledPlugins, ...plannedPlugins].filter((id) => id.startsWith("connector."))) {
      if (!(pluginId in value.credentialRefs)) {
        errors.push(`Credential reference for "${pluginId}" is required`);
      }
    }
  }

  if (!isRecord(value.sources)) {
    errors.push("sources must be an object");
  } else {
    for (const [sourceId, configuration] of Object.entries(value.sources)) {
      if (!SOURCE_IDS.includes(sourceId)) errors.push(`Source "${sourceId}" is not registered`);
      if (!isRecord(configuration)) {
        errors.push(`Source configuration for "${sourceId}" must be an object`);
        continue;
      }
      if ("enabled" in configuration && typeof configuration.enabled !== "boolean") {
        errors.push(`Source "${sourceId}" enabled must be boolean`);
      }
      if (
        "configurationStatus" in configuration
        && !SOURCE_CONFIGURATION_STATUSES.includes(configuration.configurationStatus)
      ) {
        errors.push(`Source "${sourceId}" configurationStatus is invalid`);
      }
      validateNonSecretJsonValue(configuration, `sources.${sourceId}`, errors);
    }
    for (const pluginId of enabledPlugins.filter((id) => id.startsWith("connector."))) {
      const sourceId = pluginId.slice("connector.".length);
      const source = value.sources[sourceId];
      if (
        !isRecord(source)
        || source.enabled === false
        || source.configurationStatus !== "ready"
      ) {
        errors.push(`Enabled plugin "${pluginId}" requires a ready source`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertProductConfiguration(value) {
  const validation = validateProductConfiguration(value);
  if (!validation.valid) throw new TypeError(validation.errors.join("; "));
  return value;
}

function validatePluginList(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  const plugins = [];
  for (const pluginId of value) {
    if (typeof pluginId !== "string" || !PLUGIN_ID_PATTERN.test(pluginId)) {
      errors.push(`${field} contains an invalid plugin ID`);
      continue;
    }
    if (plugins.includes(pluginId)) {
      errors.push(`${field} contains duplicate plugin "${pluginId}"`);
      continue;
    }
    plugins.push(pluginId);
  }
  return plugins;
}

function validateNonSecretJsonValue(value, path, errors) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateNonSecretJsonValue(entry, `${path}[${index}]`, errors));
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${path} must contain only JSON-serializable values`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (SECRET_LIKE_KEY_PARTS.some((part) => normalizedKey.includes(part))) {
      errors.push(`${path}.${key} is credential-like; use credentialRefs instead`);
    }
    validateNonSecretJsonValue(entry, `${path}.${key}`, errors);
  }
}

const SOURCE_PATTERN = SOURCE_IDS.join("|");

export const TOOL_INPUT_SCHEMAS = {
  search_quality_knowledge: {
    type: "object", additionalProperties: false, required: ["productId"],
    properties: {
      productId: { type: "string", pattern: PRODUCT_ID_PATTERN.source },
      source: { type: "string", pattern: `^(${SOURCE_PATTERN})$` },
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      offset: { type: "integer", minimum: 0 }
    }
  },
  get_story_test_context: {
    type: "object", additionalProperties: false, required: ["productId", "storyId"],
    properties: {
      productId: { type: "string", pattern: PRODUCT_ID_PATTERN.source },
      source: { type: "string", pattern: `^(${SOURCE_PATTERN})$` },
      storyId: { type: "string", pattern: RESOURCE_ID_PATTERN.source }
    }
  },
  analyze_requirement_coverage: {
    type: "object", additionalProperties: false, required: ["productId", "requirementId"],
    properties: {
      productId: { type: "string", pattern: PRODUCT_ID_PATTERN.source },
      source: { type: "string", pattern: `^(${SOURCE_PATTERN})$` },
      requirementId: { type: "string", pattern: RESOURCE_ID_PATTERN.source }
    }
  },
  explain_traceability: {
    type: "object", additionalProperties: false, required: ["productId", "requirementId"],
    properties: {
      productId: { type: "string", pattern: PRODUCT_ID_PATTERN.source },
      source: { type: "string", pattern: `^(${SOURCE_PATTERN})$` },
      requirementId: { type: "string", pattern: RESOURCE_ID_PATTERN.source }
    }
  },
  list_knowledge_conflicts: {
    type: "object", additionalProperties: false, required: ["productId"],
    properties: {
      productId: { type: "string", pattern: PRODUCT_ID_PATTERN.source },
      source: { type: "string", pattern: `^(${SOURCE_PATTERN})$` }
    }
  },
  read_resource: {
    type: "object", additionalProperties: false, required: ["productId", "uri"],
    properties: {
      productId: { type: "string", pattern: PRODUCT_ID_PATTERN.source },
      uri: { type: "string", minLength: 7, maxLength: 512 }
    }
  }
};

export const API_RESPONSE_SCHEMAS = {
  health: { required: ["status", "service"], properties: { status: "string", service: "string" } },
  search_quality_knowledge: {
    required: ["productId", "query", "items", "limit"],
    properties: { productId: "productId", query: "string", items: "array", limit: "limit" }
  },
  coverage_context_agent_run: {
    required: [
      "runId",
      "agent",
      "productId",
      "workItemId",
      "generatedAt",
      "status",
      "confidence",
      "summary",
      "findings",
      "recommendations",
      "evidence",
      "limitations"
    ],
    properties: {
      runId: "string",
      agent: "object",
      productId: "productId",
      workItemId: "string",
      generatedAt: "string",
      status: "string",
      confidence: "object",
      summary: "string",
      findings: "array",
      recommendations: "array",
      evidence: "object",
      limitations: "array"
    }
  },
  test_designer_agent_run: {
    required: [
      "runId",
      "agent",
      "productId",
      "workItemId",
      "generatedAt",
      "status",
      "confidence",
      "summary",
      "proposals",
      "evidence",
      "limitations"
    ],
    properties: {
      runId: "string",
      agent: "object",
      productId: "productId",
      workItemId: "string",
      generatedAt: "string",
      status: "string",
      confidence: "object",
      summary: "string",
      proposals: "array",
      evidence: "object",
      limitations: "array"
    }
  },
  testrail_improvement_agent_run: {
    required: [
      "runId",
      "agent",
      "productId",
      "workItemId",
      "generatedAt",
      "status",
      "confidence",
      "summary",
      "proposals",
      "evidence",
      "limitations"
    ],
    properties: {
      runId: "string",
      agent: "object",
      productId: "productId",
      workItemId: "string",
      generatedAt: "string",
      status: "string",
      confidence: "object",
      summary: "string",
      proposals: "array",
      evidence: "object",
      limitations: "array"
    }
  },
  automation_designer_agent_run: {
    required: [
      "runId",
      "agent",
      "productId",
      "workItemId",
      "generatedAt",
      "status",
      "confidence",
      "summary",
      "proposal",
      "evidence",
      "limitations"
    ],
    properties: {
      runId: "string",
      agent: "object",
      productId: "productId",
      workItemId: "string",
      generatedAt: "string",
      status: "string",
      confidence: "object",
      summary: "string",
      proposal: "object",
      evidence: "object",
      limitations: "array"
    }
  },
  reliability_defect_intelligence_agent_run: {
    required: [
      "runId",
      "agent",
      "productId",
      "workItemId",
      "generatedAt",
      "status",
      "confidence",
      "summary",
      "analyses",
      "recommendations",
      "evidence",
      "limitations"
    ],
    properties: {
      runId: "string",
      agent: "object",
      productId: "productId",
      workItemId: "string",
      generatedAt: "string",
      status: "string",
      confidence: "object",
      summary: "string",
      analyses: "array",
      recommendations: "array",
      evidence: "object",
      limitations: "array"
    }
  },
  knowledge_curator_agent_run: {
    required: [
      "runId",
      "agent",
      "productId",
      "workItemId",
      "generatedAt",
      "scope",
      "status",
      "confidence",
      "summary",
      "findings",
      "proposals",
      "evidence",
      "limitations",
      "approval"
    ],
    properties: {
      runId: "string",
      agent: "object",
      productId: "productId",
      workItemId: "string",
      generatedAt: "string",
      scope: "object",
      status: "string",
      confidence: "object",
      summary: "string",
      findings: "array",
      proposals: "array",
      evidence: "object",
      limitations: "array",
      approval: "object"
    }
  },
  ask_tkl: {
    required: [
      "runId",
      "agent",
      "productId",
      "question",
      "generatedAt",
      "intent",
      "scope",
      "status",
      "answer",
      "citations",
      "freshness",
      "confidence",
      "conflicts",
      "limitations",
      "nextActions",
      "toolCalls"
    ],
    properties: {
      runId: "string",
      agent: "object",
      productId: "productId",
      question: "string",
      generatedAt: "string",
      intent: "object",
      scope: "object",
      status: "string",
      answer: "string",
      citations: "array",
      freshness: "object",
      confidence: "object",
      conflicts: "array",
      limitations: "array",
      nextActions: "array",
      toolCalls: "array"
    }
  },
  approved_action_preview: {
    required: ["preview"],
    properties: { preview: "object" }
  },
  approved_action_approval: {
    required: ["approval"],
    properties: { approval: "object" }
  },
  approved_action_execution: {
    required: ["execution"],
    properties: { execution: "object" }
  },
  get_story_test_context: {
    required: ["productId", "storyId", "requirements", "tests", "defects", "provenance"],
    properties: { productId: "productId", storyId: "resourceId", requirements: "array", tests: "array", defects: "array", provenance: "array" }
  },
  analyze_requirement_coverage: {
    required: ["productId", "requirementId", "findings", "provenance"],
    properties: { productId: "productId", requirementId: "resourceId", findings: "array", provenance: "array" }
  },
  explain_traceability: {
    required: ["productId", "requirementId", "relationships", "provenance"],
    properties: { productId: "productId", requirementId: "resourceId", relationships: "array", provenance: "array" }
  },
  list_knowledge_conflicts: {
    required: ["productId", "conflicts", "provenance"],
    properties: { productId: "productId", conflicts: "array", provenance: "array" }
  },
  knowledge_inventory: {
    required: [
      "productId",
      "generatedAt",
      "collectedEvidence",
      "canonicalKnowledge",
      "coverage",
      "pipeline",
      "syncStatus",
      "actionableGaps",
      "meta"
    ],
    properties: {
      productId: "productId",
      generatedAt: "string",
      collectedEvidence: "object",
      canonicalKnowledge: "object",
      coverage: "object",
      pipeline: "object",
      syncStatus: "object",
      actionableGaps: "array",
      meta: "object"
    }
  },
  review_knowledge_conflict: {
    required: ["productId", "conflict", "review"],
    properties: { productId: "productId", conflict: "object", review: "object" }
  },
  read_resource: {
    required: ["productId", "uri", "contents"],
    properties: { productId: "productId", uri: "string", contents: "array" }
  }
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "object") return isRecord(value);
  if (type === "productId") return typeof value === "string" && PRODUCT_ID_PATTERN.test(value);
  if (type === "resourceId") return typeof value === "string" && RESOURCE_ID_PATTERN.test(value);
  if (type === "limit") return Number.isSafeInteger(value) && value >= 1 && value <= 100;
  return false;
}

export function validateToolArguments(name, value) {
  const schema = TOOL_INPUT_SCHEMAS[name];
  if (!schema) return { valid: false, message: `Unknown tool '${name}'.` };
  if (!isRecord(value)) return { valid: false, message: "Arguments must be a JSON object." };
  const allowed = new Set(Object.keys(schema.properties));
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) return { valid: false, message: `Unexpected argument '${unexpected}'.`, parameter: unexpected };
  const missing = schema.required.find((key) => !(key in value));
  if (missing) return { valid: false, message: `Missing required argument '${missing}'.`, parameter: missing };
  for (const [key, definition] of Object.entries(schema.properties)) {
    if (!(key in value)) continue;
    if (definition.type === "integer") {
      const integer = value[key];
      if (
        !Number.isSafeInteger(integer)
        || (definition.minimum !== undefined && integer < definition.minimum)
        || (definition.maximum !== undefined && integer > definition.maximum)
      ) {
        const range = definition.maximum === undefined
          ? `at least ${definition.minimum}`
          : `from ${definition.minimum} to ${definition.maximum}`;
        return {
          valid: false,
          message: `${key} must be an integer ${range}.`,
          parameter: key
        };
      }
    }
    if (definition.type === "string") {
      if (typeof value[key] !== "string") return { valid: false, message: `${key} must be a string.`, parameter: key };
      if (definition.pattern && !new RegExp(definition.pattern).test(value[key])) {
        return { valid: false, message: `${key} is invalid.`, parameter: key };
      }
    }
  }
  return { valid: true };
}

export function validateApiResponse(name, value) {
  const schema = API_RESPONSE_SCHEMAS[name];
  if (!schema || !isRecord(value)) return { valid: false, message: `Response does not match '${name}' contract.` };
  for (const key of schema.required) {
    if (!(key in value)) return { valid: false, message: `Response is missing '${key}'.`, parameter: key };
    if (!matchesType(value[key], schema.properties[key])) {
      return { valid: false, message: `Response field '${key}' is invalid.`, parameter: key };
    }
  }
  if (
    name === "analyze_requirement_coverage"
    && !value.findings.every((finding) =>
      isLegacyCoverageFinding(finding)
      && (!hasCoverageAnalysisFields(finding) || isCoverageAnalysisFinding(finding)))
  ) {
    return {
      valid: false,
      message: "Response findings do not match the coverage analysis contract.",
      parameter: "findings"
    };
  }
  return { valid: true };
}

function isLegacyCoverageFinding(value) {
  return isRecord(value)
    && typeof value.requirementId === "string"
    && Number.isFinite(value.numerator)
    && Number.isFinite(value.denominator)
    && Number.isFinite(value.linkConfidence)
    && isStringArray(value.uncovered);
}

function hasCoverageAnalysisFields(value) {
  return [
    "policy",
    "manualCoverage",
    "automatedCoverage",
    "executionFreshness",
    "combinedCoverage"
  ].some((field) => field in value);
}

function isCoverageAnalysisFinding(value) {
  if (!isLegacyCoverageFinding(value)) return false;
  if (
    !isRecord(value.policy)
    || typeof value.policy.version !== "string"
    || value.policy.version.length === 0
    || typeof value.policy.provisional !== "boolean"
    || !isRequirementCoverageDimension(value.manualCoverage)
    || !isRequirementCoverageDimension(value.automatedCoverage)
    || !isExecutionFreshnessDimension(value.executionFreshness)
    || !isCombinedCoverage(value.combinedCoverage)
  ) {
    return false;
  }
  return true;
}

function isRequirementCoverageDimension(value) {
  return isRecord(value)
    && value.status === "evaluated"
    && value.basis === "requirement-link"
    && isCoverageNumber(value.numerator)
    && value.denominator === 1
    && isRatio(value.ratio)
    && isStringArray(value.evidenceEntityIds);
}

function isExecutionFreshnessDimension(value) {
  if (!isRecord(value) || !["evaluated", "not-evaluated"].includes(value.status)) {
    return false;
  }
  const commonFieldsValid = isCoverageNumber(value.numerator)
    && isCoverageNumber(value.denominator)
    && isStringArray(value.coveredEntityIds)
    && isStringArray(value.uncoveredEntityIds)
    && isStringArray(value.staleEntityIds)
    && isStringArray(value.nonQualifyingEntityIds)
    && isStringArray(value.missingExecutionEntityIds);
  if (!commonFieldsValid) return false;
  return value.status === "evaluated"
    ? isRatio(value.ratio) && value.reason === undefined
    : value.ratio === null && typeof value.reason === "string" && value.reason.length > 0;
}

function isCombinedCoverage(value) {
  if (!isRecord(value) || !["evaluated", "not-evaluated"].includes(value.status)) {
    return false;
  }
  return value.status === "evaluated"
    ? isRatio(value.score) && isCoverageWeights(value.weights) && value.reason === undefined
    : value.score === null
      && (value.weights === null || isCoverageWeights(value.weights))
      && typeof value.reason === "string"
      && value.reason.length > 0;
}

function isCoverageWeights(value) {
  if (!isRecord(value)) return false;
  const weights = [value.manual, value.automated, value.executionFreshness];
  return weights.every((weight) => typeof weight === "number" && Number.isFinite(weight) && weight >= 0)
    && Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) <= 1e-9;
}

function isCoverageNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function isRatio(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
