import test from "node:test";
import assert from "node:assert/strict";
import { createSourceActionExecutor } from "../src/source-action-executor.js";

test("creates a TestRail case with the connected account and generated steps", async () => {
  const calls = [];
  const execute = createSourceActionExecutor({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async text() {
          return JSON.stringify({ id: 4455, title: "Verify valid VIN" });
        },
      };
    },
  });

  const result = await execute({
    actionType: "testrail.case.create",
    target: { sectionId: "1201" },
    changes: {
      title: "Verify valid VIN",
      refs: "STT-100",
      template_id: 2,
      custom_automation_status: 2,
      custom_preconds: "The title workflow is available.",
      custom_steps_separated: [{
        content: "Submit a valid VIN.",
        expected: "The application is accepted.",
      }],
    },
    config: {
      baseUrl: "https://testrail.example",
      username: "qa@example.com",
    },
    resolveCredential: async () => "api-key",
  });

  assert.deepEqual(result, {
    source: "testrail",
    externalId: "4455",
    url: "https://testrail.example/index.php?/cases/view/4455",
    title: "Verify valid VIN",
    section: {
      id: "1201",
      created: false,
      name: null,
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
  assert.ok(!calls[0].init.headers.Authorization.includes("api-key"));
  assert.equal(JSON.parse(calls[0].init.body).template_id, 2);
  assert.equal(JSON.parse(calls[0].init.body).custom_automation_status, 2);
  assert.deepEqual(JSON.parse(calls[0].init.body).custom_steps_separated, [{
    content: "Submit a valid VIN.",
    expected: "The application is accepted.",
  }]);
});

test("reports TestRail field validation failures without a misleading section warning", async () => {
  const execute = createSourceActionExecutor({
    fetch: async () => ({
      ok: false,
      status: 400,
      headers: { get() { return null; } },
      async text() {
        return JSON.stringify({ error: "Field custom_automation_status is required." });
      },
    }),
  });

  await assert.rejects(
    execute({
      actionType: "testrail.case.create",
      target: { sectionId: "1201" },
      changes: { title: "Verify valid VIN" },
      config: {
        baseUrl: "https://testrail.example",
        username: "qa@example.com",
      },
      resolveCredential: async () => "api-key",
    }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, "source_field_validation_failed");
      assert.match(error.message, /required custom fields and case template/i);
      assert.doesNotMatch(error.message, /new section/i);
      return true;
    },
  );
});

test("creates a TestRail section before creating the case when requested", async () => {
  const calls = [];
  const execute = createSourceActionExecutor({
    fetch: async (url, init) => {
      calls.push({ url, init });
      const body = calls.length === 1
        ? { id: 3301, name: "Automation candidates" }
        : { id: 4455, title: "Verify valid VIN" };
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async text() {
          return JSON.stringify(body);
        },
      };
    },
  });

  const result = await execute({
    actionType: "testrail.case.create",
    target: { suiteId: "128951", newSectionName: "Automation candidates" },
    changes: { title: "Verify valid VIN" },
    config: {
      baseUrl: "https://testrail.example",
      username: "qa@example.com",
      projectId: "128",
    },
    resolveCredential: async () => "api-key",
  });

  assert.equal(calls[0].url, "https://testrail.example/index.php?/api/v2/add_section/128");
  assert.equal(calls[1].url, "https://testrail.example/index.php?/api/v2/add_case/3301");
  assert.deepEqual(result.section, {
    id: "3301",
    created: true,
    name: "Automation candidates",
  });
});

test("reports a recoverable partial write when section creation succeeds but case creation fails", async () => {
  let requestCount = 0;
  const execute = createSourceActionExecutor({
    fetch: async () => {
      requestCount += 1;
      return requestCount === 1
        ? {
            ok: true,
            status: 200,
            headers: { get() { return null; } },
            async text() {
              return JSON.stringify({ id: 3301, name: "Automation candidates" });
            },
          }
        : {
            ok: false,
            status: 500,
            headers: { get() { return null; } },
            async text() {
              return JSON.stringify({ error: "synthetic failure" });
            },
          };
    },
  });

  await assert.rejects(
    execute({
      actionType: "testrail.case.create",
      target: { suiteId: "128951", newSectionName: "Automation candidates" },
      changes: { title: "Verify valid VIN" },
      config: {
        baseUrl: "https://testrail.example",
        username: "qa@example.com",
        projectId: "128",
      },
      resolveCredential: async () => "api-key",
    }),
    (error) => {
      assert.equal(error.code, "partial_source_write");
      assert.equal(error.details.sectionId, "3301");
      return true;
    },
  );
});
