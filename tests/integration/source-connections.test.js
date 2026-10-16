import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeService, createPersistentKnowledgeStoreFactory } from "../../apps/api/src/knowledge-service.js";
import { createSourceConnectionService } from "../../apps/api/src/source-connection-service.js";
import { createSourceSyncRunner } from "../../apps/api/src/source-sync.js";
import { InMemoryCredentialVault } from "../../packages/credential-vault/src/index.js";

const RAW_KEY = Buffer.alloc(32, 29).toString("base64");

test("workspace connection flows through a real connector into durable canonical knowledge", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "tkl-source-connections-"));
  let knowledgeService;
  let restartedKnowledgeService;
  try {
    const knowledgeDirectory = join(dataDirectory, "knowledge");
    const rawDirectory = join(dataDirectory, "raw");
    const storeFactory = createPersistentKnowledgeStoreFactory({
      dataDirectory: knowledgeDirectory
    });
    knowledgeService = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory
    });
    const requestedUrls = [];
    const syncSource = createSourceSyncRunner({
      tenantId: "solera",
      knowledgeService,
      dataDirectory: rawDirectory,
      resolveRawEvidenceKey: () => RAW_KEY,
      allowedHosts: ["api.github.test"],
      fetchImpl: async (url) => {
        requestedUrls.push(String(url));
        const body = String(url).includes("/files")
          ? []
          : [{
              number: 42,
              title: "Automate title submission",
              body: "Covers STT-4242",
              state: "closed",
              updated_at: "2026-09-12T10:00:00.000Z",
              html_url: "https://github.example/pull/42"
            }];
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(body)
        };
      }
    });
    const vault = new InMemoryCredentialVault({
      tenantId: "solera",
      productId: "fl-titling"
    });
    const connections = createSourceConnectionService({
      tenantId: "solera",
      vaultFactory: () => vault,
      validateConnection: async () => ({
        validatedAt: "2026-09-12T10:00:00.000Z"
      }),
      syncSource
    });

    await connections.connect({
      productId: "fl-titling",
      source: "github",
      ownerSubject: "qa-lead",
      credential: "test-token",
      config: {
        apiUrl: "https://api.github.test",
        webBaseUrl: "https://api.github.test",
        repositories: ["Solera-Engineering/qa-tkl-mcp-f5"]
      }
    });
    const connection = await connections.sync({
      productId: "fl-titling",
      source: "github"
    });
    await syncSource.waitForProjection({ productId: "fl-titling" });

    assert.equal(connection.status, "connected");
    assert.ok(connection.lastSuccessfulSyncAt);
    assert.equal(requestedUrls.length, 2);

    restartedKnowledgeService = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory
    });
    const result = await restartedKnowledgeService.search({
      productId: "fl-titling",
      query: "Automate title submission",
      limit: 20,
      offset: 0
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, "Automate title submission");

    const serializedMetadata = JSON.stringify(
      await connections.list({ productId: "fl-titling" })
    );
    assert.equal(serializedMetadata.includes("synthetic-integration-token"), false);
  } finally {
    knowledgeService?.close();
    restartedKnowledgeService?.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
