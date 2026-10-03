/// <reference path="./ui.d.ts" />
declare module "@taskasaur/plugin-host" {
  import type {
    Principal,
    ResourceRecord,
  } from "@taskasaur/platform/plugin-sdk";
  import type { PluginState } from "@taskasaur/platform/core/registry";
  import type { Value } from "@taskasaur/platform/field-types";
  import type { NavigationService } from "@taskasaur/platform/plugin-sdk/navigation";
  export interface UIService extends NavigationService {
    registerSurface(surface: {
      id: string;
      label: string;
      main?: boolean;
      icon?: string;
      render: import("react").ComponentType;
    }): () => void;
  }
  export interface CollectionStore {
    list(query?: unknown): Promise<ResourceRecord[]>;
    get(id: string): Promise<ResourceRecord | undefined>;
    put(data: Record<string, Value>, id?: string): Promise<ResourceRecord>;
    delete(id: string): Promise<unknown>;
  }
  export interface AppRuntime {
    readonly profile: {
      id: string;
      userId: string;
      workspaceId: string;
      name: string;
      serverUrl: string;
      connected: boolean;
    };
    readonly principal: Principal;
    readonly registry: {
      enabled(id: string): boolean;
      states: Map<string, PluginState>;
    };
    collection(id: string): CollectionStore;
    api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T>;
    synchronize(): Promise<void>;
    fileBytes(
      id: string,
    ): Promise<{
      id: string;
      fileId: string;
      parentVersionId: string | null;
      blob: Blob;
      createdAt: string;
      synced: boolean;
    }>;
    db: {
      records: {
        get(id: string): Promise<ResourceRecord | undefined>;
        put(record: ResourceRecord): Promise<string>;
        filter(predicate: (record: ResourceRecord) => boolean): {
          toArray(): Promise<ResourceRecord[]>;
        };
      };
      saveFile(
        principal: Principal,
        id: string,
        blob: Blob,
        parent: string | null,
      ): Promise<string>;
    };
  }
}
declare module "@taskasaur/server-host" {
  export type MutationHook =
    import("../host-types/server/plugin-runtime").MutationHook;
  export type Repository = import("../host-types/server/repository").Repository;
  export const Repository: typeof import("../host-types/server/repository").Repository;
  export type CredentialBroker =
    import("../host-types/server/credentials").CredentialBroker;
  export const CredentialBroker: typeof import("../host-types/server/credentials").CredentialBroker;
  export type FileService = import("../host-types/server/files").FileService;
  export const FileService: typeof import("../host-types/server/files").FileService;
  export type DeviceService =
    import("../host-types/server/devices").DeviceService;
  export const DeviceService: typeof import("../host-types/server/devices").DeviceService;
  export type JobService = import("../host-types/server/jobs").JobService;
  export const JobService: typeof import("../host-types/server/jobs").JobService;
  export const routerFor: typeof import("../host-types/server/api").routerFor;
  export const operationUuid: typeof import("../host-types/server/runner-dispatch").operationUuid;
  export type Dispatch =
    import("../host-types/server/runner-dispatch").Dispatch;
  export const pendingSignals: typeof import("../host-types/server/device-signals").pendingSignals;
  export const acknowledgeSignal: typeof import("../host-types/server/device-signals").acknowledgeSignal;
  export type WorkflowSignal =
    import("../host-types/server/device-signals").WorkflowSignal;
}
