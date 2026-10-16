import type {
  PluginFactoryContext,
  PluginRegistration,
} from "@tkl/contracts";

export class PluginRegistry {
  constructor(options?: { contractVersion?: string });
  readonly contractVersion: string;
  register<TPlugin, TContext extends PluginFactoryContext>(
    registration: PluginRegistration<TPlugin, TContext>,
  ): PluginRegistration<TPlugin, TContext>;
  get(id: string): PluginRegistration | undefined;
  create<TPlugin = unknown>(id: string, context: PluginFactoryContext): TPlugin;
  list(): PluginRegistration[];
}

export function isCompatibleContractVersion(
  pluginVersion: string,
  platformVersion?: string,
): boolean;
