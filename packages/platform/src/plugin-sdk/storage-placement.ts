/** Core-managed retention. Metadata needed to discover and route items always replicates. */
export interface StorageItem {
  kind: "record" | "file-version";
  id: string;
}
export interface StorageVersion {
  heads: string[];
  token: string;
}
export interface StorageCopy {
  deviceId: string;
  requested: boolean;
  retained: boolean;
  version?: string;
}
export interface StorageItemStatus {
  item: StorageItem;
  label: string;
  pluginId: string;
  collection: string;
  version: StorageVersion;
  local: boolean;
  deleted: boolean;
  copies: StorageCopy[];
}
export interface StoragePlacementService {
  list(): Promise<StorageItemStatus[]>;
  status(item: StorageItem): Promise<StorageItemStatus>;
  /** Queues retention or safe handoff, including for an offline target device. */
  setCopy(item: StorageItem, deviceId: string, keep: boolean): Promise<void>;
}
