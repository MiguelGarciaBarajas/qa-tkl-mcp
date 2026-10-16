import assert from "node:assert/strict";
import test from "node:test";
import { PluginRegistry } from "@tkl/plugin-registry";
import { composeConfiguredPlugins } from "../src/index.js";

test("composes enabled plugins from validated product configuration", () => {
  const registry = new PluginRegistry();
  registry.register({
    manifest: {
      id: "connector.jira",
      version: "0.1.0",
      contractVersion: "0.1.0",
      capabilities: ["fixture-read"],
      requiredPermissions: [],
    },
    create: (context) => ({ context }),
  });

  const platform = composeConfiguredPlugins({
    configuration: {
      configVersion: "0.1",
      tenantId: "tenant-test",
      productId: "fl-titling",
      enabledPlugins: ["connector.jira"],
      plannedPlugins: [],
      credentialRefs: {
        "connector.jira": "secret://jira/fl-titling",
      },
      sources: {
        jira: {
          enabled: true,
          configurationStatus: "ready",
        },
      },
    },
    registry,
    dependencies: {
      "connector.jira": { client: "fixture-client" },
    },
  });

  const plugin = platform.getPlugin("connector.jira");
  assert.equal(plugin.context.productId, "fl-titling");
  assert.equal(plugin.context.credentialRef, "secret://jira/fl-titling");
  assert.equal(plugin.context.dependencies.client, "fixture-client");
  assert.equal(platform.listPlugins().length, 1);
});

test("does not instantiate planned or disabled plugins", () => {
  const registry = new PluginRegistry();
  registry.register({
    manifest: {
      id: "connector.fixture",
      version: "0.1.0",
      contractVersion: "0.1.0",
      capabilities: [],
      requiredPermissions: [],
    },
    create: () => {
      throw new Error("planned plugin must not be created");
    },
  });

  const platform = composeConfiguredPlugins({
    configuration: {
      configVersion: "0.1",
      tenantId: "tenant-test",
      productId: "fl-titling",
      enabledPlugins: [],
      plannedPlugins: ["connector.fixture"],
      credentialRefs: {
        "connector.fixture": "secret://fixture/fl-titling",
      },
      sources: {},
    },
    registry,
  });

  assert.deepEqual(platform.listPlugins(), []);
});
