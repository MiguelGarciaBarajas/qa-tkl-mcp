import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.js";

export const JIRA_WEBHOOK_PATH = "/v1/webhooks/jira";
export const JIRA_WEBHOOK_SIGNATURE_HEADER = "x-hub-signature-256";
export const JIRA_WEBHOOK_DELIVERY_HEADER = "x-atlassian-webhook-identifier";
export const JIRA_WEBHOOK_ALGORITHM = "sha256";

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGNATURE_PATTERN = /^sha256=([a-f0-9]{64})$/;
const SUPPORTED_EVENTS = new Set(["jira:issue_updated"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function headerValue(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function observedAtFromPayload(payload) {
  if (Number.isSafeInteger(payload.timestamp) && payload.timestamp >= 0) {
    const timestamp = new Date(payload.timestamp);
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString();
  }
  if (typeof payload.timestamp === "string" && Number.isFinite(Date.parse(payload.timestamp))) {
    return new Date(Date.parse(payload.timestamp)).toISOString();
  }
  throw new ApiError(400, "invalid_webhook", "The Jira webhook timestamp is invalid.");
}

export function createJiraWebhookService({
  productId,
  allowedProjects,
  ticketContextCoordinator,
  secret,
  secretRef,
  resolveSecret
}) {
  if (typeof productId !== "string" || !PRODUCT_ID_PATTERN.test(productId)) {
    throw new TypeError("A valid server-managed webhook productId is required.");
  }
  const projectAllowlist = new Set(
    Array.isArray(allowedProjects)
      ? allowedProjects.map((project) => String(project).trim().toUpperCase()).filter(Boolean)
      : []
  );
  if (
    projectAllowlist.size === 0
    || [...projectAllowlist].some((project) => !PROJECT_KEY_PATTERN.test(project))
  ) {
    throw new TypeError("Jira webhook allowedProjects must be a non-empty project allowlist.");
  }
  if (
    !ticketContextCoordinator
    || typeof ticketContextCoordinator.invalidate !== "function"
  ) {
    throw new TypeError("A ticket context coordinator with invalidate() is required.");
  }
  if (
    secret === undefined
    && (typeof secretRef !== "string" || secretRef.length === 0)
  ) {
    throw new TypeError("A Jira webhook secret or secret reference is required.");
  }
  if (secret === undefined && typeof resolveSecret !== "function") {
    throw new TypeError("resolveSecret is required for a Jira webhook secret reference.");
  }

  let secretPromise;

  async function signingKey() {
    if (!secretPromise) {
      secretPromise = Promise.resolve(
        secret !== undefined ? secret : resolveSecret(secretRef)
      ).then((value) => {
        const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value ?? ""));
        if (key.length < 32) {
          throw new Error("The Jira webhook HMAC secret must contain at least 32 bytes.");
        }
        return key;
      });
    }
    return secretPromise;
  }

  async function reject(error, metadata = {}, { persist = true } = {}) {
    if (persist) {
      try {
        await ticketContextCoordinator.recordInvalidationRejection?.({
          productId,
          source: "jira",
          eventId: metadata.eventId ?? null,
          observedAt: metadata.observedAt ?? null,
          issueKey: metadata.issueKey ?? null
        });
      } catch {
        // The sanitized HTTP error remains authoritative when rejection telemetry is unavailable.
      }
    }
    throw error;
  }

  return Object.freeze({
    productId,

    async handle({ rawBody, headers }) {
      if (!Buffer.isBuffer(rawBody)) {
        return reject(
          new ApiError(400, "invalid_webhook", "A raw webhook body is required."),
          {},
          { persist: false }
        );
      }

      const signature = headerValue(headers, JIRA_WEBHOOK_SIGNATURE_HEADER);
      const match = typeof signature === "string" ? signature.match(SIGNATURE_PATTERN) : null;
      let signatureValid = false;
      if (match) {
        const supplied = Buffer.from(match[1], "hex");
        let key;
        try {
          key = await signingKey();
        } catch {
          throw new ApiError(
            503,
            "webhook_unavailable",
            "Webhook authentication is unavailable."
          );
        }
        const expected = createHmac(JIRA_WEBHOOK_ALGORITHM, key)
          .update(rawBody)
          .digest();
        signatureValid = supplied.length === expected.length
          && timingSafeEqual(supplied, expected);
      }
      if (!signatureValid) {
        return reject(
          new ApiError(401, "invalid_webhook_signature", "Webhook authentication failed."),
          {},
          { persist: false }
        );
      }

      const deliveryId = headerValue(headers, JIRA_WEBHOOK_DELIVERY_HEADER);
      if (typeof deliveryId !== "string" || !DELIVERY_ID_PATTERN.test(deliveryId)) {
        return reject(
          new ApiError(400, "invalid_webhook", "The Jira delivery identifier is invalid.")
        );
      }
      const contentType = headerValue(headers, "content-type");
      if (typeof contentType !== "string" || !/^application\/json(?:;|$)/i.test(contentType)) {
        return reject(
          new ApiError(415, "unsupported_media_type", "The Jira webhook must be JSON."),
          { eventId: deliveryId }
        );
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return reject(
          new ApiError(400, "invalid_webhook", "The Jira webhook body is malformed."),
          { eventId: deliveryId }
        );
      }
      if (!isRecord(payload) || !SUPPORTED_EVENTS.has(payload.webhookEvent)) {
        return reject(
          new ApiError(400, "unsupported_webhook_event", "The Jira webhook event is unsupported."),
          { eventId: deliveryId }
        );
      }

      const issueKey = typeof payload.issue?.key === "string"
        ? payload.issue.key.trim().toUpperCase()
        : "";
      if (!ISSUE_KEY_PATTERN.test(issueKey)) {
        return reject(
          new ApiError(400, "invalid_webhook", "The Jira issue key is invalid."),
          { eventId: deliveryId }
        );
      }
      const projectKey = issueKey.slice(0, issueKey.lastIndexOf("-"));
      const payloadProjectKey = typeof payload.issue?.fields?.project?.key === "string"
        ? payload.issue.fields.project.key.trim().toUpperCase()
        : projectKey;
      if (
        payloadProjectKey !== projectKey
        || !projectAllowlist.has(projectKey)
      ) {
        return reject(
          new ApiError(403, "webhook_scope_rejected", "The Jira issue is outside the allowed scope."),
          { eventId: deliveryId, issueKey }
        );
      }

      let observedAt;
      try {
        observedAt = observedAtFromPayload(payload);
      } catch (error) {
        return reject(error, { eventId: deliveryId, issueKey });
      }
      return ticketContextCoordinator.invalidate({
        productId,
        issueKey,
        source: "jira",
        eventId: deliveryId,
        observedAt
      });
    }
  });
}
