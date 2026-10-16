import { assertPluginManifest, CONTRACT_VERSION } from "@tkl/contracts";

export class PluginRegistry {
  constructor({ contractVersion = CONTRACT_VERSION } = {}) {
    const configuredFamily = contractFamily(contractVersion);
    if (configuredFamily === null) {
      throw new TypeError(`Platform contract version "${contractVersion}" is invalid`);
    }
    if (configuredFamily !== contractFamily(CONTRACT_VERSION)) {
      throw new TypeError(`Platform contract version "${contractVersion}" is not supported`);
    }
    this.contractVersion = contractVersion;
    this.plugins = new Map();
  }

  register(registration) {
    const manifest = assertPluginManifest(registration?.manifest);
    if (typeof registration.create !== "function") {
      throw new TypeError(`Plugin "${manifest.id}" must provide a create factory`);
    }
    if (!isCompatibleContractVersion(manifest.contractVersion, this.contractVersion)) {
      throw new TypeError(
        `Plugin "${manifest.id}" contract ${manifest.contractVersion} is incompatible with ${this.contractVersion}`,
      );
    }
    if (this.plugins.has(manifest.id)) {
      throw new TypeError(`Plugin "${manifest.id}" cannot be registered`);
    }
    const descriptor = Object.freeze({ manifest, create: registration.create });
    this.plugins.set(manifest.id, descriptor);
    return descriptor;
  }

  get(id) {
    return this.plugins.get(id);
  }

  create(id, context) {
    const registration = this.get(id);
    if (!registration) throw new TypeError(`Plugin "${id}" is not registered`);
    return registration.create(context);
  }

  list() {
    return [...this.plugins.values()];
  }
}

export function isCompatibleContractVersion(pluginVersion, platformVersion = CONTRACT_VERSION) {
  const pluginFamily = contractFamily(pluginVersion);
  const platformFamily = contractFamily(platformVersion);
  return pluginFamily !== null && platformFamily !== null && pluginFamily === platformFamily;
}

function contractFamily(version) {
  if (typeof version !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) return null;
  return version.split(".").slice(0, 2).join(".");
}
