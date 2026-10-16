import assert from "node:assert/strict";
import test from "node:test";
import { PluginRegistry, isCompatibleContractVersion } from "../src/index.js";

const manifest = {
  id: "connector.fixture",
  version: "0.1.0",
  contractVersion: "0.1.0",
  capabilities: ["fixture-read"],
  requiredPermissions: [],
};

test("registers compatible plugin factories and creates isolated instances", () => {
  const registry = new PluginRegistry();
  registry.register({
    manifest,
    create: (context) => ({ pluginId: manifest.id, context }),
  });

  const context = {
    tenantId: "tenant-test",
    productId: "fl-titling",
    configuration: {},
    dependencies: {},
  };
  assert.deepEqual(registry.create(manifest.id, context), {
    pluginId: manifest.id,
    context,
  });
});

test("rejects duplicate and incompatible registrations", () => {
  const registry = new PluginRegistry();
  registry.register({ manifest, create: () => ({}) });
  assert.throws(
    () => registry.register({ manifest, create: () => ({}) }),
    /cannot be registered/,
  );
  assert.throws(
    () => registry.register({
      manifest: { ...manifest, id: "connector.future", contractVersion: "0.2.0" },
      create: () => ({}),
    }),
    /incompatible/,
  );
  assert.equal(isCompatibleContractVersion("0.1.7", "0.1"), true);
  assert.equal(isCompatibleContractVersion("bogus", "garbage"), false);
  assert.throws(
    () => new PluginRegistry({ contractVersion: "garbage" }),
    /Platform contract version "garbage" is invalid/,
  );
  assert.throws(
    () => new PluginRegistry({ contractVersion: "0.2" }),
    /Platform contract version "0.2" is not supported/,
  );
});
