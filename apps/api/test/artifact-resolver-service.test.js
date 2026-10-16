import test from "node:test";
import assert from "node:assert/strict";
import {
  createArtifactResolverService,
  detectArtifactQuery,
} from "../src/artifact-resolver-service.js";

test("detects exact Jira, TestRail, ReportPortal, and text queries", () => {
  assert.deepEqual(detectArtifactQuery("stt-3731"), {
    kind: "jira-key",
    source: "jira",
    lookupValue: "STT-3731",
    exact: true,
  });
  assert.equal(detectArtifactQuery("C001201").lookupValue, "1201");
  assert.equal(detectArtifactQuery("1201").kind, "testrail-case-id");
  assert.deepEqual(detectArtifactQuery("rp: suite/test"), {
    kind: "reportportal-identity",
    source: "reportportal",
    lookupValue: "suite/test",
    exact: true,
  });
  assert.equal(detectArtifactQuery("verify title submission").kind, "text");
});

test("resolves one exact local TestRail case", async () => {
  const received = [];
  const resolver = createArtifactResolverService({
    knowledgeService: {
      async search(request) {
        received.push(request);
        return {
          items: [{
            id: "manual-test:testrail:1201",
            type: "manual-test",
            title: "Verify title submission",
            provenance: [{
              source: "testrail",
              sourceId: "1201",
              observedAt: "2026-09-15T12:00:00.000Z",
            }],
          }],
        };
      },
    },
  });

  const result = await resolver.resolve({
    productId: "fl-titling",
    query: "C1201",
    limit: 8,
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.selected.ref.externalId, "1201");
  assert.equal(result.selected.ref.type, "test-case");
  assert.equal(result.selected.match, "exact-id");
  assert.deepEqual(received, [{
    productId: "fl-titling",
    source: "testrail",
    query: "1201",
    limit: 8,
    offset: 0,
  }]);
});

test("hydrates an exact Jira key before searching local knowledge", async () => {
  const calls = [];
  const resolver = createArtifactResolverService({
    knowledgeService: {
      async getStoryTestContext(request) {
        calls.push(["hydrate", request]);
      },
      async search(request) {
        calls.push(["search", request]);
        return { items: [] };
      },
    },
  });

  await resolver.resolve({
    productId: "fl-titling",
    query: "STT-3731",
    limit: 8,
  });

  assert.deepEqual(calls[0], ["hydrate", {
    productId: "fl-titling",
    source: "jira",
    storyId: "STT-3731",
  }]);
  assert.equal(calls[1][0], "search");
});

test("resolves Jira entities whose canonical provenance is a single object", async () => {
  const resolver = createArtifactResolverService({
    knowledgeService: {
      async getStoryTestContext() {},
      async search() {
        return {
          items: [{
            id: "requirement:STT-3137",
            type: "requirement",
            title: "Add print and download PDF behavior",
            provenance: {
              source: "jira",
              sourceId: "STT-3137",
              observedAt: "2026-09-17T18:03:40.653Z",
            },
          }],
        };
      },
    },
  });

  const result = await resolver.resolve({
    productId: "fl-titling",
    query: "STT-3137",
    limit: 8,
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.selected.ref.source, "jira");
  assert.equal(result.selected.ref.externalId, "STT-3137");
});

test("requires explicit selection when text matches multiple candidates", async () => {
  const resolver = createArtifactResolverService({
    knowledgeService: {
      async search() {
        return {
          items: [
            {
              id: "manual-test:testrail:1",
              type: "manual-test",
              title: "Verify title submission",
              provenance: [{ source: "testrail", sourceId: "1" }],
            },
            {
              id: "test:github:2",
              type: "test",
              title: "Verify title submission error",
              provenance: [{ source: "github", sourceId: "2" }],
            },
          ],
        };
      },
    },
  });

  const result = await resolver.resolve({
    productId: "fl-titling",
    query: "title submission",
    limit: 8,
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.selected, null);
  assert.equal(result.candidates.length, 2);
});

test("retrieves an exact TestRail case on a local miss and searches again", async () => {
  let searches = 0;
  const hydrations = [];
  const resolver = createArtifactResolverService({
    knowledgeService: {
      async search() {
        searches += 1;
        return searches === 1
          ? { items: [] }
          : {
              items: [{
                id: "manual-test:testrail:1201",
                type: "manual-test",
                title: "Verify title",
                provenance: [{ source: "testrail", sourceId: "1201" }],
              }],
            };
      },
    },
    sourceConnectionService: {
      async hydrateTestRailCase(request) {
        hydrations.push(request);
      },
    },
  });

  const result = await resolver.resolve({
    productId: "fl-titling",
    query: "C1201",
    limit: 8,
  });

  assert.equal(result.status, "resolved");
  assert.equal(searches, 2);
  assert.deepEqual(hydrations, [{
    productId: "fl-titling",
    caseId: "1201",
  }]);
});

test("hydrates ReportPortal history and resolves the newest exact execution", async () => {
  let searches = 0;
  const hydrations = [];
  const resolver = createArtifactResolverService({
    knowledgeService: {
      async search() {
        throw new Error("generic search must not be used for ReportPortal identity");
      },
      async searchReportPortalExecutions({ identity }) {
        searches += 1;
        if (searches === 1) return { items: [] };
        return {
          items: [42, 41].map((id) => ({
            id: `test-execution:reportportal:item:${id}`,
            type: "test-execution",
            title: "login succeeds",
            matchedIdentity: identity,
            provenance: [{
              source: "reportportal",
              sourceId: String(id),
              observedAt: `2026-09-${id === 42 ? "15" : "14"}T00:00:00.000Z`,
            }],
          })),
        };
      },
    },
    sourceConnectionService: {
      async hydrateReportPortalTestHistory(request) {
        hydrations.push(request);
      },
    },
  });

  const result = await resolver.resolve({
    productId: "fl-titling",
    query: "rp:tests/login.spec.ts:test",
    limit: 8,
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.selected.ref.externalId, "42");
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates.every(({ match }) => match === "exact-id"), true);
  assert.deepEqual(hydrations, [{
    productId: "fl-titling",
    identity: "tests/login.spec.ts:test",
  }]);
});
