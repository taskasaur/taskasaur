import { WorkspaceRouter, WorkspaceStorage } from "../storage/workspace";
import { NodeWorkspaceFiles } from "./workspace-files";
import { openNodeWorkspaceArchive } from "./workspace-archive";
import { importWorkspace, workspaceSnapshot } from "../core/workspace-package";
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
    workspaceFolder?: string;
    workspaceFile?: string;
    storage?: DurableStorage;
    syncIntervalMs?: number;
    documentCache?: number;
  },
) {
  if (options.workspaceFile && options.workspaceFolder)
    throw Error("Choose one workspace file or folder");
  const interval = options.syncIntervalMs ?? 5000,
    documentCache = options.documentCache ?? 512;
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1000 ||
    interval > 3600000 ||
    !Number.isSafeInteger(documentCache) ||
    documentCache < 1 ||
    documentCache > 100000
  )
    throw Error("Invalid synchronization interval or document cache limit");
  const unlock = await lockDirectory(options.directory);
  let services: NativeServices | undefined;
  let core: DeviceCore | undefined;
  try {
    const router = new WorkspaceRouter(
      options.storage ??
        new FileStorage(path.join(options.directory, "replicas")),
    );
    const storage = snapshotStorage(router);
    core = await DeviceCore.open(
      storage,
      options.name ?? os.hostname(),
      () => services?.capabilities() ?? [],
    );
    if (options.workspaceFile || options.workspaceFolder) {
      const files = options.workspaceFile
        ? await openNodeWorkspaceArchive(options.workspaceFile)
        : await NodeWorkspaceFiles.open(options.workspaceFolder!);
      try {
        const workspace = await WorkspaceStorage.open(files);
        const node = await importWorkspace(core, workspace);
        await router.mount(
          workspace,
          true,
          (await workspaceSnapshot(node)).excludedKeys,
        );
      } catch (error) {
        await files.close();
        throw error;
      }
    }
    if (
      !options.workspaceFolder &&
      !options.workspaceFile &&
      !core.profiles().length &&
      options.createWorkspace
    )
      await core.createWorkspace(options.createWorkspace);
    services = new NativeServices(core, {
      directory: options.directory,
      storageOnly: options.storageOnly ?? false,
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
    let scheduled = false;
    let stopping = false,
      pending: Promise<void> = Promise.resolve();
    const tick = () => {
      if (scheduled || stopping) return;
      scheduled = true;
      pending = pending
        .then(async () => {
          if (stopping) return;
          for (const node of device.workspaces.values())
            await node.synchronize();
          await services!.tick();
          for (const node of device.workspaces.values())
            node.replica.compact(documentCache);
        })
        .catch((error) => {
          for (const node of device.workspaces.values())
            node.replica.error =
              error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          scheduled = false;
        });
    };
    tick();
    const timer = setInterval(tick, interval);
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
