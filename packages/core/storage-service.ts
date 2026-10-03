import type { WorkspaceNode } from "./device";
import type {
  StorageItem,
  StoragePlacementService,
} from "@taskasaur/platform/plugin-sdk/storage-placement";
import { invariant } from "@taskasaur/platform/core/errors";

/** Plugins may manage placement only for their own resources. Deletion requires core UI. */
export function storageService(
  node: WorkspaceNode,
  pluginId: string,
): StoragePlacementService {
  const storage = node.protocol.storage;
  const owned = async (item: StorageItem) => {
    const status = await storage.status(item);
    invariant(
      status.pluginId === pluginId,
      "PERMISSION_DENIED",
      "Storage item belongs to another plugin",
    );
    return status;
  };
  return {
    list: async () =>
      (await storage.list()).filter((s) => s.pluginId === pluginId),
    status: owned,
    setCopy: async (item, device, keep) => {
      await owned(item);
      await storage.setCopy(item, device, keep);
    },
  };
}
