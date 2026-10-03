import type { ResourceRecord } from "./index";
export interface PeerDevice {
  id: string;
  recordId: string;
  name: string;
  online: boolean;
  capabilities: string[];
  lastSeen: string | null;
}
/** Optional discovery service. All cross-device calls still use context.messages.call(). */
export interface PeerService {
  list(): Promise<PeerDevice[]>;
  self(): Promise<PeerDevice>;
  supports(deviceId: string, capability: string): Promise<boolean>;
}
/** Local Dexie projection. Writes are validated and durably committed by core before projection. */
export interface ReplicaStatus {
  documents: number;
  changes: number;
  quarantined: number;
  pending: number;
  peers: number;
  error?: string;
}
export interface SyncService {
  synchronize(): Promise<void>;
  status(): ReplicaStatus;
}
export interface SettingsService {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}
