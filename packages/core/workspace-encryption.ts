import { utf8 } from "./crypto";
import { invariant } from "@taskasaur/platform/core/errors";
const magic = utf8.encode("TASKASAUR-ENCRYPTED-1\n");
export const encryptedWorkspace = (bytes: Uint8Array) =>
  magic.every((byte, index) => bytes[index] === byte);
async function key(password: string, salt: Uint8Array) {
  invariant(
    password.length >= 8,
    "WEAK_PASSPHRASE",
    "Use a workspace password of at least 8 characters",
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
export async function encryptWorkspace(bytes: Uint8Array, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: magic },
      await key(password, salt),
      new Uint8Array(bytes),
    ),
  );
  const output = new Uint8Array(
    magic.length + salt.length + iv.length + ciphertext.length,
  );
  output.set(magic);
  output.set(salt, magic.length);
  output.set(iv, magic.length + salt.length);
  output.set(ciphertext, magic.length + salt.length + iv.length);
  return output;
}
export async function decryptWorkspace(bytes: Uint8Array, password?: string) {
  if (!encryptedWorkspace(bytes)) return bytes;
  invariant(password, "PASSWORD_REQUIRED", "Enter the workspace password");
  invariant(
    bytes.length > magic.length + 44,
    "INVALID_WORKSPACE",
    "Encrypted workspace is incomplete",
  );
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.slice(magic.length + 16, magic.length + 28),
          additionalData: magic,
        },
        await key(password, bytes.slice(magic.length, magic.length + 16)),
        bytes.slice(magic.length + 28),
      ),
    );
  } catch {
    throw Object.assign(Error("Incorrect workspace password or damaged file"), {
      kind: "INCORRECT_PASSWORD",
    });
  }
}
