import type { PluginFactoryContext } from "@tkl/contracts";
import { PluginRegistry } from "../src/index.js";

interface FixturePlugin {
  productId: string;
}

const registry = new PluginRegistry();
registry.register<FixturePlugin, PluginFactoryContext>({
  manifest: {
    id: "connector.fixture",
    version: "0.1.0",
    contractVersion: "0.1.0",
    capabilities: [],
    requiredPermissions: [],
  },
  create: ({ productId }) => ({ productId }),
});

const plugin = registry.create<FixturePlugin>("connector.fixture", {
  tenantId: "tenant-test",
  productId: "fl-titling",
  configuration: {},
  dependencies: {},
});

void plugin.productId;
