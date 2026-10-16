import { createApplication } from "./app.js";
import {
  createKnowledgeService,
  createPersistentKnowledgeStoreFactory
} from "./knowledge-service.js";
import { createApiServer } from "./http-server.js";
import {
  createAuditLogger,
  createHealthRegistry
} from "../../../packages/observability/src/index.js";
import {
  createPersistentCredentialVault,
  normalizeKeyMaterial
} from "@tkl/credential-vault";
import {
  createAuditSink,
  createConfiguredAuthenticator,
  createEnvCredentialResolver,
  createIdentityClaimsMapper,
  createIdentityVerifier,
  loadProductConfiguration,
  validateDeploymentEnvironment
} from "../../../packages/ops/src/index.js";
import { createSourceConnectionService } from "./source-connection-service.js";
import {
  createSourceConnectionValidator,
  createTestRailSuiteDiscoverer,
  createTestRailSectionDiscoverer,
  createConfluencePageDiscoverer
} from "./source-connection-validation.js";
import { createSourceSyncRunner } from "./source-sync.js";
import { createReadThroughKnowledgeService } from "./read-through-knowledge-service.js";
import { createCrossSourceContextCoordinator } from "./cross-source-context-coordinator.js";
import { createApprovedActionService } from "./approved-action-service.js";
import { createSourceActionExecutor } from "./source-action-executor.js";
import { createPersistentApprovedActionStore } from "./approved-action-store.js";
import { createPersistentGitHubRepositoryStore } from "./github-repository-store.js";
import { createPersistentTicketContextJobStore } from "./ticket-context-job-store.js";
import { createTicketContextCoordinator } from "./ticket-context-coordinator.js";
import { createJiraWebhookService } from "./jira-webhook-service.js";
import { loadQaBrainEvidence } from "./qa-brain-knowledge.js";

/**
 * OPS-102: fail closed before the server ever starts listening if this environment's
 * configuration is inconsistent or incomplete (invalid PORT, missing production
 * identity provider/verifier/TLS enforcement, unresolved secret manager references). See
 * `packages/ops/README.md` for the full "Environment validation checklist".
 *
 * `createIdentityVerifier()` is the only trusted place a real token verifier is wired in.
 * It builds an OIDC/JWKS verifier only from explicit deployment configuration; missing or
 * partial issuer/audience configuration fails before the service starts.
 */
const identityVerifier = createIdentityVerifier();
const identityClaimsMapper = createIdentityClaimsMapper();
const productConfig = loadProductConfiguration();
const environmentCredentialResolver = createEnvCredentialResolver();
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
if (deploymentCheck.environment === "production") {
  const [credentialVaultKey, rawEvidenceKey, contextJobKey] = await Promise.all([
    environmentCredentialResolver.resolve("env://TKL_CREDENTIAL_VAULT_KEY"),
    environmentCredentialResolver.resolve("env://TKL_RAW_EVIDENCE_KEY"),
    environmentCredentialResolver.resolve("env://TKL_CONTEXT_JOB_KEY")
  ]);
  const normalizedCredentialVaultKey = normalizeKeyMaterial(credentialVaultKey);
  const normalizedRawEvidenceKey = normalizeKeyMaterial(rawEvidenceKey);
  const normalizedContextJobKey = normalizeKeyMaterial(contextJobKey);
  if (
    normalizedCredentialVaultKey.equals(normalizedRawEvidenceKey)
    || normalizedCredentialVaultKey.equals(normalizedContextJobKey)
    || normalizedRawEvidenceKey.equals(normalizedContextJobKey)
  ) {
    throw new Error(
      "TKL_CREDENTIAL_VAULT_KEY, TKL_RAW_EVIDENCE_KEY, and TKL_CONTEXT_JOB_KEY "
      + "must use different key material."
    );
  }
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const authenticator = createConfiguredAuthenticator({
  verifyToken: identityVerifier,
  mapClaims: identityClaimsMapper,
});
const auditLogger = createAuditLogger({ sink: createAuditSink() });
const healthRegistry = createHealthRegistry();
const tenantId = process.env.TKL_TENANT_ID ?? "solera";
const configuredProductId =
  productConfig?.productId ?? process.env.TKL_PRODUCT_ID ?? "fl-titling";
const knowledgeService = createKnowledgeService({
  tenantId,
  createStoreOnRead: true,
  storeFactory: createPersistentKnowledgeStoreFactory({
    dataDirectory: process.env.TKL_KNOWLEDGE_DATA_DIR ?? "./data/knowledge",
    busyTimeoutMs: Number(process.env.TKL_KNOWLEDGE_SQLITE_BUSY_TIMEOUT_MS ?? "5000")
  })
});
if (process.env.TKL_QA_BRAIN_PATH) {
  const qaBrain = loadQaBrainEvidence({
    rootPath: process.env.TKL_QA_BRAIN_PATH,
    tenantId,
    productId: configuredProductId,
  });
  await knowledgeService.ingest(qaBrain.records);
  console.log(
    `[startup] QA brain knowledge loaded: ${qaBrain.records.length} record(s), `
      + `${qaBrain.skipped.length} skipped.`,
  );
}
const allowedSourceHosts = parseAllowedHosts(process.env.TKL_SOURCE_ALLOWED_HOSTS);
const allowedInsecureSourceHosts = parseAllowedHosts(
  process.env.TKL_SOURCE_ALLOWED_INSECURE_HOSTS
);
const insecureSourceLoopbackAllowed = allowInsecureSourceLoopback(process.env);
const sourceConnectionValidator = createSourceConnectionValidator({
  allowedHosts: allowedSourceHosts,
  allowedInsecureHosts: allowedInsecureSourceHosts,
  allowInsecureLoopback: insecureSourceLoopbackAllowed
});
const testRailSuiteDiscoverer = createTestRailSuiteDiscoverer({
  allowedHosts: allowedSourceHosts,
  allowInsecureLoopback: insecureSourceLoopbackAllowed
});
const testRailSectionDiscoverer = createTestRailSectionDiscoverer({
  allowedHosts: allowedSourceHosts,
  allowInsecureLoopback: insecureSourceLoopbackAllowed
});
const confluencePageDiscoverer = createConfluencePageDiscoverer({
  allowedHosts: allowedSourceHosts,
  allowInsecureLoopback: insecureSourceLoopbackAllowed
});
const syncSource = createSourceSyncRunner({
  tenantId,
  knowledgeService,
  dataDirectory: process.env.TKL_RAW_EVIDENCE_DATA_DIR ?? "./data/raw",
  resolveRawEvidenceKey: (reference) => environmentCredentialResolver.resolve(reference),
  allowedHosts: allowedSourceHosts,
  allowedInsecureHosts: allowedInsecureSourceHosts,
  allowInsecureLoopback: insecureSourceLoopbackAllowed,
  auditLogger,
  healthRegistry
});
const sourceConnectionService = createSourceConnectionService({
  tenantId,
  vaultFactory: ({ tenantId: scopeTenantId, productId }) =>
    createPersistentCredentialVault({
      dataDirectory: process.env.TKL_CREDENTIAL_VAULT_DATA_DIR ?? "./data/connections",
      tenantId: scopeTenantId,
      productId,
      keyRef: "env://TKL_CREDENTIAL_VAULT_KEY",
      resolveKey: (reference) => environmentCredentialResolver.resolve(reference)
    }),
  repositoryStoreFactory: ({ tenantId: scopeTenantId, productId }) =>
    createPersistentGitHubRepositoryStore({
      dataDirectory:
        process.env.TKL_GITHUB_REPOSITORY_DATA_DIR ?? "./data/source-repositories",
      tenantId: scopeTenantId,
      productId
    }),
  validateConnection: sourceConnectionValidator,
  discoverTestRailSuites: testRailSuiteDiscoverer,
  discoverTestRailSections: testRailSectionDiscoverer,
  discoverConfluencePages: confluencePageDiscoverer,
  syncSource,
  executeSourceAction: createSourceActionExecutor({
    allowInsecureLoopback: insecureSourceLoopbackAllowed,
  }),
});
const ticketContextJobStore = createPersistentTicketContextJobStore({
  dataDirectory: process.env.TKL_CONTEXT_JOB_DATA_DIR ?? "./data/context-jobs",
  tenantId,
  keyRef: process.env.TKL_CONTEXT_JOB_KEY_REF ?? "env://TKL_CONTEXT_JOB_KEY",
  resolveKey: (reference) => environmentCredentialResolver.resolve(reference)
});
const ticketContextCoordinator = createTicketContextCoordinator({
  store: ticketContextJobStore,
  sourceConnectionService,
  freshnessMs: envInteger("TKL_CONTEXT_JOB_FRESHNESS_MS", 900_000, 0),
  maxAttempts: envInteger("TKL_CONTEXT_JOB_MAX_ATTEMPTS", 3, 1),
  retryBaseMs: envInteger("TKL_CONTEXT_JOB_RETRY_BASE_MS", 1_000, 1),
  retryMaxMs: envInteger("TKL_CONTEXT_JOB_RETRY_MAX_MS", 30_000, 1),
  concurrency: envInteger("TKL_CONTEXT_JOB_CONCURRENCY", 2, 1),
  retentionMs: envInteger("TKL_CONTEXT_JOB_RETENTION_MS", 604_800_000, 1),
  maxJobs: envInteger("TKL_CONTEXT_JOB_MAX_JOBS", 10_000, 1),
  receiptRetentionMs: envInteger(
    "TKL_CONTEXT_JOB_RECEIPT_RETENTION_MS",
    604_800_000,
    1
  ),
  maxReceipts: envInteger("TKL_CONTEXT_JOB_MAX_RECEIPTS", 20_000, 1),
  retentionSweepIntervalMs: envInteger(
    "TKL_CONTEXT_JOB_RETENTION_SWEEP_INTERVAL_MS",
    3_600_000,
    1
  ),
  maxQueueAgeMs: envInteger("TKL_CONTEXT_JOB_MAX_QUEUE_AGE_MS", 300_000, 1),
  maxRetryBacklog: envInteger("TKL_CONTEXT_JOB_MAX_RETRY_BACKLOG", 100, 0),
  auditLogger
});
sourceConnectionService.registerTicketContextCoordinator(ticketContextCoordinator);
await ticketContextCoordinator.start();
const jiraWebhookService = await createConfiguredJiraWebhookService({
  productId: configuredProductId,
  productConfig,
  ticketContextCoordinator,
  environmentCredentialResolver,
  environment: deploymentCheck.environment,
  env: process.env
});
const readThroughKnowledgeService = createReadThroughKnowledgeService({
  knowledgeService,
  sourceConnectionService,
  ticketContextCoordinator,
  freshnessMs: Number(process.env.TKL_ON_DEMAND_FRESHNESS_MS ?? "900000"),
  auditLogger
});
const crossSourceContextCoordinator = createCrossSourceContextCoordinator({
  knowledgeService,
  sourceConnectionService,
  auditLogger,
});
const approvedActionStore = createPersistentApprovedActionStore({
  dataDirectory: process.env.TKL_APPROVED_ACTION_DATA_DIR ?? "./data/approved-actions",
  tenantId,
  productId: configuredProductId,
});
const approvedActionService = createApprovedActionService({
  tenantId,
  productId: configuredProductId,
  store: approvedActionStore,
  auditLogger,
  executableActionTypes: ["testrail.case.create"],
  actionExecutor: (request) => sourceConnectionService.executeApprovedAction(request),
});
const application = createApplication({
  auditLogger,
  knowledgeService: readThroughKnowledgeService,
  healthRegistry,
  sourceConnectionService,
  ticketContextCoordinator,
  crossSourceContextCoordinator,
  jiraWebhookService,
  approvedActionService,
  rawEvidenceStoreProvider: (productId) => syncSource.getRawStore(productId),
});

const server = createApiServer({ application, authenticator, auditLogger });

void syncSource.resumeAllPendingProjections().catch(() => {
  console.error("[startup] Failed to resume the durable Silver projection backlog.");
});

server.listen(port, () => {
  console.log(`TKL API listening on http://localhost:${port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received; stopping ticket-context workers.`);
  await new Promise((resolve) => server.close(resolve));
  await ticketContextCoordinator.shutdown();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error("[shutdown] Graceful shutdown failed.", error);
      process.exitCode = 1;
    });
  });
}

function parseAllowedHosts(value) {
  if (typeof value !== "string") return [];
  return [...new Set(
    value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)
  )];
}

function allowInsecureSourceLoopback(env) {
  return env.NODE_ENV !== "production"
    && env.TKL_SOURCE_ALLOW_INSECURE_LOOPBACK === "true";
}

function envInteger(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

async function createConfiguredJiraWebhookService({
  productId,
  productConfig,
  ticketContextCoordinator,
  environmentCredentialResolver,
  environment,
  env
}) {
  if (env.TKL_JIRA_WEBHOOK_ENABLED !== "true") return undefined;
  const allowedProjects = parseAllowedProjects(
    env.TKL_JIRA_WEBHOOK_ALLOWED_PROJECTS
      ?? productConfig?.sources?.jira?.allowedProjects
  );
  if (allowedProjects.length === 0) {
    throw new Error(
      "TKL_JIRA_WEBHOOK_ALLOWED_PROJECTS must contain at least one Jira project "
      + "when the Jira webhook is enabled."
    );
  }
  const secretRef = env.TKL_JIRA_WEBHOOK_SECRET_REF;
  if (environment === "production" && !secretRef) {
    throw new Error(
      "TKL_JIRA_WEBHOOK_SECRET_REF is required in production when the Jira webhook is enabled."
    );
  }
  if (environment === "production" && env.TKL_JIRA_WEBHOOK_SECRET) {
    throw new Error(
      "TKL_JIRA_WEBHOOK_SECRET is development-only; use TKL_JIRA_WEBHOOK_SECRET_REF in production."
    );
  }
  let secret;
  if (secretRef) {
    secret = await environmentCredentialResolver.resolve(secretRef);
  } else if (environment !== "production" && env.TKL_JIRA_WEBHOOK_SECRET) {
    secret = env.TKL_JIRA_WEBHOOK_SECRET;
  } else {
    throw new Error(
      "Configure TKL_JIRA_WEBHOOK_SECRET_REF, or TKL_JIRA_WEBHOOK_SECRET in development, "
      + "when the Jira webhook is enabled."
    );
  }
  return createJiraWebhookService({
    productId,
    allowedProjects,
    ticketContextCoordinator,
    secret
  });
}

function parseAllowedProjects(value) {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(entries.map((project) => String(project).trim().toUpperCase()).filter(Boolean))];
}
