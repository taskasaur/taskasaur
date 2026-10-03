import type { DurableStorage } from "../storage";
import type { PeerPacket } from "../sync/protocol";
export interface NativeSettings {
  terminal: boolean;
  automation: boolean;
  trustedCode: boolean;
  background: boolean;
  plugins: boolean;
}
export interface NativeInfo {
  id: string;
  request: string;
  addresses: string[];
  workspaces: string[];
  options: NativeSettings;
}
declare global {
  interface Window {
    taskasaurNative?: {
      storage: DurableStorage;
      peer: {
        request(address: string, packet: PeerPacket): Promise<PeerPacket>;
        join(invitation: string): Promise<void>;
        info(): Promise<NativeInfo>;
        configure(options: NativeSettings): Promise<NativeInfo>;
      };
    };
  }
}
/** Compatibility helper for public plugin assets. Workspace operations use core peer RPC. */
export const serverFetch = (input: string | URL, options: RequestInit = {}) =>
  fetch(input, { ...options, credentials: "omit" });
export const defaultServerUrl = () => location.origin;
