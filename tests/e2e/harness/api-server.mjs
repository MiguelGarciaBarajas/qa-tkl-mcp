/**
 * INT-102 test-only Application API composition root.
 *
 * This process is started *only* by the Playwright end-to-end harness
 * (`tests/e2e/support/servers.ts`). It composes the same application, transport, policy,
 * and audit code as `apps/api/src/server.js` and then seeds the knowledge service in
 * process, through the exported `createKnowledgeService().ingest()` composition seam,
 * with committed sanitized fixtures.
 *
 * Security boundaries deliberately preserved:
 * - Fixture ingestion happens *before* the server listens and is never reachable over
 *   HTTP: no ingestion route exists here or in the production API.
 * - Authentication is the production `createConfiguredAuthenticator`; the harness passes
 *   a per-run random development token through `TKL_AUTH_TOKENS`, the development-only
 *   static token path that `packages/ops` blocks in production.
 * - Refuses to start with `NODE_ENV=production`, so this fixture-seeded composition can
 *   never be mistaken for a deployable entry point.
 * - No external source system is contacted.
 */
import { createApplication } from "../../../apps/api/src/app.js";
import { createKnowledgeService } from "../../../apps/api/src/knowledge-service.js";
import { createApiServer } from "../../../apps/api/src/http-server.js";
import { createSourceConnectionService } from "../../../apps/api/src/source-connection-service.js";
import { createApprovedActionService } from "../../../apps/api/src/approved-action-service.js";
import { InMemoryCredentialVault } from "../../../packages/credential-vault/src/index.js";
import {
  createAuditLogger,
  createHealthRegistry,
} from "../../../packages/observability/src/index.js";
import {
  createAuditSink,
  createConfiguredAuthenticator,
} from "../../../packages/ops/src/index.js";
import { JiraNormalizer } from "../../../plugins/normalizers/jira/src/index.js";
import { GitHubNormalizer } from "../../../plugins/normalizers/github/src/index.js";
import { TestRailNormalizer } from "../../../plugins/normalizers/testrail/src/index.js";
import {
  buildConnectorHealth,
  buildSeedRecords,
  E2E_TENANT_ID,
  TESTRAIL_REFERENCE_MAPPING,
} from "./fixtures.mjs";

if (process.env.NODE_ENV === "production") {
  throw new Error(
    "tests/e2e/harness/api-server.mjs is a fixture-seeded test harness and must never run "
    + "with NODE_ENV=production. Use apps/api/src/server.js for real deployments.",
  );
}
if (!process.env.TKL_AUTH_TOKENS) {
  throw new Error(
    "TKL_AUTH_TOKENS must be supplied by the end-to-end harness so the API authenticates "
    + "the per-run development token instead of accepting unauthenticated requests.",
  );
}

const port = Number.parseInt(process.env.PORT ?? "0", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer between 0 and 65535.");
}

const tenantId = process.env.TKL_TENANT_ID ?? E2E_TENANT_ID;
const records = buildSeedRecords();
const knowledgeService = createKnowledgeService({
  tenantId,
  normalizers: [
    new JiraNormalizer(),
    new GitHubNormalizer(),
    new TestRailNormalizer(TESTRAIL_REFERENCE_MAPPING),
  ],
});
const ingestion = await knowledgeService.ingest(records);

const healthRegistry = createHealthRegistry();
for (const { component, health } of buildConnectorHealth(records)) {
  healthRegistry.record(component, health);
}

const authenticator = createConfiguredAuthenticator();
const auditLogger = createAuditLogger({
  sink: createAuditSink({ destination: process.env.TKL_AUDIT_DESTINATION ?? "none" }),
});
const vaults = new Map();
const sourceConnectionService = createSourceConnectionService({
  tenantId,
  vaultFactory: ({ tenantId: scopeTenantId, productId }) => {
    const vault = new InMemoryCredentialVault({ tenantId: scopeTenantId, productId });
    vaults.set(productId, vault);
    return vault;
  },
  validateConnection: async () => ({ validatedAt: new Date().toISOString() }),
  discoverTestRailSections: async ({ suiteId }) => [{
    id: "1201",
    suiteId,
    parentId: null,
    depth: 0,
    name: "Regression",
  }],
  syncSource: async () => ({ recordsCollected: 0, recordsCommitted: 0 })
});
const approvedActionService = createApprovedActionService({
  tenantId,
  auditLogger,
  executableActionTypes: ["testrail.case.create"],
  actionExecutor: async ({ changes }) => ({
    source: "testrail",
    externalId: "9001",
    url: "https://testrail.example/index.php?/cases/view/9001",
    title: String(changes.title),
  }),
});
const application = createApplication({
  auditLogger,
  knowledgeService,
  healthRegistry,
  sourceConnectionService,
  approvedActionService,
});
const server = createApiServer({ application, authenticator, auditLogger });

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      port: address.port,
      url: `http://127.0.0.1:${address.port}`,
      ingestedRecords: ingestion.ingestedRecords,
      unresolvedLinks: ingestion.unresolvedLinks.length,
    })}\n`,
  );
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
