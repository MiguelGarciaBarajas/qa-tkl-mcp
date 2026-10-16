import { createServer } from "node:http";
import { createApplicationApiClient } from "./client.js";
import { createGateway } from "./gateway.js";
import { createMcpRequestListener } from "./http.js";
import { loadProtectedResourceMetadata } from "./oauth-metadata.js";
import { createSessionStore } from "./sessions.js";
import { createAuditLogger } from "../../../packages/observability/src/index.js";
import {
  createAuditSink,
  createConfiguredAuthenticator,
  createEnvIdentityAdapter,
  createIdentityVerifier,
  loadProductConfiguration,
  validateDeploymentEnvironment
} from "../../../packages/ops/src/index.js";

/**
 * OPS-102: fail closed before the gateway ever starts listening if this environment's
 * configuration is inconsistent or incomplete. See `packages/ops/README.md` for the
 * full "Environment validation checklist".
 *
 * The gateway forwards the caller's bearer token to the API, which authenticates it, so
 * the same OIDC issuer/audience configuration is required here before a production
 * gateway can start and claim readiness.
 */
const identityVerifier = createIdentityVerifier();
const identityAdapter = typeof identityVerifier === "function"
  ? createEnvIdentityAdapter({ verifyToken: identityVerifier })
  : undefined;
const authenticator = createConfiguredAuthenticator({
  ...(identityAdapter === undefined ? {} : { identityAdapter }),
});
const productConfig = loadProductConfiguration();
const deploymentCheck = validateDeploymentEnvironment({ productConfig, identityVerifier });
if (!deploymentCheck.ready) {
  for (const item of deploymentCheck.checklist) {
    if (item.status === "fail") {
      console.error(`[startup] FAIL ${item.id}: ${item.detail}`);
    }
  }
  throw new Error(
    `Refusing to start: the ${deploymentCheck.environment} environment failed its deployment `
    + "validation checklist. See the FAIL entries logged above.",
  );
}

/**
 * MCP-103: a deployed gateway is an OAuth protected resource and must publish its
 * configured resource/issuer metadata. `loadProtectedResourceMetadata` throws in
 * production when that configuration is missing or incomplete, so the process fails
 * closed instead of serving an endpoint no compliant client can authenticate against.
 */
const protectedResourceMetadata = loadProtectedResourceMetadata();
if (protectedResourceMetadata === undefined) {
  console.warn(
    "[startup] OAuth protected-resource metadata is not configured; "
    + "/.well-known/oauth-protected-resource reports oauth_metadata_not_configured. "
    + "This is permitted outside production only."
  );
}

const port = Number.parseInt(process.env.PORT ?? "3100", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const gateway = createGateway({
  applicationClient: createApplicationApiClient({
    baseUrl: process.env.TKL_API_URL ?? "http://localhost:3000"
  }),
  auditLogger: createAuditLogger({ sink: createAuditSink() })
});

const server = createServer(
  createMcpRequestListener({
    gateway,
    authenticateToken: (token) => authenticator.authenticate(`Bearer ${token}`),
    sessionStore: createSessionStore(),
    protectedResourceMetadata
  })
);

server.listen(port, () => {
  console.log(`TKL MCP gateway listening on http://localhost:${port}/mcp`);
});
