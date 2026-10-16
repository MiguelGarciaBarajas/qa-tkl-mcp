import { createServer } from "node:http";
import { ApiError } from "./errors.js";
import { createCorrelationId } from "../../../packages/observability/src/index.js";
import { securityHeaders } from "../../../packages/security/src/index.js";

/**
 * Transport layer of the TKL Application API: authentication, body limits, security
 * headers, and correlation-id propagation around `createApplication().handle()`.
 *
 * It is deliberately separated from `server.js` (the production composition root) so a
 * trusted non-production composition root -- today `tests/e2e/harness/api-server.mjs`,
 * the INT-102 browser end-to-end harness -- can serve the *same* HTTP behavior over a
 * knowledge service seeded with sanitized fixtures, without the production process
 * gaining any fixture-loading or unauthenticated ingestion surface. Every caller still
 * supplies its own authenticator, so this module never relaxes authentication.
 */

export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function writeResponse(response, result) {
  response.writeHead(result.status, {
    ...securityHeaders(),
    ...result.headers
  });
  response.end(JSON.stringify(result.body));
}

async function readRequestBody(request, { preserveRaw = false } = {}) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === undefined) {
    return { body: undefined, rawBody: undefined };
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new ApiError(413, "payload_too_large", "Request body exceeds the allowed size.");
    }
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);
  if (preserveRaw) return { body: undefined, rawBody };
  if (totalBytes === 0) return { body: undefined, rawBody: undefined };

  const raw = rawBody.toString("utf8");
  if (raw.trim().length === 0) return { body: undefined, rawBody: undefined };
  try {
    return { body: JSON.parse(raw), rawBody: undefined };
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be valid JSON.");
  }
}

/**
 * Builds the `http.createServer` request listener for an already-composed application,
 * authenticator, and audit logger. `/health` is the only unauthenticated route.
 */
export function createApiRequestListener({ application, authenticator, auditLogger }) {
  if (!application || typeof application.handle !== "function") {
    throw new TypeError("An application with a handle() method is required");
  }
  if (!authenticator || typeof authenticator.authenticate !== "function") {
    throw new TypeError("An authenticator with an authenticate() method is required");
  }
  if (!auditLogger || typeof auditLogger.record !== "function") {
    throw new TypeError("An audit logger with a record() method is required");
  }

  return async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const correlationId = request.headers["x-correlation-id"] ?? createCorrelationId();
    const isJiraWebhook = url.pathname === "/v1/webhooks/jira";
    try {
      const authContext =
        url.pathname === "/health" || isJiraWebhook
          ? undefined
          : await authenticator.authenticate(request.headers.authorization);
      const { body, rawBody } = await readRequestBody(request, {
        preserveRaw: isJiraWebhook
      });
      const result = await application.handle({
        method: request.method ?? "GET",
        pathname: url.pathname,
        url,
        authContext,
        correlationId,
        body,
        rawBody,
        headers: isJiraWebhook
          ? {
              "content-type": request.headers["content-type"],
              "x-hub-signature-256": request.headers["x-hub-signature-256"],
              "x-atlassian-webhook-identifier":
                request.headers["x-atlassian-webhook-identifier"]
            }
          : undefined
      });
      writeResponse(response, result);
    } catch (error) {
      await auditLogger.record({
        eventType: "api.authentication",
        correlationId,
        operation: `${request.method ?? "GET"} ${url.pathname}`,
        outcome: "failure",
        status: error.status ?? 401,
        durationMs: 0
      });
      writeResponse(response, {
        status: error.status ?? 401,
        headers: JSON_HEADERS,
        body: {
          error: {
            code: error.code ?? "unauthenticated",
            message: error.message ?? "Authentication failed."
          }
        }
      });
    }
  };
}

/** Convenience wrapper returning an unstarted `http.Server` for the listener above. */
export function createApiServer(dependencies) {
  return createServer(createApiRequestListener(dependencies));
}
