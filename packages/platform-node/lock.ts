import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
/** One writer per native data directory. Management commands use the same lock. */
export async function lockDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return lockFile(path.join(directory, "runtime.lock"));
}
/** A temporary sidecar lease is device-local and never part of the workspace. */
export async function lockFile(file: string) {
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(
        file,
        JSON.stringify({ pid: process.pid, host: os.hostname(), token }),
        { flag: "wx", mode: 0o600 },
      );
      return async () => {
        try {
          if (JSON.parse(await readFile(file, "utf8")).token === token)
            await rm(file);
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = JSON.parse(await readFile(file, "utf8"));
      let alive = true;
      if (previous.host === os.hostname())
        try {
          process.kill(previous.pid, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
        }
      if (alive)
        throw Error(
          "This data directory is already open. Stop its Taskasaur process before running a management command.",
        );
      await rm(file);
    }
  }
  throw Error("Could not exclusively open the data directory");
}
