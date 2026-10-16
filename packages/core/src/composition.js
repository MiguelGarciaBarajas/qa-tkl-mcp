import { assertProductConfiguration } from "@tkl/contracts";

export function composeConfiguredPlugins({
  configuration,
  registry,
  dependencies = {},
}) {
  const product = assertProductConfiguration(configuration);
  if (!registry || typeof registry.create !== "function") {
    throw new TypeError("A plugin registry with a create method is required");
  }

  const instances = new Map();
  for (const pluginId of product.enabledPlugins) {
    const sourceId = pluginId.startsWith("connector.") ? pluginId.slice("connector.".length) : null;
    const instance = registry.create(pluginId, {
      tenantId: product.tenantId,
      productId: product.productId,
      credentialRef: product.credentialRefs[pluginId],
      configuration: sourceId ? (product.sources[sourceId] ?? {}) : {},
      dependencies: dependencies[pluginId] ?? {},
    });
    instances.set(pluginId, instance);
  }

  return Object.freeze({
    configuration: product,
    getPlugin(pluginId) {
      return instances.get(pluginId);
    },
    listPlugins() {
      return [...instances.entries()].map(([pluginId, instance]) => ({ pluginId, instance }));
    },
  });
}
