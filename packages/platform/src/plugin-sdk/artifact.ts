import JSZip from "jszip";
import { z } from "zod";
import { manifestSchema } from "./index";
import { invariant } from "../core/errors";
import { isRequiredCore, validateExtension } from "../core/catalog";
import type { InventoryEntry } from "./inventory";
export const safePackagePath = (name: string) =>
  Boolean(
    name &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name.split("/").every((p) => p && p !== "." && p !== ".."),
  );
export const artifactHash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const indexSchema = z
  .object({
    format: z.literal(1),
    publisher: z.string(),
    files: z.record(
      z.object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().nonnegative(),
      }),
    ),
  })
  .strict();
const reserved = new Set([
  "artifact.zip",
  "package-index.json",
  "package-signature",
]);
export function requiredGrants(
  manifest: ReturnType<typeof manifestSchema.parse>,
) {
  return [
    ...new Set([
      ...manifest.permissions,
      ...manifest.sharedServices.filter((s) => !s.optional).map((s) => s.id),
      ...manifest.consumes.commands,
      ...manifest.consumes.events,
    ]),
  ].sort();
}
export function inventoryGrants(
  manifest: ReturnType<typeof manifestSchema.parse>,
) {
  return [
    ...new Set([
      ...requiredGrants(manifest),
      ...manifest.sharedServices.map((service) => service.id),
    ]),
  ].sort();
}
export async function verifyArtifact(
  bytes: Uint8Array,
  trust: Record<string, string>,
  expected?: InventoryEntry,
) {
  invariant(
    bytes.byteLength <= 50 * 1024 * 1024,
    "PAYLOAD_TOO_LARGE",
    "Plugin package exceeds 50 MB",
  );
  const digest = await artifactHash(bytes);
  if (expected)
    invariant(
      digest === expected.sha256,
      "INTEGRITY_FAILED",
      "Download checksum differs from the inventory",
    );
  const zip = await JSZip.loadAsync(bytes);
  const expanded = (name: string) =>
    Number(
      (zip.files[name] as unknown as { _data?: { uncompressedSize?: number } })
        ?._data?.uncompressedSize ?? 0,
    );
  invariant(
    expanded("package-index.json") < 256 * 1024 &&
      expanded("package-signature") <= 1024,
    "PAYLOAD_TOO_LARGE",
    "Package signature metadata exceeds limits",
  );
  const indexBytes = await zip.file("package-index.json")?.async("uint8array"),
    signature = await zip.file("package-signature")?.async("string");
  invariant(
    indexBytes && signature,
    "INVALID_PACKAGE",
    "Signed package index is required",
  );
  const index = indexSchema.parse(
      JSON.parse(new TextDecoder().decode(indexBytes)),
    ),
    pem = trust[index.publisher];
  invariant(pem, "UNTRUSTED_PUBLISHER", "Publisher signature is not trusted");
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const decode = (s: string) =>
    Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "spki",
    decode(base64),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  invariant(
    await crypto.subtle.verify(
      "Ed25519",
      key,
      decode(signature),
      new Uint8Array(indexBytes),
    ),
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
  for (const file of Object.values(zip.files)) {
    invariant(
      safePackagePath(file.name.replace(/\/$/, "")) &&
        (!file.unsafeOriginalName || file.unsafeOriginalName === file.name),
      "INVALID_PACKAGE",
      "Unsafe archive path",
    );
    invariant(
      !file.unixPermissions ||
        (Number(file.unixPermissions) & 0o170000) !== 0o120000,
      "INVALID_PACKAGE",
      "Symlinks are not allowed",
    );
    if (!file.dir)
      invariant(
        file.name in index.files ||
          (reserved.has(file.name) && file.name !== "artifact.zip"),
        "INVALID_PACKAGE",
        "Unlisted package file",
      );
  }
  const files: Record<string, Uint8Array> = {};
  for (const [name, expected] of Object.entries(index.files)) {
    invariant(
      safePackagePath(name) && !reserved.has(name),
      "INVALID_PACKAGE",
      "Unsafe package path",
    );
    invariant(
      expanded(name) === expected.size,
      "INTEGRITY_FAILED",
      "Package entry size changed",
    );
    const data = await zip.file(name)?.async("uint8array");
    invariant(
      data &&
        data.length === expected.size &&
        (await artifactHash(data)) === expected.sha256,
      "INTEGRITY_FAILED",
      "Plugin file failed integrity verification",
    );
    files[name] = data;
  }
  const manifest = manifestSchema.parse(
    JSON.parse(new TextDecoder().decode(files["plugin.json"])),
  );
  invariant(
    manifest.publisher === index.publisher && !isRequiredCore(manifest.id),
    "RESERVED_PROVIDER",
    "Invalid package publisher or reserved plugin",
  );
  for (const entry of Object.values(manifest.entrypoints))
    invariant(
      entry && safePackagePath(entry) && files[entry],
      "INVALID_PACKAGE",
      "Entrypoint is missing",
    );
  if (expected) {
    for (const name of [
      "id",
      "version",
      "publisher",
      "name",
      "description",
      "license",
    ] as const)
      invariant(
        manifest[name] === expected[name],
        "INTEGRITY_FAILED",
        `Package ${name} differs from inventory`,
      );
    for (const [actual, wanted] of [
      [manifest.permissions, expected.permissions],
      [manifest.dependencies, expected.dependencies],
      [inventoryGrants(manifest), expected.grants],
    ])
      invariant(
        JSON.stringify([...actual].sort()) ===
          JSON.stringify([...wanted].sort()),
        "INTEGRITY_FAILED",
        "Package capabilities differ from the reviewed inventory",
      );
  }
  const contracts = JSON.parse(
    new TextDecoder().decode(
      files["schemas.json"] ?? new TextEncoder().encode("[]"),
    ),
  );
  validateExtension(manifest, contracts);
  return { manifest, contracts, files, digest };
}
