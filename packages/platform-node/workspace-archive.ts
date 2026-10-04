import { readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ArchiveWorkspaceFiles,
  assertArchiveUnchanged,
  WORKSPACE_ARCHIVE_LIMIT,
} from "../storage/workspace-archive";
import { lockFile } from "./lock";
import { atomicWorkspaceWrite } from "./workspace-files";

export async function openNodeWorkspaceArchive(
  filename: string,
  create = false,
) {
  let target = path.resolve(filename);
  try {
    target = await realpath(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw e;
    target = path.join(
      await realpath(path.dirname(target)),
      path.basename(target),
    );
  }
  const release = await lockFile(target + ".lock");
  const read = async () => {
    try {
      if ((await stat(target)).size > WORKSPACE_ARCHIVE_LIMIT)
        throw Error("Workspace files are limited to 1 GB");
      return new Uint8Array(await readFile(target));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  };
  return ArchiveWorkspaceFiles.open(
    {
      read,
      async replace(bytes, expectedHash) {
        await assertArchiveUnchanged(await read(), expectedHash);
        await atomicWorkspaceWrite(target, bytes);
      },
      close: release,
    },
    create,
  );
}
