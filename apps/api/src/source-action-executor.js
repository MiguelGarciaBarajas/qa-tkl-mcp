import {
  createTestRailHttpClient,
  TestRailHttpError,
} from "../../../plugins/connectors/testrail/src/index.js";
import { ApiError } from "./errors.js";

export function createSourceActionExecutor({
  fetch = globalThis.fetch,
  allowInsecureLoopback = false,
} = {}) {
  return async function executeSourceAction({
    actionType,
    target,
    changes,
    config,
    resolveCredential,
    signal,
  }) {
    if (actionType !== "testrail.case.create") {
      throw new ApiError(
        409,
        "action_execution_not_configured",
        "Execution is not configured for this action type.",
      );
    }
    const title = requiredText(changes?.title, "changes.title", 250);
    const credentialRef = "vault://testrail";
    const client = createTestRailHttpClient({
      fetch,
      baseUrl: config.baseUrl,
      credentialRef,
      resolveCredential: async () => {
        const credential = await resolveCredential();
        return Buffer.from(`${config.username}:${credential}`, "utf8").toString("base64");
      },
      allowInsecureLoopback,
    });
    const fields = {
      title,
      ...(optionalText(changes.refs, 250) ? { refs: optionalText(changes.refs, 250) } : {}),
      ...(optionalPositiveInteger(changes.template_id)
        ? { template_id: optionalPositiveInteger(changes.template_id) }
        : {}),
      ...(optionalNonNegativeInteger(changes.custom_automation_status) !== null
        ? { custom_automation_status: optionalNonNegativeInteger(changes.custom_automation_status) }
        : {}),
      ...(optionalText(changes.custom_preconds, 4_000)
        ? { custom_preconds: optionalText(changes.custom_preconds, 4_000) }
        : {}),
      ...(normalizeSteps(changes.custom_steps_separated).length > 0
        ? { custom_steps_separated: normalizeSteps(changes.custom_steps_separated) }
        : {}),
    };
    let createdSection = null;
    try {
      let sectionId;
      if (target?.sectionId) {
        sectionId = normalizePositiveId(target.sectionId, "target.sectionId");
      } else {
        const projectId = normalizePositiveId(config.projectId, "config.projectId");
        const suiteId = normalizePositiveId(target?.suiteId, "target.suiteId");
        const sectionName = requiredText(target?.newSectionName, "target.newSectionName", 250);
        createdSection = await client.createSection(projectId, {
          suite_id: suiteId,
          name: sectionName,
        }, { signal });
        sectionId = normalizePositiveId(createdSection.id, "createdSection.id");
      }
      const created = await client.createCase(sectionId, fields, { signal });
      return {
        source: "testrail",
        externalId: String(created.id),
        url: `${config.baseUrl}/index.php?/cases/view/${created.id}`,
        title: typeof created.title === "string" ? created.title : title,
        section: {
          id: sectionId,
          created: createdSection !== null,
          name: typeof createdSection?.name === "string"
            ? createdSection.name
            : optionalText(target?.newSectionName, 250) || null,
        },
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (createdSection) {
        throw new ApiError(
          502,
          "partial_source_write",
          "TestRail created the new section, but case creation failed. Select the created section before retrying.",
          {
            sectionId: String(createdSection.id),
            sectionName: typeof createdSection.name === "string"
              ? createdSection.name
              : optionalText(target?.newSectionName, 250),
          },
        );
      }
      if (error instanceof TestRailHttpError && error.status === 400) {
        throw new ApiError(
          422,
          "source_field_validation_failed",
          "TestRail rejected one or more case fields. Verify the required custom fields and case template.",
        );
      }
      throw new ApiError(
        error instanceof TestRailHttpError && error.status === 403 ? 403 : 502,
        error instanceof TestRailHttpError && error.status === 403
          ? "source_write_forbidden"
          : "source_write_failed",
        error instanceof TestRailHttpError && error.status === 403
          ? "TestRail rejected case creation. Verify that the account can add cases to this section."
          : "TestRail case creation failed. If a new section was requested, verify TestRail before retrying because the section may already exist.",
      );
    }
  };
}

function normalizePositiveId(value, parameter) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) {
    throw new ApiError(400, "invalid_request", `${parameter} must be a positive integer.`);
  }
  return BigInt(text).toString();
}

function requiredText(value, parameter, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0 || text.length > maxLength) {
    throw new ApiError(
      400,
      "invalid_request",
      `${parameter} must contain between 1 and ${maxLength} characters.`,
    );
  }
  return text;
}

function optionalText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function optionalPositiveInteger(value) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  return /^\d+$/.test(text) && BigInt(text) > 0n ? Number(text) : null;
}

function optionalNonNegativeInteger(value) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  return /^\d+$/.test(text) ? Number(text) : null;
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return [];
    const content = optionalText(step.content, 2_000);
    const expected = optionalText(step.expected, 2_000);
    return content ? [{ content, expected }] : [];
  });
}
