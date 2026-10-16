import { createHash } from "node:crypto";
import { ApiError } from "./errors.js";
import { SourceConnectionValidationError } from "./source-connection-validation.js";
import { SourceSyncError } from "./source-sync.js";
import { InMemoryGitHubRepositoryStore } from "./github-repository-store.js";

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

const SOURCES = Object.freeze([
  { source: "jira", displayName: "Jira", ingestionSupported: true },
  { source: "github", displayName: "GitHub", ingestionSupported: true },
  { source: "testrail", displayName: "TestRail", ingestionSupported: true },
  { source: "confluence", displayName: "Confluence", ingestionSupported: true },
  { source: "reportportal", displayName: "ReportPortal", ingestionSupported: true }
]);

export function createSourceConnectionService({
  tenantId,
  vaultFactory,
  validateConnection,
  discoverTestRailSuites,
  discoverTestRailSections,
  discoverConfluencePages,
  syncSource,
  executeSourceAction,
  repositoryStoreFactory = ({ tenantId: scopeTenantId, productId }) =>
    new InMemoryGitHubRepositoryStore({ tenantId: scopeTenantId, productId }),
  now = () => new Date().toISOString()
}) {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new TypeError("tenantId is required");
  }
  if (typeof vaultFactory !== "function") {
    throw new TypeError("vaultFactory is required");
  }
  if (typeof validateConnection !== "function") {
    throw new TypeError("validateConnection is required");
  }
  if (typeof syncSource !== "function") {
    throw new TypeError("syncSource is required");
  }

  const vaults = new Map();
  const repositoryStores = new Map();
  const operationTails = new Map();
  const activeProductSyncs = new Map();
  const activeRepositorySyncs = new Map();
  const activeHydrations = new Map();
  const activeEnrichments = new Map();
  const activeProductRemoteOperations = new Map();
  const pendingProductSyncs = new Set();
  let ticketContextCoordinator = null;

  function operationKey(productId, source) {
    return `${productId}:${source}`;
  }

  function hasActiveRepositorySync(productId) {
    return [...activeRepositorySyncs.keys()].some(
      (key) => key.startsWith(`${productId}:`)
    );
  }

  function hasActiveGitHubSync(productId) {
    return hasActiveRepositorySync(productId)
      || activeProductSyncs.get(productId)?.source === "github";
  }

  async function getVault(productId) {
    let vault = vaults.get(productId);
    if (!vault) {
      vault = Promise.resolve(vaultFactory({ tenantId, productId }));
      vaults.set(productId, vault);
    }
    return vault;
  }

  async function getRepositoryStore(productId) {
    let store = repositoryStores.get(productId);
    if (!store) {
      store = Promise.resolve(repositoryStoreFactory({ tenantId, productId }));
      repositoryStores.set(productId, store);
    }
    return store;
  }

  async function ensureGitHubRepositories(productId, record, requestedRepositories) {
    const store = await getRepositoryStore(productId);
    const legacyRepositories = normalizeLegacyRepositories(
      requestedRepositories ?? record?.config?.repositories
    );
    const webBaseUrl = record?.config?.webBaseUrl ?? "https://github.com";
    const current = store.read();
    const mayMigrate = !current.legacyMigrated || requestedRepositories !== undefined;
    const currentNames = new Set(
      current.repositories.map((target) => target.repository.toLowerCase())
    );
    const requiresMigration = mayMigrate && legacyRepositories.some(
      (repository) => !currentNames.has(repository.toLowerCase())
    );
    const requiresUrlUpdate = current.repositories.some(
      (target) => target.url !== repositoryUrl(webBaseUrl, target.repository)
    );
    if (!current.legacyMigrated || requiresMigration || requiresUrlUpdate) {
      await store.transact((snapshot) => {
        const existing = new Map(
          snapshot.repositories.map((target) => [target.repository.toLowerCase(), target])
        );
        if (!snapshot.legacyMigrated || requestedRepositories !== undefined) {
          for (const repository of legacyRepositories) {
            const key = repository.toLowerCase();
            if (existing.has(key)) continue;
            const target = createRepositoryTarget({
              repository,
              url: repositoryUrl(webBaseUrl, repository),
              now: now()
            });
            snapshot.repositories.push(target);
            existing.set(key, target);
          }
        }
        snapshot.legacyMigrated = true;
        for (const target of snapshot.repositories) {
          target.url = repositoryUrl(webBaseUrl, target.repository);
        }
        assertRepositorySnapshot(snapshot.repositories);
      });
    }
    return recoverInterruptedRepositories(productId, store);
  }

    async function recoverInterruptedRepositories(productId, store) {
      const snapshot = store.read();
      const interrupted = snapshot.repositories.filter(
        (target) =>
          target.syncStatus === "syncing"
          && !activeRepositorySyncs.has(repositoryOperationKey(productId, target.id))
      );
      if (interrupted.length === 0) return snapshot.repositories;
      await store.transact((draft) => {
        for (const target of draft.repositories) {
          if (!interrupted.some((candidate) => candidate.id === target.id)) continue;
          target.syncStatus = "failed";
          target.error = {
            code: "sync_interrupted",
            category: "internal",
            message: "The previous repository synchronization was interrupted. Retry it."
          };
        }
      });
      return store.read().repositories;
    }

    async function updateRepository(productId, repositoryId, mutator) {
      const store = await getRepositoryStore(productId);
      return store.transact((snapshot) => {
        const target = snapshot.repositories.find((candidate) => candidate.id === repositoryId);
        if (!target) {
          throw new ApiError(404, "repository_not_found", "GitHub repository target was not found.");
        }
        mutator(target, snapshot);
        assertRepositorySnapshot(snapshot.repositories);
        return target;
      });
    }

    async function getRepository(productId, repositoryId) {
      const record = await getRecord(productId, "github");
      const targets = await ensureGitHubRepositories(productId, record);
      const target = targets.find((candidate) => candidate.id === repositoryId);
      if (!target) {
        throw new ApiError(404, "repository_not_found", "GitHub repository target was not found.");
      }
      return target;
    }

    async function persistRepositoryAllowlist(productId) {
      const vault = await getVault(productId);
      const record = vault.get(tenantId, productId, "github");
      if (!record) return;
      const store = await getRepositoryStore(productId);
      const repositories = store.read().repositories.map((target) => target.repository);
      const config = { ...record.config };
      if (repositories.length > 0) config.repositories = repositories;
      else delete config.repositories;
      await vault.upsertConnection({
        tenantId,
        productId,
        source: "github",
        ownerSubject: record.ownerSubject,
        config,
        status: record.status
      });
    }

    async function validateGitHubRepositories({
      productId,
      record,
      config,
      credential,
      repositoryIds
    }) {
      const targets = await ensureGitHubRepositories(productId, { ...record, config });
      const selected = targets.filter((target) =>
        repositoryIds
          ? repositoryIds.includes(target.id)
          : target.enabled && target.lifecycle !== "archived"
      );
      if (
        repositoryIds
        && repositoryIds.some(
          (repositoryId) => !targets.some((target) => target.id === repositoryId)
        )
      ) {
        throw new ApiError(404, "repository_not_found", "GitHub repository target was not found.");
      }
      if (selected.length === 0) {
        throw new ApiError(
          409,
          "no_enabled_repositories",
          "No enabled GitHub repository targets are available."
        );
      }
      const outcomes = [];
      for (const target of selected) {
        await updateRepository(productId, target.id, (draft) => {
          draft.validationStatus = "validating";
          draft.error = null;
        });
        try {
          const result = await validateConnection({
            source: "github",
            config: { ...config, repositories: [target.repository] },
            credential
          });
          const validatedAt = result?.validatedAt ?? now();
          await updateRepository(productId, target.id, (draft) => {
            draft.validationStatus = "valid";
            draft.lastValidatedAt = validatedAt;
            draft.error = null;
          });
          outcomes.push({ repositoryId: target.id, status: "valid", validatedAt });
        } catch (error) {
          const safeError = sanitizeOperationError(error, [credential]);
          const validatedAt = now();
          await updateRepository(productId, target.id, (draft) => {
            draft.validationStatus = "failed";
            draft.lastValidatedAt = validatedAt;
            draft.error = safeError;
          });
          outcomes.push({
            repositoryId: target.id,
            status: "failed",
            validatedAt,
            error: safeError
          });
          if (
            error instanceof SourceConnectionValidationError
            && error.code === "source_authorization_failed"
          ) {
            for (const remaining of selected) {
              if (outcomes.some((outcome) => outcome.repositoryId === remaining.id)) continue;
              await updateRepository(productId, remaining.id, (draft) => {
                draft.validationStatus = "failed";
                draft.lastValidatedAt = validatedAt;
                draft.error = safeError;
              });
            }
            throw error;
          }
        }
      }
      return outcomes;
    }

    async function connectGitHub({
      productId,
      credential,
      config,
      ownerSubject,
      vault,
      existing
    }) {
      const repositories = normalizeLegacyRepositories(config.repositories);
      if (existing) {
        await vault.updateStatus({
          tenantId,
          productId,
          source: "github",
          status: "validating"
        });
      } else {
        await vault.upsertConnection({
          tenantId,
          productId,
          source: "github",
          ownerSubject,
          config: { ...config, repositories },
          status: "validating"
        });
      }
      const mergedTargets = await ensureGitHubRepositories(
        productId,
        { ...existing, config },
        repositories
      );
      const mergedConfig = {
        ...config,
        repositories: mergedTargets.map((target) => target.repository)
      };
      try {
        const outcomes = await validateGitHubRepositories({
          productId,
          record: existing,
          config: mergedConfig,
          credential
        });
        const timestamp = outcomes.reduce(
          (latest, outcome) => outcome.validatedAt > latest ? outcome.validatedAt : latest,
          outcomes[0]?.validatedAt ?? now()
        );
        await vault.upsertConnection({
          tenantId,
          productId,
          source: "github",
          ownerSubject,
          config: mergedConfig,
          credential,
          status: "connected"
        });
        const updated = await vault.updateStatus({
          tenantId,
          productId,
          source: "github",
          status: "connected",
          error: null,
          connectedAt: existing?.connectedAt ?? timestamp,
          lastValidatedAt: timestamp
        });
        return toConnection(
          sourceDefinition("github"),
          updated,
          (await getRepositoryStore(productId)).read().repositories
        );
      } catch (error) {
        const safeError = sanitizeOperationError(error, [credential]);
        await vault.updateStatus({
          tenantId,
          productId,
          source: "github",
          status: error instanceof SourceConnectionValidationError
            ? error.connectionStatus
            : "error",
          error: safeError,
          lastValidatedAt: now()
        });
        throw new ApiError(
          error instanceof SourceConnectionValidationError ? 422 : 502,
          safeError.code,
          safeError.message
        );
      }
    }

    async function runGitHubRepositorySync({
      productId,
      repositoryId,
      signal,
      throwOnFailure = true
    }) {
      const operationId = repositoryOperationKey(productId, repositoryId);
      if (activeRepositorySyncs.has(operationId)) {
        throw new ApiError(
          409,
          "sync_already_in_progress",
          "A synchronization is already in progress for this repository."
        );
      }
      const vault = await getVault(productId);
      const record = vault.get(tenantId, productId, "github");
      if (!record?.hasCredential) {
        throw new ApiError(409, "source_not_connected", "GitHub is not connected.");
      }
      const target = await getRepository(productId, repositoryId);
      if (!target.enabled || target.lifecycle === "archived") {
        throw new ApiError(
          409,
          "repository_disabled",
          "The GitHub repository target is disabled or archived."
        );
      }
      const controller = signal ? null : new AbortController();
      const effectiveSignal = signal ?? controller.signal;
      let settle;
      const settled = new Promise((resolve) => {
        settle = resolve;
      });
      const reservation = { controller, signal: effectiveSignal, settled };
      activeRepositorySyncs.set(operationId, reservation);
      const startedAt = now();
      try {
        await updateRepository(productId, repositoryId, (draft) => {
          draft.syncStatus = "syncing";
          draft.lastSyncAt = startedAt;
          draft.error = null;
        });
        const result = await syncSource({
          productId,
          source: "github",
          repositoryId,
          config: {
            ...record.config,
            repositories: [target.repository]
          },
          resolveCredential: async () => {
            const credential = await vault.resolveCredential(
              tenantId,
              productId,
              "github"
            );
            if (!credential) throw new Error("Credential is no longer available");
            return credential;
          },
          signal: effectiveSignal
        });
        if (effectiveSignal.aborted) {
          throw new SourceSyncError("sync_cancelled", "The synchronization was cancelled.");
        }
        const completedAt = now();
        return await updateRepository(productId, repositoryId, (draft) => {
          draft.syncStatus = "succeeded";
          draft.lastSuccessfulSyncAt = completedAt;
          draft.recordsCollected = Number.isSafeInteger(result?.recordsCollected)
            ? result.recordsCollected
            : 0;
          draft.error = null;
        });
      } catch (error) {
        const safeError = sanitizeOperationError(error);
        const cancelled = effectiveSignal.aborted
          || (error instanceof SourceSyncError && error.code === "sync_cancelled");
        const updated = await updateRepository(productId, repositoryId, (draft) => {
          draft.syncStatus = cancelled ? "cancelled" : "failed";
          draft.error = cancelled ? cancelledSyncError() : safeError;
        });
        if (!throwOnFailure) {
          return { ...updated, failed: true };
        }
        throw new ApiError(
          cancelled ? 409 : 502,
          updated.error.code,
          updated.error.message
        );
      } finally {
        if (activeRepositorySyncs.get(operationId) === reservation) {
          activeRepositorySyncs.delete(operationId);
        }
        settle();
      }
    }

    async function syncGitHubRepositories({ productId }) {
      const activeRemoteOperation = activeProductRemoteOperations.get(productId);
      if (activeRemoteOperation) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "A remote source operation is already in progress for this product."
        );
      }
      if (hasActiveRepositorySync(productId)) {
        throw new ApiError(
          409,
          "repository_sync_in_progress",
          "A GitHub repository synchronization is already in progress for this product."
        );
      }
      const vault = await getVault(productId);
      const record = vault.get(tenantId, productId, "github");
      if (!record?.hasCredential) {
        throw new ApiError(409, "source_not_connected", "GitHub is not connected.");
      }
      const targets = (await ensureGitHubRepositories(productId, record))
        .filter((target) => target.enabled && target.lifecycle !== "archived");
      if (targets.length === 0) {
        throw new ApiError(
          409,
          "no_enabled_repositories",
          "No enabled GitHub repository targets are available."
        );
      }
      const controller = new AbortController();
      let settle;
      const settled = new Promise((resolve) => {
        settle = resolve;
      });
      const reservation = { source: "github", controller, settled };
      activeProductSyncs.set(productId, reservation);
      activeProductRemoteOperations.set(productId, { kind: "sync", source: "github" });
      const startedAt = now();
      const run = (async () => {
        await vault.updateStatus({
          tenantId,
          productId,
          source: "github",
          status: "syncing",
          lastSyncAt: startedAt
        });
        const outcomes = [];
        for (const target of targets) {
          if (controller.signal.aborted) break;
          outcomes.push(await runGitHubRepositorySync({
            productId,
            repositoryId: target.id,
            signal: controller.signal,
            throwOnFailure: false
          }));
        }
        if (controller.signal.aborted) {
          await vault.updateStatus({
            tenantId,
            productId,
            source: "github",
            status: "error",
            error: cancelledSyncError(),
            lastSyncAt: startedAt
          });
          throw new ApiError(409, "sync_cancelled", "The synchronization was cancelled.");
        }
        const successful = outcomes.filter((outcome) => !outcome.failed);
        if (successful.length === 0) {
          const safeError = {
            code: "source_sync_failed",
            category: "provider",
            message: "No enabled GitHub repository synchronized successfully."
          };
          await vault.updateStatus({
            tenantId,
            productId,
            source: "github",
            status: "error",
            error: safeError,
            lastSyncAt: startedAt
          });
          throw new ApiError(502, safeError.code, safeError.message);
        }
        const completedAt = now();
        const updated = await vault.updateStatus({
          tenantId,
          productId,
          source: "github",
          status: "connected",
          error: null,
          lastSyncAt: startedAt,
          lastSuccessfulSyncAt: completedAt
        });
        if (controller.signal.aborted) {
          await vault.updateStatus({
            tenantId,
            productId,
            source: "github",
            status: "error",
            error: cancelledSyncError(),
            lastSyncAt: startedAt,
            lastSuccessfulSyncAt: record.lastSuccessfulSyncAt ?? null
          });
          throw new ApiError(409, "sync_cancelled", "The synchronization was cancelled.");
        }
        return toConnection(
          sourceDefinition("github"),
          updated,
          (await getRepositoryStore(productId)).read().repositories
        );
      })();
      return run.finally(() => {
        if (activeProductSyncs.get(productId) === reservation) {
          activeProductSyncs.delete(productId);
        }
        if (activeProductRemoteOperations.get(productId)?.source === "github") {
          activeProductRemoteOperations.delete(productId);
        }
        settle();
      });
  }

  async function retrieveRelatedSources(productId, issueKey, vault, signal) {
    const enrichmentSpecs = [
      { source: "testrail", retrieve: syncSource.retrieveTestRailCases },
      { source: "github", retrieve: syncSource.retrieveGitHubPullRequests }
    ];
    const outcomes = await Promise.all(enrichmentSpecs.map(async ({ source, retrieve }) => {
      const sourceRecord = vault.get(tenantId, productId, source);
      if (!sourceRecord?.hasCredential || typeof retrieve !== "function") {
        return [source, { status: "not-connected", recordsCollected: 0 }];
      }
      try {
        let config = sourceRecord.config;
        if (source === "github") {
          const repositories = await ensureGitHubRepositories(productId, sourceRecord);
          config = {
            ...config,
            repositories: repositories
              .filter((target) => target.enabled && target.lifecycle !== "archived")
              .map((target) => target.repository)
          };
          if (config.repositories.length === 0) {
            return [source, { status: "not-connected", recordsCollected: 0 }];
          }
        }
        const result = await retrieve({
          productId,
          issueKey,
          config,
          signal,
          resolveCredential: async () => {
            const credential = await vault.resolveCredential(
              tenantId,
              productId,
              source
            );
            if (!credential) throw new Error("Credential is no longer available");
            return credential;
          }
        });
        return [source, result];
      } catch (error) {
        if (signal?.aborted) throw error;
        return [source, {
          status: "unavailable",
          recordsCollected: 0,
          error: sanitizeOperationError(error)
        }];
      }
    }));
    return Object.fromEntries(outcomes);
  }

  async function runExclusive(productId, source, operation) {
    const key = operationKey(productId, source);
    const previous = operationTails.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(() => undefined, () => undefined);
    operationTails.set(key, tail);
    try {
      return await current;
    } finally {
      if (operationTails.get(key) === tail) operationTails.delete(key);
    }
  }

  async function getRecord(productId, source) {
    const vault = await getVault(productId);
    return vault.get(tenantId, productId, source);
  }

  return Object.freeze({
    async list({ productId }) {
      const vault = await getVault(productId);
      const storedRecords = vault.list(tenantId, productId);
      const recoveredRecords = await Promise.all(storedRecords.map(async (record) => {
        if (
          record.status === "syncing"
          && !operationTails.has(operationKey(productId, record.source))
          && !activeProductSyncs.has(productId)
        ) {
          return vault.updateStatus({
            tenantId,
            productId,
            source: record.source,
            status: "error",
            error: {
              code: "sync_interrupted",
              category: "internal",
              message: "The previous synchronization was interrupted. Retry the synchronization."
            }
          });
        }
        return record;
      }));
      const records = new Map(
        recoveredRecords.map((record) => [record.source, record])
      );
      return Promise.all(SOURCES.map(async (definition) => {
        let record = records.get(definition.source);
        const repositories = definition.source === "github" && record
          ? await ensureGitHubRepositories(productId, record)
          : [];
        if (
          definition.source === "github"
          && record
          && typeof record.config.repositories === "string"
        ) {
          await persistRepositoryAllowlist(productId);
          record = vault.get(tenantId, productId, "github");
        }
        return toConnection(definition, record, repositories);
      }));
    },

    async connect({ productId, source, credential, config, ownerSubject }) {
      if (source === "github" && hasActiveGitHubSync(productId)) {
        throw new ApiError(
          409,
          "repository_sync_in_progress",
          "GitHub cannot be reconfigured while a repository sync is running."
        );
      }
      return runExclusive(productId, source, async () => {
        if (source === "github" && hasActiveGitHubSync(productId)) {
          throw new ApiError(
            409,
            "repository_sync_in_progress",
            "GitHub cannot be reconfigured while a repository sync is running."
          );
        }
        const vault = await getVault(productId);
        const existing = vault.get(tenantId, productId, source);
        if (source === "github") {
          return connectGitHub({
            productId,
            credential,
            config,
            ownerSubject,
            vault,
            existing
          });
        }
        if (existing) {
          await vault.updateStatus({ tenantId, productId, source, status: "validating" });
        } else {
          await vault.upsertConnection({
            tenantId,
            productId,
            source,
            ownerSubject,
            config,
            status: "validating"
          });
        }
        try {
          const result = await validateConnection({ source, config, credential });
          const timestamp = result?.validatedAt ?? now();
          await vault.upsertConnection({
            tenantId,
            productId,
            source,
            ownerSubject,
            config,
            credential,
            status: "connected"
          });
          const updated = await vault.updateStatus({
            tenantId,
            productId,
            source,
            status: "connected",
            error: null,
            connectedAt: existing?.connectedAt ?? timestamp,
            lastValidatedAt: timestamp
          });
          return toConnection(sourceDefinition(source), updated);
        } catch (error) {
          const safeError = sanitizeOperationError(error, [credential]);
          await vault.updateStatus({
            tenantId,
            productId,
            source,
            status: error instanceof SourceConnectionValidationError
              ? error.connectionStatus
              : "error",
            error: safeError,
            lastValidatedAt: now()
          });
          throw new ApiError(
            error instanceof SourceConnectionValidationError ? 422 : 502,
            safeError.code,
            safeError.message
          );
        }
      });
    },

    async discoverTestRailSuites({ config, credential }) {
      if (typeof discoverTestRailSuites !== "function") {
        throw new ApiError(
          409,
          "discovery_not_supported",
          "TestRail suite discovery is not available."
        );
      }
      try {
        return await discoverTestRailSuites({ config, credential });
      } catch (error) {
        const safeError = sanitizeOperationError(error, [credential]);
        throw new ApiError(
          error instanceof SourceConnectionValidationError ? 422 : 502,
          safeError.code,
          safeError.message
        );
      }
    },

    async discoverTestRailSections({ productId, suiteId }) {
      if (typeof discoverTestRailSections !== "function") {
        throw new ApiError(
          409,
          "discovery_not_supported",
          "TestRail section discovery is not available."
        );
      }
      const vault = await getVault(productId);
      const record = vault.get(tenantId, productId, "testrail");
      const credential = await vault.resolveCredential(tenantId, productId, "testrail");
      if (!record?.hasCredential || !credential) {
        throw new ApiError(409, "source_not_connected", "TestRail is not connected.");
      }
      try {
        return await discoverTestRailSections({
          config: record.config,
          credential,
          suiteId
        });
      } catch (error) {
        const safeError = sanitizeOperationError(error, [credential]);
        throw new ApiError(
          error instanceof SourceConnectionValidationError ? 422 : 502,
          safeError.code,
          safeError.message
        );
      }
    },

    async discoverConfluencePages({ config, credential }) {
      if (typeof discoverConfluencePages !== "function") {
        throw new ApiError(
          409,
          "discovery_not_supported",
          "Confluence page discovery is not available."
        );
      }
      try {
        return await discoverConfluencePages({ config, credential });
      } catch (error) {
        const safeError = sanitizeOperationError(error, [credential]);
        throw new ApiError(
          error instanceof SourceConnectionValidationError ? 422 : 502,
          safeError.code,
          safeError.message
        );
      }
    },

    async test({ productId, source }) {
      return runExclusive(productId, source, async () => {
        const vault = await getVault(productId);
        const record = vault.get(tenantId, productId, source);
        const credential = await vault.resolveCredential(tenantId, productId, source);
        if (!record || !credential) {
          throw new ApiError(409, "source_not_connected", "The source is not connected.");
        }
        if (source === "github") {
          if (hasActiveGitHubSync(productId)) {
            throw new ApiError(
              409,
              "repository_sync_in_progress",
              "GitHub repositories cannot be tested while a repository sync is running."
            );
          }
          await vault.updateStatus({
            tenantId,
            productId,
            source,
            status: "validating"
          });
          try {
            const outcomes = await validateGitHubRepositories({
              productId,
              record,
              config: record.config,
              credential
            });
            const updated = await vault.updateStatus({
              tenantId,
              productId,
              source,
              status: "connected",
              error: null,
              lastValidatedAt: outcomes.reduce(
                (latest, outcome) =>
                  outcome.validatedAt > latest ? outcome.validatedAt : latest,
                outcomes[0]?.validatedAt ?? now()
              )
            });
            return toConnection(
              sourceDefinition(source),
              updated,
              (await getRepositoryStore(productId)).read().repositories
            );
          } catch (error) {
            const safeError = sanitizeOperationError(error, [credential]);
            await vault.updateStatus({
              tenantId,
              productId,
              source,
              status: error instanceof SourceConnectionValidationError
                ? error.connectionStatus
                : "error",
              error: safeError,
              lastValidatedAt: now()
            });
            throw new ApiError(
              error instanceof SourceConnectionValidationError ? 422 : 502,
              safeError.code,
              safeError.message
            );
          }
        }
        await vault.updateStatus({ tenantId, productId, source, status: "validating" });
        try {
          const result = await validateConnection({
            source,
            config: record.config,
            credential
          });
          const updated = await vault.updateStatus({
            tenantId,
            productId,
            source,
            status: "connected",
            error: null,
            lastValidatedAt: result?.validatedAt ?? now()
          });
          return toConnection(sourceDefinition(source), updated);
        } catch (error) {
          const safeError = sanitizeOperationError(error);
          await vault.updateStatus({
            tenantId,
            productId,
            source,
            status: error instanceof SourceConnectionValidationError
              ? error.connectionStatus
              : "error",
            error: safeError,
            lastValidatedAt: now()
          });
          throw new ApiError(
            error instanceof SourceConnectionValidationError ? 422 : 502,
            safeError.code,
            safeError.message
          );
        }
      });
    },

    async sync({ productId, source }) {
      await ticketContextCoordinator?.beginFullSync(productId);
      try {
      if (source === "github") {
        const key = "github.aggregate-sync";
        if (operationTails.has(operationKey(productId, key))) {
          throw new ApiError(
            409,
            "product_sync_in_progress",
            "A GitHub synchronization is already in progress."
          );
        }
        return runExclusive(productId, key, () => syncGitHubRepositories({ productId }));
      }
      if (hasActiveRepositorySync(productId)) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "A GitHub repository synchronization is already in progress for this product."
        );
      }
      let activeRemoteOperation = activeProductRemoteOperations.get(productId);
      if (activeRemoteOperation?.kind === "enrichment") {
        pendingProductSyncs.add(productId);
        try {
          await activeEnrichments.get(`${productId}:${activeRemoteOperation.issueKey}`);
        } finally {
          pendingProductSyncs.delete(productId);
        }
        activeRemoteOperation = activeProductRemoteOperations.get(productId);
      }
      if (activeRemoteOperation) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          activeRemoteOperation.kind === "sync"
            ? `A synchronization is already in progress for ${sourceDefinition(activeRemoteOperation.source).displayName}.`
            : `Targeted Jira retrieval is already in progress for ${activeRemoteOperation.issueKey}.`
        );
      }
      if (operationTails.has(operationKey(productId, source))) {
        throw new ApiError(
          409,
          "sync_already_in_progress",
          "A synchronization is already in progress for this source."
        );
      }
      const controller = new AbortController();
      let settle;
      const settled = new Promise((resolve) => {
        settle = resolve;
      });
      const reservation = { source, controller, settled };
      activeProductSyncs.set(productId, reservation);
      activeProductRemoteOperations.set(productId, {
        kind: "sync",
        source
      });

      const run = runExclusive(productId, source, async () => {
        const definition = sourceDefinition(source);
        if (!definition.ingestionSupported) {
          throw new ApiError(
            409,
            "ingestion_not_supported",
            `${definition.displayName} ingestion is not available yet.`
          );
        }
        const vault = await getVault(productId);
        const record = vault.get(tenantId, productId, source);
        if (!record?.hasCredential) {
          throw new ApiError(409, "source_not_connected", "The source is not connected.");
        }
        const startedAt = now();
        await vault.updateStatus({
          tenantId,
          productId,
          source,
          status: "syncing",
          lastSyncAt: startedAt
        });
        try {
          await syncSource({
            productId,
            source,
            config: record.config,
            resolveCredential: async () => {
              const credential = await vault.resolveCredential(tenantId, productId, source);
              if (!credential) throw new Error("Credential is no longer available");
              return credential;
            },
            signal: controller.signal
          });
          if (controller.signal.aborted) {
            throw new SourceSyncError(
              "sync_cancelled",
              "The synchronization was cancelled."
            );
          }
          const completedAt = now();
          let updated = await vault.updateStatus({
            tenantId,
            productId,
            source,
            status: "connected",
            error: null,
            lastSyncAt: startedAt,
            lastSuccessfulSyncAt: completedAt
          });
          if (controller.signal.aborted) {
            updated = await vault.updateStatus({
              tenantId,
              productId,
              source,
              status: "error",
              error: cancelledSyncError(),
              lastSyncAt: startedAt,
              lastSuccessfulSyncAt: record.lastSuccessfulSyncAt ?? null
            });
            throw new SourceSyncError(
              "sync_cancelled",
              "The synchronization was cancelled."
            );
          }
          return toConnection(definition, updated);
        } catch (error) {
          const safeError = sanitizeOperationError(error);
          await vault.updateStatus({
            tenantId,
            productId,
            source,
            status: "error",
            error: safeError,
            lastSyncAt: startedAt
          });
          throw new ApiError(
            error instanceof SourceSyncError
              && (error.code === "ingestion_not_supported" || error.code === "sync_cancelled")
              ? 409
              : 502,
            safeError.code,
            safeError.message
          );
        }
      });
      return await run.finally(() => {
        if (activeProductSyncs.get(productId) === reservation) {
          activeProductSyncs.delete(productId);
        }
        if (activeProductRemoteOperations.get(productId)?.kind === "sync") {
          activeProductRemoteOperations.delete(productId);
        }
        settle();
      });
      } finally {
        await ticketContextCoordinator?.endFullSync(productId);
      }
    },

    async hydrateJiraIssue({ productId, issueKey, signal }) {
      if (typeof syncSource.retrieveJiraIssue !== "function") {
        throw new ApiError(
          409,
          "retrieval_not_supported",
          "Targeted Jira retrieval is not available."
        );
      }
      if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey ?? "")) {
        throw new ApiError(
          400,
          "invalid_issue_key",
          "A valid Jira issue key is required for targeted retrieval."
        );
      }
      const normalizedIssueKey = issueKey.toUpperCase();
      const key = `${productId}:${normalizedIssueKey}`;
      const existing = activeHydrations.get(key);
      if (existing) return existing;
      if (hasActiveRepositorySync(productId)) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "Targeted retrieval is unavailable while a repository synchronization is running."
        );
      }
      let activeRemoteOperation = activeProductRemoteOperations.get(productId);
      if (activeRemoteOperation?.kind === "enrichment") {
        await activeEnrichments.get(`${productId}:${activeRemoteOperation.issueKey}`);
        const hydrationAfterEnrichment = activeHydrations.get(key);
        if (hydrationAfterEnrichment) return hydrationAfterEnrichment;
        activeRemoteOperation = activeProductRemoteOperations.get(productId);
      }
      if (activeRemoteOperation) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          activeRemoteOperation.kind === "sync"
            ? "Targeted retrieval is unavailable while a product synchronization is running."
            : `Targeted Jira retrieval is already in progress for ${activeRemoteOperation.issueKey}.`
        );
      }
      const hydration = (async () => {
        const vault = await getVault(productId);
        const record = vault.get(tenantId, productId, "jira");
        if (!record?.hasCredential) {
          throw new ApiError(409, "source_not_connected", "Jira is not connected.");
        }
        try {
          const jiraResult = await syncSource.retrieveJiraIssue({
            productId,
            issueKey,
            config: record.config,
            signal,
            resolveCredential: async () => {
              const credential = await vault.resolveCredential(
                tenantId,
                productId,
                "jira"
              );
              if (!credential) throw new Error("Credential is no longer available");
              return credential;
            }
          });
          return jiraResult;
        } catch (error) {
          const safeError = sanitizeOperationError(error);
          throw new ApiError(
            error instanceof SourceSyncError
              && ["invalid_issue_key", "jira_issue_not_found"].includes(error.code)
              ? 404
              : 502,
            safeError.code,
            safeError.message
          );
        }
      })().finally(() => {
        if (activeHydrations.get(key) === hydration) activeHydrations.delete(key);
        if (
          activeProductRemoteOperations.get(productId)?.kind === "hydration"
          && activeProductRemoteOperations.get(productId)?.issueKey === normalizedIssueKey
        ) {
          activeProductRemoteOperations.delete(productId);
        }
      });
      activeHydrations.set(key, hydration);
      activeProductRemoteOperations.set(productId, {
        kind: "hydration",
        issueKey: normalizedIssueKey
      });
      return hydration;
    },

    async hydrateTestRailCase({ productId, caseId, signal }) {
      if (typeof syncSource.retrieveTestRailCase !== "function") {
        throw new ApiError(
          409,
          "retrieval_not_supported",
          "Exact TestRail case retrieval is not available."
        );
      }
      const rawCaseId = typeof caseId === "number" || typeof caseId === "string"
        ? String(caseId).trim().replace(/^C/i, "")
        : "";
      if (!/^\d+$/.test(rawCaseId) || BigInt(rawCaseId) <= 0n) {
        throw new ApiError(
          400,
          "invalid_case_id",
          "A positive TestRail case ID is required for targeted retrieval."
        );
      }
      const normalizedCaseId = BigInt(rawCaseId).toString();
      const key = `testrail:${productId}:${normalizedCaseId}`;
      const existing = activeHydrations.get(key);
      if (existing) return existing;
      if (pendingProductSyncs.has(productId) || hasActiveRepositorySync(productId)) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "Targeted retrieval is unavailable while a synchronization is active."
        );
      }
      if (activeProductRemoteOperations.has(productId)) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "Another targeted retrieval is already in progress for this product."
        );
      }
      const hydration = (async () => {
        const vault = await getVault(productId);
        const record = vault.get(tenantId, productId, "testrail");
        if (!record?.hasCredential) {
          throw new ApiError(409, "source_not_connected", "TestRail is not connected.");
        }
        try {
          return await syncSource.retrieveTestRailCase({
            productId,
            caseId: normalizedCaseId,
            config: record.config,
            signal,
            resolveCredential: async () => {
              const credential = await vault.resolveCredential(
                tenantId,
                productId,
                "testrail"
              );
              if (!credential) throw new Error("Credential is no longer available");
              return credential;
            }
          });
        } catch (error) {
          const safeError = sanitizeOperationError(error);
          throw new ApiError(
            error instanceof SourceSyncError
              && ["invalid_case_id", "testrail_case_not_found"].includes(error.code)
              ? 404
              : error instanceof ApiError ? error.status : 502,
            safeError.code,
            safeError.message
          );
        }
      })().finally(() => {
        if (activeHydrations.get(key) === hydration) activeHydrations.delete(key);
        const remoteOperation = activeProductRemoteOperations.get(productId);
        if (
          remoteOperation?.kind === "artifact-hydration"
          && remoteOperation?.source === "testrail"
          && remoteOperation?.artifactId === normalizedCaseId
        ) {
          activeProductRemoteOperations.delete(productId);
        }
      });
      activeHydrations.set(key, hydration);
      activeProductRemoteOperations.set(productId, {
        kind: "artifact-hydration",
        source: "testrail",
        artifactId: normalizedCaseId
      });
      return hydration;
    },

    async hydrateTestRailCaseNeighborhood({ productId, caseId, signal, maxRecords = 100 }) {
      if (typeof syncSource.retrieveTestRailCaseNeighborhood !== "function") {
        throw new ApiError(
          409,
          "retrieval_not_supported",
          "Bounded TestRail neighborhood retrieval is not available."
        );
      }
      const rawCaseId = typeof caseId === "number" || typeof caseId === "string"
        ? String(caseId).trim().replace(/^C/i, "")
        : "";
      if (!/^\d+$/.test(rawCaseId) || BigInt(rawCaseId) <= 0n) {
        throw new ApiError(
          400,
          "invalid_case_id",
          "A positive TestRail case ID is required for targeted retrieval."
        );
      }
      if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100) {
        throw new ApiError(
          400,
          "invalid_record_budget",
          "maxRecords must be an integer between 1 and 100."
        );
      }
      const normalizedCaseId = BigInt(rawCaseId).toString();
      const key = `testrail-neighborhood:${productId}:${normalizedCaseId}:${maxRecords}`;
      const existing = activeHydrations.get(key);
      if (existing) return existing;
      if (
        pendingProductSyncs.has(productId)
        || hasActiveRepositorySync(productId)
        || activeProductRemoteOperations.has(productId)
      ) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "Targeted retrieval is unavailable while another remote operation is active."
        );
      }
      const hydration = (async () => {
        const vault = await getVault(productId);
        const record = vault.get(tenantId, productId, "testrail");
        if (!record?.hasCredential) {
          throw new ApiError(409, "source_not_connected", "TestRail is not connected.");
        }
        try {
          return await syncSource.retrieveTestRailCaseNeighborhood({
            productId,
            caseId: normalizedCaseId,
            maxRecords,
            config: record.config,
            signal,
            resolveCredential: async () => {
              const credential = await vault.resolveCredential(
                tenantId,
                productId,
                "testrail"
              );
              if (!credential) throw new Error("Credential is no longer available");
              return credential;
            }
          });
        } catch (error) {
          const safeError = sanitizeOperationError(error);
          throw new ApiError(
            error instanceof ApiError ? error.status : 502,
            safeError.code,
            safeError.message
          );
        }
      })().finally(() => {
        if (activeHydrations.get(key) === hydration) activeHydrations.delete(key);
        const operation = activeProductRemoteOperations.get(productId);
        if (
          operation?.kind === "artifact-hydration"
          && operation?.source === "testrail"
          && operation?.artifactId === `neighborhood:${normalizedCaseId}`
        ) {
          activeProductRemoteOperations.delete(productId);
        }
      });
      activeHydrations.set(key, hydration);
      activeProductRemoteOperations.set(productId, {
        kind: "artifact-hydration",
        source: "testrail",
        artifactId: `neighborhood:${normalizedCaseId}`
      });
      return hydration;
    },

    async hydrateTestRailSectionCases({
      productId,
      suiteId,
      sectionId,
      signal,
      maxRecords = 100,
    }) {
      if (typeof syncSource.retrieveTestRailSectionCases !== "function") {
        throw new ApiError(
          409,
          "retrieval_not_supported",
          "Bounded TestRail section retrieval is not available."
        );
      }
      const normalizeId = (value) => {
        const text = typeof value === "string" || typeof value === "number"
          ? String(value).trim()
          : "";
        return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text).toString() : null;
      };
      const normalizedSuiteId = normalizeId(suiteId);
      const normalizedSectionId = normalizeId(sectionId);
      if (!normalizedSuiteId || !normalizedSectionId) {
        throw new ApiError(
          400,
          "invalid_section_scope",
          "Positive TestRail suite and section IDs are required."
        );
      }
      if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100) {
        throw new ApiError(
          400,
          "invalid_record_budget",
          "maxRecords must be an integer between 1 and 100."
        );
      }
      const key =
        `testrail-section:${productId}:${normalizedSuiteId}:${normalizedSectionId}:${maxRecords}`;
      const existing = activeHydrations.get(key);
      if (existing) return existing;
      if (
        pendingProductSyncs.has(productId)
        || hasActiveRepositorySync(productId)
        || activeProductRemoteOperations.has(productId)
      ) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "Targeted retrieval is unavailable while another remote operation is active."
        );
      }
      const hydration = (async () => {
        const vault = await getVault(productId);
        const record = vault.get(tenantId, productId, "testrail");
        if (!record?.hasCredential) {
          throw new ApiError(409, "source_not_connected", "TestRail is not connected.");
        }
        try {
          return await syncSource.retrieveTestRailSectionCases({
            productId,
            suiteId: normalizedSuiteId,
            sectionId: normalizedSectionId,
            maxRecords,
            config: record.config,
            signal,
            resolveCredential: async () => {
              const credential = await vault.resolveCredential(
                tenantId,
                productId,
                "testrail"
              );
              if (!credential) throw new Error("Credential is no longer available");
              return credential;
            }
          });
        } catch (error) {
          const safeError = sanitizeOperationError(error);
          throw new ApiError(
            error instanceof ApiError ? error.status : 502,
            safeError.code,
            safeError.message
          );
        }
      })().finally(() => {
        if (activeHydrations.get(key) === hydration) activeHydrations.delete(key);
        const operation = activeProductRemoteOperations.get(productId);
        if (
          operation?.kind === "artifact-hydration"
          && operation?.source === "testrail"
          && operation?.artifactId === `section:${normalizedSuiteId}:${normalizedSectionId}`
        ) {
          activeProductRemoteOperations.delete(productId);
        }
      });
      activeHydrations.set(key, hydration);
      activeProductRemoteOperations.set(productId, {
        kind: "artifact-hydration",
        source: "testrail",
        artifactId: `section:${normalizedSuiteId}:${normalizedSectionId}`
      });
      return hydration;
    },

    async hydrateReportPortalTestHistory({ productId, identity, signal }) {
      if (typeof syncSource.retrieveReportPortalTestHistory !== "function") {
        throw new ApiError(
          409,
          "retrieval_not_supported",
          "ReportPortal test identity retrieval is not available."
        );
      }
      const normalizedIdentity = typeof identity === "string" ? identity.trim() : "";
      if (normalizedIdentity.length === 0 || normalizedIdentity.length > 500) {
        throw new ApiError(
          400,
          "invalid_test_identity",
          "A ReportPortal uniqueId or codeRef between 1 and 500 characters is required."
        );
      }
      const identityHash = createHash("sha256").update(normalizedIdentity).digest("hex");
      const key = `reportportal:${productId}:${identityHash}`;
      const existing = activeHydrations.get(key);
      if (existing) return existing;
      if (
        pendingProductSyncs.has(productId)
        || hasActiveRepositorySync(productId)
        || activeProductRemoteOperations.has(productId)
      ) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "Targeted retrieval is unavailable while another remote operation is active."
        );
      }
      const hydration = (async () => {
        const vault = await getVault(productId);
        const record = vault.get(tenantId, productId, "reportportal");
        if (!record?.hasCredential) {
          throw new ApiError(409, "source_not_connected", "ReportPortal is not connected.");
        }
        try {
          return await syncSource.retrieveReportPortalTestHistory({
            productId,
            identity: normalizedIdentity,
            config: record.config,
            signal,
            resolveCredential: async () => {
              const credential = await vault.resolveCredential(
                tenantId,
                productId,
                "reportportal"
              );
              if (!credential) throw new Error("Credential is no longer available");
              return credential;
            }
          });
        } catch (error) {
          const safeError = sanitizeOperationError(error);
          throw new ApiError(
            error instanceof ApiError ? error.status : 502,
            safeError.code,
            safeError.message
          );
        }
      })().finally(() => {
        if (activeHydrations.get(key) === hydration) activeHydrations.delete(key);
        const remoteOperation = activeProductRemoteOperations.get(productId);
        if (
          remoteOperation?.kind === "artifact-hydration"
          && remoteOperation?.source === "reportportal"
          && remoteOperation?.artifactId === identityHash
        ) {
          activeProductRemoteOperations.delete(productId);
        }
      });
      activeHydrations.set(key, hydration);
      activeProductRemoteOperations.set(productId, {
        kind: "artifact-hydration",
        source: "reportportal",
        artifactId: identityHash
      });
      return hydration;
    },

    async hydrateConfluenceContext({ productId, query, signal }) {
      if (typeof syncSource.retrieveConfluencePagesByText !== "function") {
        throw new ApiError(
          409,
          "retrieval_not_supported",
          "Contextual Confluence retrieval is not available."
        );
      }
      const normalizedQuery = typeof query === "string" ? query.trim() : "";
      if (normalizedQuery.length < 3 || normalizedQuery.length > 200) {
        throw new ApiError(
          400,
          "invalid_search_query",
          "A contextual query between 3 and 200 characters is required."
        );
      }
      const queryHash = createHash("sha256").update(normalizedQuery).digest("hex");
      const key = `confluence:${productId}:${queryHash}`;
      const existing = activeHydrations.get(key);
      if (existing) return existing;
      if (
        pendingProductSyncs.has(productId)
        || hasActiveRepositorySync(productId)
        || activeProductRemoteOperations.has(productId)
      ) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "Contextual retrieval is unavailable while another remote operation is active."
        );
      }
      const hydration = (async () => {
        const vault = await getVault(productId);
        const record = vault.get(tenantId, productId, "confluence");
        if (!record?.hasCredential) {
          return { status: "not-connected", recordsCollected: 0 };
        }
        try {
          return await syncSource.retrieveConfluencePagesByText({
            productId,
            query: normalizedQuery,
            config: record.config,
            signal,
            resolveCredential: async () => {
              const credential = await vault.resolveCredential(
                tenantId,
                productId,
                "confluence"
              );
              if (!credential) throw new Error("Credential is no longer available");
              return credential;
            }
          });
        } catch (error) {
          const safeError = sanitizeOperationError(error);
          throw new ApiError(
            error instanceof ApiError ? error.status : 502,
            safeError.code,
            safeError.message
          );
        }
      })().finally(() => {
        if (activeHydrations.get(key) === hydration) activeHydrations.delete(key);
        const operation = activeProductRemoteOperations.get(productId);
        if (
          operation?.kind === "artifact-hydration"
          && operation?.source === "confluence"
          && operation?.artifactId === queryHash
        ) {
          activeProductRemoteOperations.delete(productId);
        }
      });
      activeHydrations.set(key, hydration);
      activeProductRemoteOperations.set(productId, {
        kind: "artifact-hydration",
        source: "confluence",
        artifactId: queryHash
      });
      return hydration;
    },

    async enrichJiraIssue({ productId, issueKey, signal }) {
      if (typeof issueKey !== "string" || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey)) {
        throw new ApiError(400, "invalid_issue_key", "A valid Jira issue key is required.");
      }
      const normalizedIssueKey = issueKey.toUpperCase();
      const key = `${productId}:${normalizedIssueKey}`;
      const existing = activeEnrichments.get(key);
      if (existing) return existing;
      if (pendingProductSyncs.has(productId)) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "A synchronization is waiting to start for this product."
        );
      }
      if (hasActiveRepositorySync(productId)) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "Targeted retrieval is unavailable while a repository synchronization is running."
        );
      }
      const activeRemoteOperation = activeProductRemoteOperations.get(productId);
      if (activeRemoteOperation) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          activeRemoteOperation.kind === "sync"
            ? `A ${sourceDefinition(activeRemoteOperation.source).displayName} synchronization is already in progress for this product.`
            : `Targeted retrieval is already in progress for ${activeRemoteOperation.issueKey}.`
        );
      }
      const enrichment = (async () => {
        const vault = await getVault(productId);
        return retrieveRelatedSources(productId, normalizedIssueKey, vault, signal);
      })().finally(() => {
        if (activeEnrichments.get(key) === enrichment) activeEnrichments.delete(key);
        if (
          activeProductRemoteOperations.get(productId)?.kind === "enrichment"
          && activeProductRemoteOperations.get(productId)?.issueKey === normalizedIssueKey
        ) {
          activeProductRemoteOperations.delete(productId);
        }
      });
      activeEnrichments.set(key, enrichment);
      activeProductRemoteOperations.set(productId, {
        kind: "enrichment",
        issueKey: normalizedIssueKey
      });
      return enrichment;
    },

    registerTicketContextCoordinator(coordinator) {
      if (
        coordinator !== null
        && (
          typeof coordinator?.beginFullSync !== "function"
          || typeof coordinator?.endFullSync !== "function"
        )
      ) {
        throw new TypeError("ticket context coordinator is invalid");
      }
      ticketContextCoordinator = coordinator;
    },

    async listGitHubRepositories({ productId }) {
      const record = await getRecord(productId, "github");
      if (!record) return [];
      return ensureGitHubRepositories(productId, record);
    },

    async getGitHubRepository({ productId, repositoryId }) {
      return getRepository(productId, repositoryId);
    },

    async createGitHubRepository({ productId, repository }) {
      if (hasActiveGitHubSync(productId)) {
        throw new ApiError(
          409,
          "repository_sync_in_progress",
          "Repositories cannot be created while GitHub is synchronizing."
        );
      }
      return runExclusive(productId, "github.repositories", async () => {
        if (hasActiveGitHubSync(productId)) {
          throw new ApiError(
            409,
            "repository_sync_in_progress",
            "Repositories cannot be created while GitHub is synchronizing."
          );
        }
        const record = await getRecord(productId, "github");
        if (!record?.hasCredential) {
          throw new ApiError(409, "source_not_connected", "GitHub is not connected.");
        }
        await ensureGitHubRepositories(productId, record);
        if (repository.url) {
          assertRepositoryUrl(repository.url, repository.repository, record.config);
        }
        const store = await getRepositoryStore(productId);
        const created = await store.transact((snapshot) => {
          if (snapshot.repositories.length >= MAX_GITHUB_REPOSITORIES) {
            throw new ApiError(
              400,
              "repository_limit_exceeded",
              `At most ${MAX_GITHUB_REPOSITORIES} GitHub repository targets are allowed.`
            );
          }
          const normalized = normalizeRepository(repository.repository);
          if (
            snapshot.repositories.some(
              (target) => target.repository.toLowerCase() === normalized.toLowerCase()
            )
          ) {
            throw new ApiError(
              409,
              "repository_already_exists",
              "That GitHub repository target already exists."
            );
          }
          const id = repository.id ?? repositoryIdFor(normalized);
          if (snapshot.repositories.some((target) => target.id === id)) {
            throw new ApiError(
              409,
              "repository_id_already_exists",
              "That GitHub repository target ID already exists."
            );
          }
          const target = createRepositoryTarget({
            ...repository,
            id,
            repository: normalized,
            url: repository.url ?? repositoryUrl(
              record.config.webBaseUrl ?? "https://github.com",
              normalized
            ),
            now: now()
          });
          snapshot.repositories.push(target);
          assertRepositorySnapshot(snapshot.repositories);
          return target;
        });
        await persistRepositoryAllowlist(productId);
        return created;
      });
    },

    async updateGitHubRepository({ productId, repositoryId, changes }) {
      if (hasActiveGitHubSync(productId)) {
        throw new ApiError(
          409,
          "repository_sync_in_progress",
          "Repositories cannot be updated while GitHub is synchronizing."
        );
      }
      return runExclusive(productId, "github.repositories", async () => {
        if (hasActiveGitHubSync(productId)) {
          throw new ApiError(
            409,
            "repository_sync_in_progress",
            "Repositories cannot be updated while GitHub is synchronizing."
          );
        }
        const record = await getRecord(productId, "github");
        if (!record) {
          throw new ApiError(409, "source_not_connected", "GitHub is not connected.");
        }
        await ensureGitHubRepositories(productId, record);
        if (activeRepositorySyncs.has(repositoryOperationKey(productId, repositoryId))) {
          throw new ApiError(
            409,
            "repository_sync_in_progress",
            "The repository cannot be updated while it is synchronizing."
          );
        }
        const currentTarget = await getRepository(productId, repositoryId);
        const repositoryChanged = changes.repository !== undefined
          && normalizeRepository(changes.repository) !== currentTarget.repository;
        if (
          repositoryChanged
          && typeof syncSource.clearGitHubRepositoryCheckpoint === "function"
        ) {
          await syncSource.clearGitHubRepositoryCheckpoint({ productId, repositoryId });
        }
        const updated = await updateRepository(productId, repositoryId, (target, snapshot) => {
          const previousRepository = target.repository;
          const nextRepository = changes.repository
            ? normalizeRepository(changes.repository)
            : target.repository;
          const nextUrl = changes.url ?? (
            changes.repository
              ? repositoryUrl(record.config.webBaseUrl ?? "https://github.com", nextRepository)
              : target.url
          );
          assertRepositoryUrl(nextUrl, nextRepository, record.config);
          if (
            snapshot.repositories.some(
              (candidate) =>
                candidate.id !== target.id
                && candidate.repository.toLowerCase() === nextRepository.toLowerCase()
            )
          ) {
            throw new ApiError(
              409,
              "repository_already_exists",
              "That GitHub repository target already exists."
            );
          }
          target.repository = nextRepository;
          target.url = nextUrl;
          if (changes.purpose !== undefined) target.purpose = changes.purpose;
          if (changes.lifecycle !== undefined) target.lifecycle = changes.lifecycle;
          if (changes.enabled !== undefined) target.enabled = changes.enabled;
          if (target.lifecycle === "archived") target.enabled = false;
          if (previousRepository !== nextRepository) {
            target.validationStatus = "pending";
            target.syncStatus = "idle";
            target.lastValidatedAt = null;
            target.lastSyncAt = null;
            target.lastSuccessfulSyncAt = null;
            target.recordsCollected = 0;
            target.error = null;
          }
        });
        await persistRepositoryAllowlist(productId);
        return updated;
      });
    },

    async deleteGitHubRepository({ productId, repositoryId }) {
      if (hasActiveGitHubSync(productId)) {
        throw new ApiError(
          409,
          "repository_sync_in_progress",
          "Repositories cannot be deleted while GitHub is synchronizing."
        );
      }
      return runExclusive(productId, "github.repositories", async () => {
        if (hasActiveGitHubSync(productId)) {
          throw new ApiError(
            409,
            "repository_sync_in_progress",
            "Repositories cannot be deleted while GitHub is synchronizing."
          );
        }
        const record = await getRecord(productId, "github");
        if (!record) {
          throw new ApiError(409, "source_not_connected", "GitHub is not connected.");
        }
        await ensureGitHubRepositories(productId, record);
        if (activeRepositorySyncs.has(repositoryOperationKey(productId, repositoryId))) {
          throw new ApiError(
            409,
            "repository_sync_in_progress",
            "The repository cannot be deleted while it is synchronizing."
          );
        }
        await getRepository(productId, repositoryId);
        if (typeof syncSource.clearGitHubRepositoryCheckpoint === "function") {
          await syncSource.clearGitHubRepositoryCheckpoint({ productId, repositoryId });
        }
        const store = await getRepositoryStore(productId);
        const deleted = await store.transact((snapshot) => {
          const index = snapshot.repositories.findIndex(
            (candidate) => candidate.id === repositoryId
          );
          if (index < 0) {
            throw new ApiError(
              404,
              "repository_not_found",
              "GitHub repository target was not found."
            );
          }
          return snapshot.repositories.splice(index, 1)[0];
        });
        await persistRepositoryAllowlist(productId);
        return deleted;
      });
    },

    async testGitHubRepository({ productId, repositoryId }) {
      return runExclusive(productId, `github.repository.${repositoryId}`, async () => {
        if (hasActiveGitHubSync(productId)) {
          throw new ApiError(
            409,
            "repository_sync_in_progress",
            "The repository cannot be tested while it is synchronizing."
          );
        }
        const vault = await getVault(productId);
        const record = vault.get(tenantId, productId, "github");
        const credential = await vault.resolveCredential(
          tenantId,
          productId,
          "github"
        );
        if (!record || !credential) {
          throw new ApiError(409, "source_not_connected", "GitHub is not connected.");
        }
        try {
          await validateGitHubRepositories({
            productId,
            record,
            config: record.config,
            credential,
            repositoryIds: [repositoryId]
          });
          await vault.updateStatus({
            tenantId,
            productId,
            source: "github",
            status: "connected",
            error: null,
            lastValidatedAt: now()
          });
          return getRepository(productId, repositoryId);
        } catch (error) {
          const safeError = sanitizeOperationError(error);
          if (
            error instanceof SourceConnectionValidationError
            && error.code === "source_authorization_failed"
          ) {
            await vault.updateStatus({
              tenantId,
              productId,
              source: "github",
              status: error.connectionStatus,
              error: safeError,
              lastValidatedAt: now()
            });
          }
          throw new ApiError(
            error instanceof SourceConnectionValidationError ? 422 : 502,
            safeError.code,
            safeError.message
          );
        }
      });
    },

    async syncGitHubRepository({ productId, repositoryId }) {
      const activeRemoteOperation = activeProductRemoteOperations.get(productId);
      if (activeRemoteOperation) {
        throw new ApiError(
          409,
          "product_sync_in_progress",
          "A product-wide remote source operation is already in progress."
        );
      }
      const key = `github.repository.sync.${repositoryId}`;
      if (operationTails.has(operationKey(productId, key))) {
        throw new ApiError(
          409,
          "sync_already_in_progress",
          "A synchronization is already in progress for this repository."
        );
      }
      return runExclusive(productId, key, () =>
        runGitHubRepositorySync({ productId, repositoryId })
      );
    },

    async cancelGitHubRepositorySync({ productId, repositoryId }) {
      const active = activeRepositorySyncs.get(
        repositoryOperationKey(productId, repositoryId)
      );
      if (!active) {
        throw new ApiError(
          409,
          "sync_not_in_progress",
          "No synchronization is in progress for this repository."
        );
      }
      if (!active.controller) {
        throw new ApiError(
          409,
          "aggregate_sync_in_progress",
          "Cancel the source-level GitHub synchronization to stop this repository."
        );
      }
      active.controller.abort();
      await active.settled;
      return getRepository(productId, repositoryId);
    },

    async cancelSync({ productId, source }) {
      sourceDefinition(source);
      const activeSync = activeProductSyncs.get(productId);
      if (!activeSync) {
        throw new ApiError(
          409,
          "sync_not_in_progress",
          "No synchronization is currently in progress for this product."
        );
      }
      if (activeSync.source !== source) {
        throw new ApiError(
          409,
          "sync_source_mismatch",
          `The active synchronization is for ${sourceDefinition(activeSync.source).displayName}.`
        );
      }
      activeSync.controller.abort();
      await activeSync.settled;
      const record = await getRecord(productId, source);
      const repositories = source === "github" && record
        ? await ensureGitHubRepositories(productId, record)
        : [];
      return toConnection(sourceDefinition(source), record, repositories);
    },

    async executeApprovedAction({ productId, actionType, target, changes, signal }) {
      if (typeof executeSourceAction !== "function") {
        throw new ApiError(
          409,
          "action_execution_not_configured",
          "External action execution is not configured.",
        );
      }
      const source = actionType.startsWith("testrail.") ? "testrail" : "github";
      const vault = await getVault(productId);
      const record = vault.get(tenantId, productId, source);
      if (!record?.hasCredential) {
        throw new ApiError(
          409,
          "source_not_connected",
          `${sourceDefinition(source).displayName} is not connected.`,
        );
      }
      return executeSourceAction({
        productId,
        actionType,
        target,
        changes,
        config: record.config,
        signal,
        resolveCredential: async () => {
          const credential = await vault.resolveCredential(tenantId, productId, source);
          if (!credential) throw new Error("Credential is no longer available");
          return credential;
        },
      });
    },

    async disconnect({ productId, source }) {
      if (source === "github" && hasActiveGitHubSync(productId)) {
        throw new ApiError(
          409,
          "repository_sync_in_progress",
          "GitHub cannot be disconnected while a repository sync is running."
        );
      }
      return runExclusive(productId, source, async () => {
        if (source === "github" && hasActiveGitHubSync(productId)) {
          throw new ApiError(
            409,
            "repository_sync_in_progress",
            "GitHub cannot be disconnected while a repository sync is running."
          );
        }
        const vault = await getVault(productId);
        const existing = await getRecord(productId, source);
        if (!existing) {
          return toConnection(sourceDefinition(source));
        }
        const updated = await vault.disconnect({ tenantId, productId, source });
        const repositories = source === "github"
          ? await ensureGitHubRepositories(productId, updated)
          : [];
        return toConnection(sourceDefinition(source), updated, repositories);
      });
    }
  });
}

function sourceDefinition(source) {
  const definition = SOURCES.find((candidate) => candidate.source === source);
  if (!definition) throw new ApiError(404, "not_found", "Source connection was not found.");
  return definition;
}

function toConnection(definition, record, repositories = []) {
  return {
    source: definition.source,
    displayName: definition.displayName,
    status: record?.status ?? "not-connected",
    ownerSubject: record?.ownerSubject ?? null,
    configured: record?.hasCredential ?? false,
    ingestionSupported: definition.ingestionSupported,
    config: record?.config ?? {},
    connectedAt: record?.connectedAt ?? null,
    lastValidatedAt: record?.lastValidatedAt ?? null,
    lastSyncAt: record?.lastSyncAt ?? null,
    lastSuccessfulSyncAt: record?.lastSuccessfulSyncAt ?? null,
    error: record?.error ?? null,
    ...(definition.source === "github"
      ? { repositories: repositories.map(toRepositoryResponse) }
      : {})
  };
}

function createRepositoryTarget({
  id,
  repository,
  url,
  purpose = "quality-evidence",
  lifecycle = "active",
  enabled = true
}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedId = id ?? repositoryIdFor(normalizedRepository);
  if (!GITHUB_REPOSITORY_ID_PATTERN.test(normalizedId)) {
    throw new ApiError(
      400,
      "invalid_repository_id",
      "repository id must use lower-case letters, numbers, underscores, or hyphens."
    );
  }
  if (!GITHUB_REPOSITORY_PURPOSES.has(purpose)) {
    throw new ApiError(400, "invalid_repository_purpose", "Repository purpose is invalid.");
  }
  if (!GITHUB_REPOSITORY_LIFECYCLES.has(lifecycle)) {
    throw new ApiError(400, "invalid_repository_lifecycle", "Repository lifecycle is invalid.");
  }
  if (typeof enabled !== "boolean") {
    throw new ApiError(400, "invalid_repository_enabled", "Repository enabled must be boolean.");
  }
  return {
    id: normalizedId,
    repository: normalizedRepository,
    url,
    purpose,
    lifecycle,
    enabled: lifecycle === "archived" ? false : enabled,
    validationStatus: "pending",
    syncStatus: "idle",
    lastValidatedAt: null,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    recordsCollected: 0,
    error: null
  };
}

function toRepositoryResponse(target) {
  return {
    id: target.id,
    repository: target.repository,
    url: target.url,
    purpose: target.purpose,
    lifecycle: target.lifecycle,
    enabled: target.enabled,
    validationStatus: target.validationStatus,
    syncStatus: target.syncStatus,
    lastValidatedAt: target.lastValidatedAt,
    lastSyncAt: target.lastSyncAt,
    lastSuccessfulSyncAt: target.lastSuccessfulSyncAt,
    recordsCollected: target.recordsCollected,
    error: target.error
  };
}

function normalizeLegacyRepositories(value) {
  const entries = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value
      : [];
  const repositories = [];
  const seen = new Set();
  for (const entry of entries) {
    const repository = normalizeRepository(entry);
    const key = repository.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repositories.push(repository);
  }
  if (repositories.length > MAX_GITHUB_REPOSITORIES) {
    throw new ApiError(
      400,
      "repository_limit_exceeded",
      `At most ${MAX_GITHUB_REPOSITORIES} GitHub repository targets are allowed.`
    );
  }
  return repositories;
}

function normalizeRepository(value) {
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_repository", "Repository must use owner/name syntax.");
  }
  const repository = value.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (
    !GITHUB_REPOSITORY_PATTERN.test(repository)
    || repository.split("/")[1] === "."
    || repository.split("/")[1] === ".."
  ) {
    throw new ApiError(400, "invalid_repository", "Repository must use owner/name syntax.");
  }
  return repository;
}

function repositoryIdFor(repository) {
  const slug = repository
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  const hash = createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 12);
  return `repo-${slug}-${hash}`;
}

function repositoryUrl(webBaseUrl, repository) {
  const base = new URL(webBaseUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${repository
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  base.search = "";
  base.hash = "";
  return base.toString().replace(/\/$/, "");
}

function assertRepositoryUrl(rawUrl, repository, config) {
  let url;
  let expectedBase;
  try {
    url = new URL(rawUrl);
    expectedBase = new URL(config.webBaseUrl ?? "https://github.com");
  } catch {
    throw new ApiError(400, "invalid_repository_url", "Repository URL is invalid.");
  }
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || url.origin.toLowerCase() !== expectedBase.origin.toLowerCase()
  ) {
    throw new ApiError(
      400,
      "repository_host_not_allowed",
      "Repository URL must use the configured GitHub web host without credentials, query, or fragment."
    );
  }
  const expected = repositoryUrl(expectedBase.toString(), repository);
  if (url.toString().replace(/\/$/, "") !== expected) {
    throw new ApiError(
      400,
      "invalid_repository_url",
      "Repository URL must identify the same owner/name repository."
    );
  }
}

function assertRepositorySnapshot(repositories) {
  if (!Array.isArray(repositories) || repositories.length > MAX_GITHUB_REPOSITORIES) {
    throw new ApiError(
      400,
      "repository_limit_exceeded",
      `At most ${MAX_GITHUB_REPOSITORIES} GitHub repository targets are allowed.`
    );
  }
  const ids = new Set();
  const names = new Set();
  for (const target of repositories) {
    if (!GITHUB_REPOSITORY_ID_PATTERN.test(target.id) || ids.has(target.id)) {
      throw new ApiError(409, "duplicate_repository_id", "Repository IDs must be unique.");
    }
    const normalized = normalizeRepository(target.repository).toLowerCase();
    if (names.has(normalized)) {
      throw new ApiError(
        409,
        "duplicate_repository",
        "Normalized GitHub repositories must be unique."
      );
    }
    if (!GITHUB_REPOSITORY_PURPOSES.has(target.purpose)) {
      throw new ApiError(400, "invalid_repository_purpose", "Repository purpose is invalid.");
    }
    if (!GITHUB_REPOSITORY_LIFECYCLES.has(target.lifecycle)) {
      throw new ApiError(400, "invalid_repository_lifecycle", "Repository lifecycle is invalid.");
    }
    ids.add(target.id);
    names.add(normalized);
  }
}

function repositoryOperationKey(productId, repositoryId) {
  return `${productId}:${repositoryId}`;
}

function sanitizeOperationError(error, sensitiveValues = []) {
  if (error instanceof SourceConnectionValidationError) {
    return {
      code: error.code,
      category: error.category,
      message: containsSensitiveValue(error.message, sensitiveValues)
        ? validationErrorMessage(error.code)
        : error.message
    };
  }

  if (error instanceof SourceSyncError) {
    if (error.code === "sync_cancelled") return cancelledSyncError();
    return {
      code: error.code,
      category: "provider",
      message: syncErrorMessage(error.code)
    };
  }

  return {
    code: "source_operation_failed",
    category: "internal",
    message: "The source connection operation failed."
  };
}

function containsSensitiveValue(message, values) {
  if (typeof message !== "string") return false;
  return values.some(
    (value) =>
      typeof value === "string"
      && value.length > 0
      && message.includes(value)
  );
}

function validationErrorMessage(code) {
  const messages = {
    source_authorization_failed: "The source rejected the supplied credential.",
    github_repository_not_accessible:
      "GitHub could not access this repository. Verify repository access and organization approval.",
    invalid_repository: "GitHub repository must use owner/name syntax.",
    invalid_source_url: "The source URL is invalid.",
    source_unavailable: "The source could not be reached.",
    source_validation_failed: "The source validation request failed."
  };
  return messages[code] ?? "The source connection validation failed.";
}

function syncErrorMessage(code) {
  const messages = {
    ingestion_not_supported: "Knowledge ingestion is not supported for this source.",
    invalid_repository_id: "The GitHub repository target ID is invalid.",
    invalid_source_configuration: "The source synchronization configuration is invalid.",
    source_host_not_allowed: "The source host is not approved for this deployment.",
    source_sync_failed: "The source synchronization did not complete successfully."
  };
  return messages[code] ?? "The source synchronization failed.";
}

function cancelledSyncError() {
  return {
    code: "sync_cancelled",
    category: "internal",
    message: "The synchronization was cancelled."
  };
}
