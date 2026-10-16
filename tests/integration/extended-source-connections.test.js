import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createKnowledgeService,
  createPersistentKnowledgeStoreFactory
} from "../../apps/api/src/knowledge-service.js";
import { createSourceSyncRunner } from "../../apps/api/src/source-sync.js";

const RAW_KEY = Buffer.alloc(32, 41).toString("base64");

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

test("Confluence and ReportPortal sync into durable canonical knowledge", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "tkl-extended-sources-"));
  let knowledgeService;
  let restarted;
  try {
    const storeFactory = createPersistentKnowledgeStoreFactory({
      dataDirectory: join(dataDirectory, "knowledge")
    });
    knowledgeService = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory
    });
    const syncSource = createSourceSyncRunner({
      tenantId: "solera",
      knowledgeService,
      dataDirectory: join(dataDirectory, "raw"),
      resolveRawEvidenceKey: () => RAW_KEY,
      allowedHosts: ["confluence.example", "reportportal.example"],
      fetchImpl: async (url) => {
        const value = String(url);
        if (value.includes("confluence.example")) {
          return jsonResponse({
            results: [{
              id: "111",
              title: "Vehicle title business rules",
              space: { key: "QA" },
              version: { number: 3, when: "2026-09-12T12:00:00.000Z" },
              body: {
                storage: {
                  value: "<p>Titles require an approved owner.</p>",
                  representation: "storage"
                }
              },
              metadata: { labels: { results: [{ name: "requirement" }] } }
            }]
          });
        }
        if (value.includes("/testItem")) {
          return jsonResponse({
            content: [{
              id: 601,
              launchId: 501,
              name: "Title submission regression",
              status: "FAILED",
              startTime: 1789236000000,
              endTime: 1789236060000,
              codeRef: "tests/title-submission.spec.ts",
              issue: {
                issueType: "PRODUCT_BUG",
                externalSystemIssues: [{ ticketId: "BUG-9001" }]
              }
            }],
            page: { number: 0, totalPages: 1 }
          });
        }
        return jsonResponse({
          content: [{
            id: 501,
            name: "FL Titling regression",
            status: "FAILED",
            startTime: 1789235900000,
            endTime: 1789236100000
          }],
          page: { number: 0, totalPages: 1 }
        });
      }
    });

    await syncSource({
      productId: "fl-titling",
      source: "confluence",
      config: {
        baseUrl: "https://confluence.example/wiki",
        username: "qa@example.com",
        spaceKeys: ["QA"]
      },
      resolveCredential: async () => "test-token"
    });
    await syncSource({
      productId: "fl-titling",
      source: "reportportal",
      config: {
        baseUrl: "https://reportportal.example",
        project: "fl_titling"
      },
      resolveCredential: async () => "test-token"
    });

    restarted = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory
    });
    const requirements = await restarted.search({
      productId: "fl-titling",
      source: "confluence",
      query: "Vehicle title",
      limit: 20,
      offset: 0
    });
    const executions = await restarted.search({
      productId: "fl-titling",
      source: "reportportal",
      query: "Title submission",
      limit: 20,
      offset: 0
    });
    const defects = await restarted.search({
      productId: "fl-titling",
      source: "reportportal",
      query: "BUG-9001",
      limit: 20,
      offset: 0
    });

    assert.equal(requirements.items[0]?.type, "requirement");
    assert.equal(executions.items[0]?.type, "test-execution");
    assert.equal(defects.items[0]?.type, "defect");
  } finally {
    knowledgeService?.close();
    restarted?.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
