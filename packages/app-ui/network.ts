import type { Identity } from "../core/crypto";
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
      workspace?: {
        choose(
          kind: "file" | "folder",
          create: boolean,
          password?: string,
        ): Promise<{
          id: string;
          label: string;
          kind: "file" | "folder";
          locked?: boolean;
        }>;
        unlock(
          id: string,
          password: string,
        ): Promise<{ id: string; label: string; kind: "file" | "folder" }>;
        resume(
          workspaceId: string,
          password?: string,
        ): Promise<{ id: string; label: string; kind: "file" | "folder" }>;
        list(): Promise<
          Array<{
            id: string;
            label: string;
            kind: "file" | "folder";
            workspaceId: string;
            error?: string;
          }>
        >;
        read(id: string, path: string): Promise<Uint8Array | undefined>;
        write(id: string, path: string, bytes: Uint8Array): Promise<void>;
        remove(id: string, path: string): Promise<void>;
        bind(id: string, workspaceId: string): Promise<void>;
        commit(
          id: string,
          manifest: Uint8Array,
          additions: Record<string, Uint8Array>,
        ): Promise<void>;
        refresh(id: string): Promise<void>;
        close(id: string): Promise<void>;
      };
      peer: {
        request(address: string, packet: PeerPacket): Promise<PeerPacket>;
        select(workspaceId?: string): Promise<void>;
        join(invitation: string, credential?: Identity): Promise<void>;
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
