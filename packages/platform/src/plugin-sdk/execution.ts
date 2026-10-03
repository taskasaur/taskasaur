import { z } from "zod";
import type { PeerDevice } from "./peers";
/** An execution slot belongs to an item, never to the whole plugin. */
export const executionDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    collection: z.string().min(1),
    label: z.string().min(1),
    targetField: z.string().optional(),
    enabledField: z.string().optional(),
    plugins: z
      .array(
        z
          .object({
            id: z.string(),
            version: z
              .string()
              .regex(/^\d+\.\d+\.\d+$/)
              .optional(),
          })
          .strict(),
      )
      .default([]),
    capabilities: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    routes: z.array(z.string()).default([]),
    references: z
      .array(z.object({ collection: z.string(), field: z.string() }).strict())
      .default([]),
    background: z
      .object({
        command: z.string(),
        intervalSeconds: z.number().int().min(60),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ExecutionDefinition = z.infer<typeof executionDefinitionSchema>;
export interface ExecutionSlot extends ExecutionDefinition {
  pluginId: string;
}
export interface DevicePluginState {
  id: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  error?: string;
}
export interface DevicePluginStatus {
  deviceId: string;
  plugins: DevicePluginState[];
  capabilities: string[];
  canInstall: boolean;
}
export interface ExecutionBinding {
  deviceId: string;
  generation: string;
  enabled: boolean;
  resourceId: string;
  pluginId: string;
  collection: string;
  slot: string;
}
export interface ExecutionCandidate extends PeerDevice {
  plugins: DevicePluginState[];
  missingPlugins: {
    id: string;
    version?: string;
    reason: "missing" | "disabled" | "version" | "failed";
  }[];
  missingCapabilities: string[];
  statusKnown: boolean;
  ready: boolean;
  canInstall: boolean;
  error?: string;
}
export interface ExecutionState {
  binding?: ExecutionBinding;
  candidates: ExecutionCandidate[];
  configured: boolean;
  enabled: boolean;
  targetDeviceId: string | null;
}
export interface ExecutionService {
  definitions(): ExecutionSlot[];
  inspect(resourceId: string, slotId?: string): Promise<ExecutionState>;
  configure(
    resourceId: string,
    options: { slotId?: string; deviceId: string; enabled: boolean },
  ): Promise<ExecutionBinding>;
}
