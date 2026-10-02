import { createHash, verify, sign } from "node:crypto";
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
import { manifestSchema, type PluginManifest } from "../packages/plugin-sdk";
import {
  registerExtension,
  validateExtension,
  isRequiredCore,
  manifestById,
} from "../packages/core/catalog";
import { invariant } from "../packages/core/errors";
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
const hash = (bytes: Buffer) =>
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
  invariant(
    bytes.length <= 50 * 1024 * 1024,
    "PAYLOAD_TOO_LARGE",
    "Plugin package exceeds 50 MB",
  );
  const zip = await JSZip.loadAsync(bytes);
  const expanded = (name: string) =>
    Number(
      (zip.files[name] as unknown as { _data?: { uncompressedSize?: number } })
        ?._data?.uncompressedSize ?? 0,
    );
  invariant(
    expanded("package-index.json") <= 256 * 1024 &&
      expanded("package-signature") <= 1024,
    "PAYLOAD_TOO_LARGE",
    "Package signature metadata exceeds limits",
  );
  const indexBytes = await zip.file("package-index.json")?.async("nodebuffer"),
    signature = await zip.file("package-signature")?.async("string");
  invariant(
    indexBytes && indexBytes.length < 256 * 1024 && signature,
    "INVALID_PACKAGE",
    "Signed package index is required",
  );
  const index = indexSchema.parse(JSON.parse(indexBytes.toString()));
  const key = trust[index.publisher];
  invariant(
    key && verify(null, indexBytes, key, Buffer.from(signature, "base64")),
    "UNTRUSTED_PUBLISHER",
    "Publisher signature is not trusted",
  );
  invariant(
    Object.keys(index.files).length <= 1000 &&
      Object.values(index.files).reduce((sum, f) => sum + f.size, 0) <=
        50 * 1024 * 1024,
    "PAYLOAD_TOO_LARGE",
    "Expanded package exceeds limits",
  );
  const files: Record<string, Buffer> = {};
  for (const file of Object.values(zip.files))
    if (!file.dir)
      invariant(
        file.name in index.files ||
          ["package-index.json", "package-signature"].includes(file.name),
        "INVALID_PACKAGE",
        "Unlisted package file",
      );
  for (const [name, expected] of Object.entries(index.files)) {
    invariant(
      safePath(name) && !reserved.has(name),
      "INVALID_PACKAGE",
      "Unsafe package path",
    );
    invariant(
      expanded(name) === expected.size,
      "INTEGRITY_FAILED",
      "Package entry size changed",
    );
    const data = await zip.file(name)?.async("nodebuffer");
    invariant(
      data && data.length === expected.size && hash(data) === expected.sha256,
      "INTEGRITY_FAILED",
      "Plugin file failed integrity verification",
    );
    files[name] = data;
  }
  const manifest = manifestSchema.parse(
    JSON.parse(files["plugin.json"]?.toString() ?? "null"),
  );
  invariant(
    manifest.publisher === index.publisher &&
      !isRequiredCore(manifest.id) &&
      manifest.publisher !== "taskasaur",
    "RESERVED_PROVIDER",
    "Invalid package publisher or reserved plugin",
  );
  for (const entry of Object.values(manifest.entrypoints))
    invariant(
      entry && safePath(entry) && files[entry],
      "INVALID_PACKAGE",
      "Entrypoint is missing",
    );
  const contracts = JSON.parse(files["schemas.json"]?.toString() ?? "[]");
  validateExtension(manifest, contracts);
  return { manifest, contracts, files, digest: hash(bytes) };
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
        isRequiredCore(dependency) ||
          manifestById.get(dependency)?.publisher === "taskasaur" ||
          inventory[dependency],
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
    loaded.push({
      ...registerExtension(manifest, contracts),
      directory,
      grants: state.grants,
      digest: state.digest,
      browserDigest: manifest.entrypoints.browser
        ? hash(files[manifest.entrypoints.browser])
        : undefined,
    });
  }
  return loaded;
}
