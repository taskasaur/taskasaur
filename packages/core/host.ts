import type {
  CoreContext,
  Principal,
  Runtime,
  PluginEvent,
  PluginModule,
  PluginManifest,
} from "../plugin-sdk";
import type { PluginRegistry } from "./registry";
import { MessageRouter, domainEvent } from "./messages";
import { invariant, CoreError } from "./errors";
import { validateRecord, type Value } from "../field-types";

export interface HostAdapters {
  services(principal: Principal): Map<string, unknown>;
  call(
    command: string,
    input: unknown,
    principal: Principal,
    options?: { mutationId?: string; targetDeviceId?: string },
  ): Promise<unknown>;
  publish(event: PluginEvent, principal: Principal): Promise<void>;
  cleanup?(pluginId: string): void;
  log?(
    pluginId: string,
    message: string,
    metadata?: Record<string, string | number | boolean>,
  ): void;
}
// Trusted plugin code shares a process. This broker enforces platform contracts;
// installing a publisher is a code-trust decision, not a JavaScript sandbox.
export class PluginHost {
  readonly router: MessageRouter;
  private subscriptions = new Map<
    string,
    Set<{ pluginId: string; handler: (event: PluginEvent) => Promise<void> }>
  >();
  private grants = new Map<string, Set<string>>();
  private active = new Set<string>();
  private activations = new Map<string, object>();
  private disposers = new Map<string, Set<() => void>>();
  readonly failures = new Map<string, string>();
  constructor(
    readonly registry: PluginRegistry,
    readonly principal: Principal,
    readonly runtime: Runtime,
    private adapters: HostAdapters,
    router?: MessageRouter,
  ) {
    this.router = router ?? new MessageRouter();
  }
  register(module: PluginModule, grants: string[]) {
    const id = module.manifest.id;
    this.registry.addVerifiedModule({
      ...module,
      activate: async (context) => {
        const activation = this.activations.get(id)!;
        this.active.add(id);
        const dispose = () => this.release(id, activation);
        context.signal.addEventListener("abort", dispose, { once: true });
        try {
          const cleanup = await module.activate(context);
          return async () => {
            try {
              await cleanup?.();
            } finally {
              dispose();
              context.signal.removeEventListener("abort", dispose);
            }
          };
        } catch (error) {
          dispose();
          throw error;
        }
      },
    });
    this.grants.set(module.manifest.id, new Set(grants));
  }
  private release(id: string, activation?: object) {
    if (activation && this.activations.get(id) !== activation) return;
    this.active.delete(id);
    this.activations.delete(id);
    const disposers = this.disposers.get(id);
    for (const dispose of disposers ?? []) dispose();
    disposers?.clear();
    this.disposers.delete(id);
    this.adapters.cleanup?.(id);
  }
  private track(id: string, dispose: () => void) {
    const set = this.disposers.get(id) ?? new Set<() => void>();
    set.add(dispose);
    this.disposers.set(id, set);
    return () => {
      if (set.delete(dispose)) dispose();
    };
  }
  unavailable(id: string, error: unknown) {
    this.release(id);
    const kind =
      error instanceof CoreError ? error.kind : "PLUGIN_ACTIVATION_FAILED";
    this.failures.set(id, kind);
    const state = this.registry.states.get(id);
    if (state) this.registry.states.set(id, { ...state, error: kind });
  }
  context(manifest: PluginManifest): Omit<CoreContext, "signal"> {
    const activation = {};
    this.activations.set(manifest.id, activation);
    const actor = {
        ...this.principal,
        pluginId: manifest.id,
        permissions: manifest.permissions,
      },
      granted = this.grants.get(manifest.id) ?? new Set<string>();
    const requireActive = () =>
      invariant(
        this.registry.enabled(manifest.id) &&
          this.active.has(manifest.id) &&
          this.activations.get(manifest.id) === activation,
        "FEATURE_DISABLED",
        "Plugin is disabled",
      );
    const resolver = this.registry.resolveServices(
      manifest,
      this.adapters.services(actor),
      granted,
      this.registry.states.get(manifest.id)?.features,
    );
    const scopedHandle = <T>(handle: T): T => {
      if (!handle || typeof handle !== "object") return handle;
      return new Proxy(handle as object, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            requireActive();
            const result = Reflect.apply(value, target, args);
            return key === "collection" ? scopedHandle(result) : result;
          };
        },
      }) as T;
    };
    return {
      principal: Object.freeze(actor),
      runtime: this.runtime,
      services: {
        require: <T>(id: string) => {
          requireActive();
          return scopedHandle(resolver.require(id)) as T;
        },
        optional: <T>(id: string) => {
          requireActive();
          return scopedHandle(resolver.optional(id)) as T | undefined;
        },
      },
      messages: {
        handle: (command, contract, execute) => {
          requireActive();
          invariant(
            manifest.provides.commands.includes(command),
            "UNDECLARED_COMMAND",
            "Command is not declared",
          );
          this.router.register(command, {
            permission: command,
            validate: (input) => validateRecord(contract, input),
            execute: async (input, ctx) => {
              requireActive();
              return execute(input as Record<string, Value>, ctx.signal);
            },
          });
          return this.track(manifest.id, () => this.router.unregister(command));
        },
        call: async <T>(
          command: string,
          input: unknown,
          options?: { mutationId?: string; targetDeviceId?: string },
        ) => {
          requireActive();
          invariant(
            manifest.consumes.commands.includes(command) ||
              manifest.provides.commands.includes(command),
            "UNDECLARED_COMMAND",
            "Declare consumed commands in the manifest",
          );
          invariant(
            granted.has(command) ||
              manifest.provides.commands.includes(command),
            "PERMISSION_DENIED",
            "Command grant is missing",
          );
          return (await this.adapters.call(
            command,
            input,
            actor,
            options,
          )) as T;
        },
        publish: async (event, resourceId, revision, value, operationId) => {
          requireActive();
          invariant(
            manifest.provides.events.includes(event),
            "UNDECLARED_EVENT",
            "Event is not declared",
          );
          const envelope = domainEvent(
            actor,
            event,
            resourceId,
            revision,
            value,
            operationId,
          ) as unknown as PluginEvent;
          await this.adapters.publish(envelope, actor);
        },
        subscribe: (event, handler) => {
          requireActive();
          invariant(
            manifest.consumes.events.includes(event),
            "UNDECLARED_EVENT",
            "Subscription is not declared",
          );
          invariant(
            granted.has(event),
            "PERMISSION_DENIED",
            "Event grant is missing",
          );
          const subscription = { pluginId: manifest.id, handler },
            set = this.subscriptions.get(event) ?? new Set();
          set.add(subscription);
          this.subscriptions.set(event, set);
          return this.track(manifest.id, () => {
            set.delete(subscription);
          });
        },
      },
      log: (message, metadata) =>
        this.adapters.log?.(manifest.id, message, metadata),
    };
  }
  async activate(id: string) {
    if (this.active.has(id)) return;
    const manifest = this.registry.manifests.get(id);
    invariant(manifest, "PLUGIN_NOT_FOUND", "Unknown plugin");
    try {
      await this.registry.activate(id, this.context(manifest));
      this.failures.delete(id);
      const state = this.registry.states.get(id);
      if (state) this.registry.states.set(id, { ...state, error: undefined });
    } catch (error) {
      this.unavailable(id, error);
      throw error;
    }
  }
  subscribers(event: PluginEvent) {
    const name = event.type.replace(/^taskasaur\./, "").replace(/\.v1$/, "");
    return [
      ...new Set(
        [...(this.subscriptions.get(name) ?? [])]
          .filter((s) => this.registry.enabled(s.pluginId))
          .map((s) => s.pluginId),
      ),
    ];
  }
  async deliver(event: PluginEvent, onlyPlugin?: string) {
    invariant(
      event.specversion === "1.0" &&
        event.data?.workspaceId === this.principal.workspaceId,
      "PERMISSION_DENIED",
      "Event scope mismatch",
    );
    const name = event.type.replace(/^taskasaur\./, "").replace(/\.v1$/, "");
    for (const subscriber of this.subscriptions.get(name) ?? [])
      if (
        this.registry.enabled(subscriber.pluginId) &&
        this.active.has(subscriber.pluginId) &&
        (!onlyPlugin || onlyPlugin === subscriber.pluginId)
      )
        await subscriber.handler(event);
  }
  async close() {
    const ids = [...this.active];
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await this.registry.deactivate(id);
        } finally {
          this.release(id);
        }
      }),
    );
    this.subscriptions.clear();
  }
}
