/** Portable cryptography: standard WebCrypto primitives; no Node/browser imports. */
export const utf8 = new TextEncoder();
export const text = new TextDecoder();
export function base64(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export interface Identity {
  id: string;
  name: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  encryptionPublicKey: JsonWebKey;
  encryptionPrivateKey: JsonWebKey;
}
export type PublicIdentity = Pick<
  Identity,
  "id" | "name" | "publicKey" | "encryptionPublicKey"
>;
export async function createIdentity(name: string): Promise<Identity> {
  const signing = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const encryption = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", signing.publicKey);
  return {
    id: await keyId(publicKey),
    name,
    publicKey,
    privateKey: await crypto.subtle.exportKey("jwk", signing.privateKey),
    encryptionPublicKey: await crypto.subtle.exportKey(
      "jwk",
      encryption.publicKey,
    ),
    encryptionPrivateKey: await crypto.subtle.exportKey(
      "jwk",
      encryption.privateKey,
    ),
  };
}
export async function keyId(key: JsonWebKey) {
  return digest(
    utf8.encode(canonical({ kty: key.kty, crv: key.crv, x: key.x, y: key.y })),
  );
}
export function publicIdentity(identity: Identity): PublicIdentity {
  const { id, name, publicKey, encryptionPublicKey } = identity;
  return { id, name, publicKey, encryptionPublicKey };
}
export async function sign(key: JsonWebKey, value: unknown) {
  const imported = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return base64(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        imported,
        utf8.encode(canonical(value)),
      ),
    ),
  );
}
export async function verify(
  key: JsonWebKey,
  value: unknown,
  signature: string,
) {
  try {
    const imported = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      imported,
      unbase64(signature),
      utf8.encode(canonical(value)),
    );
  } catch {
    return false;
  }
}
export const randomKey = () =>
  base64(crypto.getRandomValues(new Uint8Array(32)));
export async function encrypt(
  key: string | CryptoKey,
  value: Uint8Array,
  context: string,
) {
  const imported =
    typeof key === "string"
      ? await crypto.subtle.importKey("raw", unbase64(key), "AES-GCM", false, [
          "encrypt",
        ])
      : key;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8.encode(context) },
    imported,
    new Uint8Array(value),
  );
  return base64(iv) + "." + base64(new Uint8Array(ciphertext));
}
export async function decrypt(
  key: string | CryptoKey,
  value: string,
  context: string,
) {
  const imported =
    typeof key === "string"
      ? await crypto.subtle.importKey("raw", unbase64(key), "AES-GCM", false, [
          "decrypt",
        ])
      : key;
  const [iv, ciphertext] = value.split(".");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unbase64(iv),
        additionalData: utf8.encode(context),
      },
      imported,
      unbase64(ciphertext),
    ),
  );
}
async function sharedKey(privateKey: JsonWebKey, publicKey: JsonWebKey) {
  const own = await crypto.subtle.importKey(
    "jwk",
    privateKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"],
  );
  const other = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: other },
    own,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(
  sender: Identity,
  recipient: PublicIdentity,
  value: unknown,
  context: string,
) {
  return encrypt(
    await sharedKey(sender.encryptionPrivateKey, recipient.encryptionPublicKey),
    utf8.encode(canonical(value)),
    context,
  );
}
export async function unseal(
  recipient: Identity,
  sender: PublicIdentity,
  value: string,
  context: string,
) {
  return JSON.parse(
    text.decode(
      await decrypt(
        await sharedKey(
          recipient.encryptionPrivateKey,
          sender.encryptionPublicKey,
        ),
        value,
        context,
      ),
    ),
  );
}
