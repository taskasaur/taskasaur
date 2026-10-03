import { z } from "zod";
import { executionDefinitionSchema } from "./execution";
import type { RecordSchema, Value } from "../field-types";
export const platformApi = "1.0.0";
export const manifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/),
    name: z.string().min(1),
    description: z.string(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    platformApi: z.literal("^1.0.0"),
    fieldSchemaApi: z.literal("^1.0.0"),
    publisher: z.string().min(1),
    license: z.string().min(1),
    entrypoints: z
      .object({
        core: z.string().optional(),
        browser: z.string().optional(),
        server: z.string().optional(),
        runner: z.string().optional(),
      })
      .strict(),
    server: z
      .object({
        routes: z
          .array(
            z.object({
              path: z.string().regex(/^[a-z][a-z0-9/-]*(?:\*)?$/),
              methods: z.array(z.enum(["GET", "POST", "PUT", "DELETE"])),
              authentication: z
                .enum(["workspace", "plugin"])
                .default("workspace"),
            }),
          )
          .default([]),
        background: z.boolean().default(false),
        mutationHooks: z.boolean().default(false),
      })
      .optional(),
    execution: z.array(executionDefinitionSchema).optional(),
    ui: z.object({
      mode: z.enum(["none", "shared"]),
      apiVersion: z.string().optional(),
      surfaces: z.array(z.string()).default([]),
    }),
    storage: z.object({
      local: z.object({
        mode: z.enum(["none", "dexie"]),
        collections: z.array(z.string()).default([]),
      }),
    }),
    permissions: z.array(z.string()),
    dependencies: z.array(z.string()).default([]),
    features: z
      .record(z.object({ defaultEnabled: z.literal(false) }))
      .default({}),
    sharedServices: z.array(
      z.object({
        id: z.string(),
        version: z.literal("^1"),
        optional: z.boolean(),
        when: z.string().optional(),
      }),
    ),
    provides: z.object({
      commands: z.array(z.string()),
      events: z.array(z.string()),
    }),
    consumes: z.object({
      commands: z.array(z.string()),
      events: z.array(z.string()),
    }),
  })
  .strict();
export type PluginManifest = z.infer<typeof manifestSchema>;
export type Runtime =
  "browser" | "desktop" | "ios" | "android" | "server" | "runner";
export interface Principal {
  userId: string;
  workspaceId: string;
  deviceId?: string;
  pluginId: string;
  permissions: string[];
}
export interface ResourceRecord {
  /** Unknown newer schemas replicate opaquely; editing requires the matching plugin version. */
  schemaVersion?: number;
  id: string;
  workspaceId: string;
  ownerId: string;
  pluginId: string;
  collection: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  data: Record<string, Value>;
}
export interface Mutation {
  id: string;
  resourceId: string;
  pluginId: string;
  collection: string;
  operation: "put" | "delete";
  baseRevision: number;
  data: Record<string, Value>;
  createdAt: string;
}
export interface CoreContext {
  principal: Readonly<Principal>;
  runtime: Runtime;
  signal: AbortSignal;
  messages: {
    handle(
      command: string,
      contract: RecordSchema,
      execute: (
        input: Record<string, Value>,
        signal: AbortSignal,
      ) => Promise<Value>,
    ): () => void;
    subscribe(
      event: string,
      handler: (event: PluginEvent) => Promise<void>,
    ): () => void;
    publish(
      event: string,
      resourceId: string,
      revision: number,
      value: Value,
      operationId: string,
    ): Promise<void>;
    call<T = unknown>(
      command: string,
      input: unknown,
      options?: { mutationId?: string; targetDeviceId?: string },
    ): Promise<T>;
  };
  services: {
    require<T>(id: string): T;
    optional<T>(id: string): T | undefined;
  };
  log: (
    message: string,
    metadata?: Record<string, string | number | boolean>,
  ) => void;
}
export interface PluginEvent {
  specversion: string;
  id: string;
  source: string;
  type: string;
  subject?: string;
  data: {
    workspaceId: string;
    resourceId: string;
    revision: number;
    value: Value;
  };
}
export interface PluginModule {
  manifest: PluginManifest;
  schemas?: RecordSchema[];
  activate(context: CoreContext): Promise<(() => void | Promise<void>) | void>;
}
export interface Device {
  id: string;
  name: string;
  platform: Runtime;
  capabilities: string[];
  lastSeen: string;
  leaseEpoch: number;
  online: boolean;
  revoked: boolean;
}
export interface Availability {
  available: boolean;
  reason?:
    | "DEVICE_OFFLINE"
    | "CAPABILITY_UNSUPPORTED"
    | "PERMISSION_DENIED"
    | "FEATURE_DISABLED"
    | "CORE_DEPENDENCY_UNAVAILABLE";
}
