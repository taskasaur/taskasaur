import path from "node:path";
import os from "node:os";
import { FileStorage } from "./storage";
import { DeviceCore } from "../core/device";
import { NativeServices, type NativeOptions } from "./services";
import { createPeerTransport, type NetworkOptions } from "../sync/libp2p";
import type { DurableStorage } from "../storage";
import { snapshotStorage } from "../storage";
import { lockDirectory } from "./lock";
export async function startNativeRuntime(
  options: Partial<NativeOptions> & {
    directory: string;
    name?: string;
    network?: NetworkOptions;
    createWorkspace?: string;
    storage?: DurableStorage;
  },
) {
  const unlock = await lockDirectory(options.directory);
  let services: NativeServices | undefined;
  let core: DeviceCore | undefined;
  try {
    const storage = snapshotStorage(
      options.storage ??
        new FileStorage(path.join(options.directory, "replicas")),
    );
    core = await DeviceCore.open(
      storage,
      options.name ?? os.hostname(),
      () => services?.capabilities() ?? [],
    );
    if (!core.profiles().length && options.createWorkspace)
      await core.createWorkspace(options.createWorkspace);
    services = new NativeServices(core, {
      directory: options.directory,
      terminal: options.terminal ?? false,
      automation: options.automation ?? false,
      trustedCode: options.trustedCode ?? false,
      background: options.background ?? false,
      plugins: options.plugins ?? false,
    });
    await services.initialize();
    const device = core;
    const transport = await createPeerTransport(
      storage,
      core.protocols,
      options.network ?? { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    );
    core.attachTransport(transport);
    let stopping = false,
      pending: Promise<void> = Promise.resolve();
    const tick = () => {
      pending = pending
        .then(async () => {
          if (stopping) return;
          for (const node of device.workspaces.values())
            await node.synchronize();
          await services!.tick();
        })
        .catch((error) => {
          for (const node of device.workspaces.values())
            node.replica.error =
              error instanceof Error ? error.message : String(error);
        });
    };
    tick();
    const timer = setInterval(tick, 5000);
    timer.unref();
    return {
      core,
      services,
      addresses: () => transport.addresses(),
      async close() {
        stopping = true;
        clearInterval(timer);
        await pending;
        try {
          try {
            await services!.close();
          } finally {
            await device.close();
          }
        } finally {
          await unlock();
        }
      },
    };
  } catch (error) {
    await services?.close().catch(() => {});
    await core?.close().catch(() => {});
    await unlock();
    throw error;
  }
}
