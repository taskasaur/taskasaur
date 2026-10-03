import type { DurableStorage } from "../storage";
import { base64, unbase64, encrypt, decrypt, utf8, text } from "./crypto";
import { invariant } from "@taskasaur/platform/core/errors";
const context = "taskasaur-device-backup-v1";
async function key(password: string, salt: Uint8Array) {
  invariant(
    password.length >= 12,
    "WEAK_PASSPHRASE",
    "Use a backup passphrase of at least 12 characters",
  );
  const material = await crypto.subtle.importKey(
    "raw",
    utf8.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(salt),
      iterations: 600000,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function exportBackup(storage: DurableStorage, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    entries: Record<string, string> = {};
  invariant(
    storage.snapshot,
    "SNAPSHOT_UNAVAILABLE",
    "This storage adapter does not offer consistent snapshots",
  );
  for (const [name, bytes] of Object.entries(await storage.snapshot()))
    entries[name] = base64(bytes);
  return JSON.stringify({
    format: context,
    salt: base64(salt),
    ciphertext: await encrypt(
      await key(password, salt),
      utf8.encode(JSON.stringify(entries)),
      context,
    ),
  });
}
/** Restore to an empty store only. Keep the original device offline to avoid cloning a writer identity. */
export async function restoreBackup(
  storage: DurableStorage,
  backup: string,
  password: string,
) {
  invariant(
    !(await storage.keys("")).length,
    "STORAGE_NOT_EMPTY",
    "Restore into an empty device profile",
  );
  const input = JSON.parse(backup);
  invariant(
    input.format === context,
    "INVALID_BACKUP",
    "Unsupported backup format",
  );
  const entries = JSON.parse(
    text.decode(
      await decrypt(
        await key(password, unbase64(input.salt)),
        input.ciphertext,
        context,
      ),
    ),
  ) as Record<string, string>;
  invariant(
    typeof entries["device/identity"] === "string" &&
      typeof entries["device/workspaces"] === "string",
    "INVALID_BACKUP",
    "Backup identity is missing",
  );
  // Commit identity last so an interrupted import cannot be opened as a complete device.
  try {
    for (const [name, value] of Object.entries(entries).filter(
      ([name]) => name !== "device/identity",
    ))
      await storage.set(name, unbase64(value));
    await storage.set("device/identity", unbase64(entries["device/identity"]));
  } catch (error) {
    for (const name of await storage.keys("")) await storage.delete(name);
    throw error;
  }
}
