import { it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";
import { packPlugin, verifyPackage } from "../server/plugin-packages";
import { manifestById } from "../packages/core/catalog";
it("verifies signed plugin artifacts and rejects unknown publishers and altered content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "taskasaur-plugin-"));
  try {
    const keys = generateKeyPairSync("ed25519"),
      privateKey = keys.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      publicKey = keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString();
    const manifest = {
      ...manifestById.get("tasks")!,
      id: "example.notes",
      publisher: "example",
      storage: { local: { mode: "dexie", collections: [] } },
      provides: { commands: [], events: [] },
      entrypoints: { server: "server.mjs" },
    };
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
    await writeFile(path.join(dir, "schemas.json"), "[]");
    await writeFile(
      path.join(dir, "server.mjs"),
      "export default {async activate(context){}};",
    );
    const artifact = await packPlugin(dir, privateKey);
    expect(
      (await verifyPackage(artifact, { example: publicKey })).manifest.id,
    ).toBe("example.notes");
    await expect(verifyPackage(artifact, {})).rejects.toMatchObject({
      kind: "UNTRUSTED_PUBLISHER",
    });
    const zip = await JSZip.loadAsync(artifact);
    zip.file("server.mjs", "changed");
    await expect(
      verifyPackage(await zip.generateAsync({ type: "nodebuffer" }), {
        example: publicKey,
      }),
    ).rejects.toMatchObject({ kind: "INTEGRITY_FAILED" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
