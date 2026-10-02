import type { PluginManifest, PluginModule, CoreContext } from "../plugin-sdk";
import { manifestSchema } from "../plugin-sdk";
import {
  catalog,
  coreServices,
  isRequiredCore,
  requiredCoreIds,
} from "./catalog";
import { invariant } from "./errors";
import { verifyCoreRelease } from "./release";
export interface PluginState {
  id: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  features: string[];
  error?: string;
}
export interface RegistryPersistence {
  load(): Promise<PluginState[]>;
  save(state: PluginState): Promise<void>;
}
export class PluginRegistry {
  readonly manifests = new Map(catalog.map((m) => [m.id, m]));
  readonly states = new Map<string, PluginState>();
  private cleanups = new Map<string, () => void | Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private modules = new Map<string, PluginModule>();
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private persistence: RegistryPersistence) {}
  async initialize() {
    verifyCoreRelease();
    for (const state of await this.persistence.load())
      this.states.set(state.id, state);
    for (const id of requiredCoreIds) {
      const manifest = this.manifests.get(id)!;
      const state = {
        id,
        version: manifest.version,
        installed: true,
        enabled: true,
        features: [],
      };
      const existing = this.states.get(id);
      this.states.set(id, state);
      if (
        !existing ||
        !existing.installed ||
        !existing.enabled ||
        existing.version !== state.version
      )
        await this.persistence.save(state);
    }
  }
  list() {
    return [...this.manifests.values()].map((manifest) => ({
      manifest,
      required: isRequiredCore(manifest.id),
      state: this.states.get(manifest.id) ?? {
        id: manifest.id,
        version: manifest.version,
        installed: false,
        enabled: false,
        features: [],
      },
    }));
  }
  enabled(id: string) {
    return this.states.get(id)?.enabled === true;
  }
  private lock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action);
    this.serial = result.catch(() => undefined);
    return result;
  }
  async install(id: string) {
    return this.lock(async () => {
      const manifest = this.manifests.get(id);
      invariant(manifest, "PLUGIN_NOT_FOUND", "Plugin is not in the catalog");
      for (const dependency of manifest.dependencies)
        invariant(
          this.states.get(dependency)?.installed,
          "DEPENDENCY_MISSING",
          `Install ${dependency} first`,
        );
      const old = this.states.get(id);
      const state = {
        id,
        version: manifest.version,
        installed: true,
        enabled: isRequiredCore(id) || old?.enabled === true,
        features: old?.features ?? [],
      };
      await this.persistence.save(state);
      this.states.set(id, state);
      return state;
    });
  }
  async enable(id: string) {
    return this.lock(async () => {
      const state = this.states.get(id);
      invariant(
        state?.installed,
        "PLUGIN_NOT_INSTALLED",
        "Install the plugin before enabling it",
      );
      for (const dependency of this.manifests.get(id)!.dependencies)
        invariant(
          this.enabled(dependency),
          "DEPENDENCY_MISSING",
          `Enable ${dependency} first`,
        );
      const next = { ...state, enabled: true };
      await this.persistence.save(next);
      this.states.set(id, next);
      return next;
    });
  }
  async configure(id: string, features: string[]) {
    return this.lock(async () => {
      const state = this.states.get(id),
        manifest = this.manifests.get(id);
      invariant(
        state?.installed && manifest,
        "PLUGIN_NOT_INSTALLED",
        "Install this plugin first",
      );
      invariant(
        new Set(features).size === features.length &&
          features.every((name) => Object.hasOwn(manifest.features, name)),
        "VALIDATION_FAILED",
        "Unknown or duplicate feature",
      );
      await this.deactivate(id);
      const next = { ...state, features };
      await this.persistence.save(next);
      this.states.set(id, next);
      return next;
    });
  }
  async disable(id: string) {
    return this.lock(async () => {
      invariant(
        !isRequiredCore(id),
        "CORE_PLUGIN_REQUIRED",
        `${id} is required by the platform`,
      );
      for (const other of this.manifests.values())
        invariant(
          !(this.enabled(other.id) && other.dependencies.includes(id)),
          "DEPENDENCY_IN_USE",
          `${other.name} requires this plugin`,
        );
      const state = this.states.get(id);
      invariant(state, "PLUGIN_NOT_INSTALLED", "Plugin is not installed");
      await this.deactivate(id);
      const next = { ...state, enabled: false };
      await this.persistence.save(next);
      this.states.set(id, next);
      return next;
    });
  }
  async uninstall(id: string) {
    invariant(
      !isRequiredCore(id),
      "CORE_PLUGIN_REQUIRED",
      `${id} is required by the platform`,
    );
    return this.lock(async () => {
      for (const other of this.manifests.values())
        invariant(
          !(
            this.states.get(other.id)?.installed &&
            other.dependencies.includes(id)
          ),
          "DEPENDENCY_IN_USE",
          `${other.name} still depends on this plugin`,
        );
      const state = this.states.get(id);
      invariant(
        state?.installed,
        "PLUGIN_NOT_INSTALLED",
        "Plugin is not installed",
      );
      await this.deactivate(id);
      const next = { ...state, enabled: false, installed: false };
      await this.persistence.save(next);
      this.states.set(id, next);
      return next;
    });
  }
  addVerifiedModule(module: PluginModule) {
    const manifest = manifestSchema.parse(module.manifest);
    invariant(
      !isRequiredCore(manifest.id),
      "RESERVED_PROVIDER",
      "Required core providers can only be updated by a platform release",
    );
    for (const command of manifest.provides.commands)
      invariant(
        !command.startsWith("core."),
        "RESERVED_PROVIDER",
        "Core command namespace is reserved",
      );
    this.manifests.set(manifest.id, manifest);
    this.modules.set(manifest.id, module);
  }
  async activate(id: string, context: Omit<CoreContext, "signal">) {
    invariant(this.enabled(id), "FEATURE_DISABLED", "Plugin is disabled");
    const module = this.modules.get(id);
    if (!module || this.controllers.has(id)) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      const cleanup = await module.activate({
        ...context,
        signal: controller.signal,
      });
      if (cleanup) this.cleanups.set(id, cleanup);
    } catch (error) {
      controller.abort();
      this.controllers.delete(id);
      throw error;
    }
  }
  async deactivate(id: string) {
    this.controllers.get(id)?.abort();
    await this.cleanups.get(id)?.();
    this.controllers.delete(id);
    this.cleanups.delete(id);
  }
  resolveServices<T>(
    manifest: PluginManifest,
    providers: Map<string, T>,
    granted: Set<string>,
    features: string[] = [],
  ) {
    const resolve = (id: string, required: boolean) => {
      const declared = manifest.sharedServices.find(
        (s) => s.id === id && (!s.when || features.includes(s.when)),
      );
      invariant(
        declared,
        "UNDECLARED_CAPABILITY",
        `${manifest.id} did not declare ${id}`,
      );
      invariant(granted.has(id), "PERMISSION_DENIED", `No grant for ${id}`);
      const provider = providers.get(id);
      const owner = Object.entries(coreServices).find(([, ids]) =>
        ids.includes(id),
      )?.[0];
      if (required || !declared.optional)
        invariant(
          provider,
          "CORE_DEPENDENCY_UNAVAILABLE",
          `Provider ${owner ?? id} is unavailable`,
        );
      return provider;
    };
    return {
      require: (id: string) => resolve(id, true)!,
      optional: (id: string) => resolve(id, false),
    };
  }
}
