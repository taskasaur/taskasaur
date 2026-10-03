import { verifyArtifact } from "@taskasaur/platform/plugin-sdk/artifact";
import { createHash, sign } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  rename,
  stat,
  lstat,
  access,
} from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import {
  manifestSchema,
  type PluginManifest,
} from "@taskasaur/platform/plugin-sdk";
import {
  registerExtension,
  validateExtension,
  isRequiredCore,
  manifestById,
} from "@taskasaur/platform/core/catalog";
import { invariant } from "@taskasaur/platform/core/errors";
import { migrateRecordSchema } from "./schema";
import type { Database } from "./database";
const indexSchema = z
  .object({
    format: z.literal(1),
    publisher: z.string(),
    files: z.record(
      z.object({
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().nonnegative(),
      }),
    ),
  })
  .strict();
export const pluginRoot = () =>
  path.resolve(process.env.PLUGIN_PATH ?? ".taskasaur/plugins");
const safePath = (name: string) =>
  Boolean(
    name &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    name.split("/").every((p) => p && p !== "." && p !== "..") &&
    !name.includes("\0"),
  );
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const reserved = new Set([
  "artifact.zip",
  "package-index.json",
  "package-signature",
]);
export async function packPlugin(directory: string, key: string) {
  const files: Record<string, Buffer> = {};
  async function visit(folder: string, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const name = prefix + entry.name;
      invariant(
        safePath(name) && !reserved.has(name) && !entry.isSymbolicLink(),
        "INVALID_PACKAGE",
        "Package contains an unsafe or reserved path",
      );
      if (entry.isDirectory())
        await visit(path.join(folder, entry.name), name + "/");
      else if (entry.isFile())
        files[name] = await readFile(path.join(folder, entry.name));
    }
  }
  await visit(directory);
  const manifest = manifestSchema.parse(
    JSON.parse(files["plugin.json"]?.toString() ?? "null"),
  );
  const index = {
    format: 1,
    publisher: manifest.publisher,
    files: Object.fromEntries(
      Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, data]) => [
          name,
          { sha256: hash(data), size: data.length },
        ]),
    ),
  };
  const bytes = Buffer.from(JSON.stringify(index)),
    zip = new JSZip();
  zip.file("package-index.json", bytes);
  zip.file("package-signature", sign(null, bytes, key).toString("base64"));
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
export async function verifyPackage(
  bytes: Buffer,
  trust: Record<string, string>,
) {
  return verifyArtifact(bytes, trust);
}
export async function installedPackages() {
  try {
    return JSON.parse(
      await readFile(path.join(pluginRoot(), "inventory.json"), "utf8"),
    ) as Record<
      string,
      { version: string; digest: string; grants: string[]; publicKey: string }
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
export async function installPackage(
  bytes: Buffer,
  trust: Record<string, string>,
  grants: string[],
  db?: Database,
) {
  const verified = await verifyPackage(bytes, trust),
    { manifest, contracts, files } = verified;
  const required = [
    ...manifest.permissions,
    ...manifest.sharedServices.filter((s) => !s.optional).map((s) => s.id),
    ...manifest.consumes.commands,
    ...manifest.consumes.events,
  ];
  invariant(
    required.every((permission) => grants.includes(permission)),
    "PERMISSION_DENIED",
    "All requested required permissions must be reviewed and granted",
  );
  const root = pluginRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, ".install-lock");
  await mkdir(lock).catch(() => {
    throw new Error("Another plugin installation is in progress");
  });
  const { rm } = await import("node:fs/promises");
  try {
    const inventory = await installedPackages();
    const previous = inventory[manifest.id];
    let previousSchemas: ReturnType<typeof validateExtension>["schemas"] = [];
    if (previous) {
      const compare = (a: string, b: string) => {
        const left = a.split(".").map(Number),
          right = b.split(".").map(Number);
        for (let i = 0; i < 3; i++)
          if (left[i] !== right[i]) return left[i] - right[i];
        return 0;
      };
      invariant(
        compare(manifest.version, previous.version) >= 0,
        "VERSION_DOWNGRADE",
        "Plugin downgrades require an explicit data migration",
      );
      invariant(
        manifest.version !== previous.version ||
          verified.digest === previous.digest,
        "VERSION_CONFLICT",
        "Publish changed packages with a new version",
      );
      const oldBytes = await readFile(
        path.join(
          root,
          manifest.id,
          previous.version + "-" + previous.digest.slice(0, 16),
          "artifact.zip",
        ),
      );
      const old = await verifyPackage(oldBytes, {
        [manifest.publisher]: previous.publicKey,
      });
      invariant(
        old.digest === previous.digest,
        "INTEGRITY_FAILED",
        "Installed package integrity check failed",
      );
      previousSchemas = validateExtension(old.manifest, old.contracts).schemas;
      const next = validateExtension(manifest, contracts).schemas;
      for (const schema of previousSchemas) {
        const replacement = next.find((s) => s.id === schema.id);
        invariant(
          replacement &&
            schema.fields.every((f) =>
              replacement.fields.some((n) => n.id === f.id),
            ),
          "MIGRATION_REQUIRED",
          "Removing a collection or field requires an explicit migration",
        );
        invariant(
          replacement.version >= schema.version,
          "MIGRATION_REQUIRED",
          "Collection versions cannot move backwards",
        );
      }
    }
    for (const dependency of manifest.dependencies)
      invariant(
        isRequiredCore(dependency) || inventory[dependency],
        "DEPENDENCY_MISSING",
        `Install ${dependency} first`,
      );
    const staging = path.join(root, ".stage-" + crypto.randomUUID());
    await mkdir(staging);
    try {
      for (const [name, data] of Object.entries(files)) {
        const target = path.join(staging, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, data, { mode: 0o600 });
      }
      await writeFile(path.join(staging, "artifact.zip"), bytes, {
        mode: 0o600,
      });
      const registered = validateExtension(manifest, contracts);
      if (db)
        await db.transaction(async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock(748192401)");
          for (const schema of registered.schemas) {
            await migrateRecordSchema(tx, schema);
          }
          await tx.query(
            "UPDATE taskasaur.plugins SET version=$2 WHERE id=$1",
            [manifest.id, manifest.version],
          );
        });
      const target = path.join(
        root,
        manifest.id,
        manifest.version + "-" + verified.digest.slice(0, 16),
      );
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await access(target);
        await rm(staging, { recursive: true });
      } catch {
        await rename(staging, target);
      }
      inventory[manifest.id] = {
        version: manifest.version,
        digest: verified.digest,
        grants,
        publicKey: trust[manifest.publisher],
      };
      const temporary = path.join(root, ".inventory-" + crypto.randomUUID());
      await writeFile(temporary, JSON.stringify(inventory, null, 2), {
        mode: 0o600,
      });
      await rename(temporary, path.join(root, "inventory.json"));
      registerExtension(manifest, contracts);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return {
      id: manifest.id,
      version: manifest.version,
      digest: verified.digest,
    };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
type LoadedPackage = ReturnType<typeof registerExtension> & {
  directory: string;
  grants: string[];
  digest: string;
  browserDigest?: string;
};
const verifiedCache = new Map<
  string,
  { state: string; stamp: string; names: string[]; entry: LoadedPackage }
>();
async function fingerprint(directory: string, names: string[]) {
  return JSON.stringify(
    await Promise.all(
      names.map(async (name) => {
        const info = await lstat(path.join(directory, name));
        invariant(
          info.isFile() && !info.isSymbolicLink(),
          "INTEGRITY_FAILED",
          "Installed package file changed",
        );
        return [name, info.size, info.mtimeMs, info.ctimeMs, info.ino];
      }),
    ),
  );
}
export async function loadPackageCatalog() {
  const inventory = await installedPackages(),
    loaded = [];
  for (const [id, state] of Object.entries(inventory)) {
    invariant(
      /^[a-z][a-z0-9.-]*$/.test(id) &&
        /^\d+\.\d+\.\d+$/.test(state.version) &&
        /^[a-f0-9]{64}$/.test(state.digest),
      "INTEGRITY_FAILED",
      "Invalid installed package inventory",
    );
    const directory = path.join(
      pluginRoot(),
      id,
      state.version + "-" + state.digest.slice(0, 16),
    );
    const prior = verifiedCache.get(directory),
      stateKey = JSON.stringify(state);
    if (
      prior &&
      prior.state === stateKey &&
      prior.stamp === (await fingerprint(directory, prior.names))
    ) {
      registerExtension(prior.entry.manifest, prior.entry.schemas);
      loaded.push(prior.entry);
      continue;
    }
    const artifact = await readFile(path.join(directory, "artifact.zip"));
    invariant(
      hash(artifact) === state.digest,
      "INTEGRITY_FAILED",
      "Installed artifact changed",
    );
    const signatureIndex = await JSZip.loadAsync(artifact),
      index = JSON.parse(
        await signatureIndex.file("package-index.json")!.async("string"),
      );
    const { manifest, contracts, files } = await verifyPackage(artifact, {
      [index.publisher]: state.publicKey,
    });
    invariant(
      manifest.id === id && manifest.version === state.version,
      "INTEGRITY_FAILED",
      "Installed manifest changed",
    );
    for (const [name, bytes] of Object.entries(files))
      invariant(
        hash(await readFile(path.join(directory, name))) === hash(bytes),
        "INTEGRITY_FAILED",
        "Installed module changed; reinstall the verified package",
      );
    const entry = {
      ...registerExtension(manifest, contracts),
      directory,
      grants: state.grants,
      digest: state.digest,
      browserDigest: manifest.entrypoints.browser
        ? hash(files[manifest.entrypoints.browser])
        : undefined,
    };
    const names = ["artifact.zip", ...Object.keys(files)];
    verifiedCache.set(directory, {
      state: stateKey,
      stamp: await fingerprint(directory, names),
      names,
      entry,
    });
    loaded.push(entry);
  }
  return loaded;
}
