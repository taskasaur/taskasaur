import { Capacitor } from "@capacitor/core";
import { BrowserStorage } from "./storage";
import { NativeStorage } from "../platform-native/storage";
import { DeviceCore } from "../core/device";
import { createPeerTransport } from "../sync/libp2p";
import { acquireWriter } from "./writer-lock";
import { snapshotStorage } from "../storage";
import { WorkspaceRouter } from "../storage/workspace";
import { restoreWorkspaceLocations } from "./workspace-location";
let running: Promise<DeviceCore> | undefined;
export let workspaceRouter: WorkspaceRouter;
export function browserDevice() {
  return (running ??= (async () => {
    const native = window.taskasaurNative;
    const release = await acquireWriter();
    try {
      workspaceRouter = new WorkspaceRouter(
        native?.storage ??
          (Capacitor.isNativePlatform()
            ? new NativeStorage()
            : new BrowserStorage()),
      );
      await restoreWorkspaceLocations(async (id, source) => {
        if (source) await workspaceRouter.mount(source, false);
        else workspaceRouter.blocked.add(id);
      });
      const storage = snapshotStorage(workspaceRouter);
      const device = await DeviceCore.open(
        storage,
        Capacitor.isNativePlatform() ? Capacitor.getPlatform() : "Web browser",
        () => ["records.*", "files.*"],
      );
      if (native) {
        const info = await native.peer.info();
        device.attachTransport({
          request: (address, packet) => native.peer.request(address, packet),
          addresses: () => info.addresses,
          close: async () => {
            release();
          },
        });
        return device;
      }
      try {
        const webRTC = typeof RTCPeerConnection !== "undefined";
        const transport = await createPeerTransport(storage, device.protocols, {
          webRTC,
          listen: webRTC ? ["/p2p-circuit", "/webrtc"] : [],
        });
        device.attachTransport(transport);
      } catch (error) {
        console.error(
          "Peer networking could not start",
          error instanceof Error ? error.message : String(error),
        );
      }
      void navigator.storage?.persist?.();
      return device;
    } catch (error) {
      release();
      running = undefined;
      throw error;
    }
  })());
}
