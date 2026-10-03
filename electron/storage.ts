import { safeStorage } from "electron";
import { FileStorage } from "../packages/platform-node/storage";
import { base64, unbase64, utf8, text } from "../packages/core/crypto";
/** OS keychain protects identity/transport keys. Workspace journals already use AES-GCM. */
export class DesktopStorage extends FileStorage {
  private sensitive(key: string) {
    return key === "device/identity" || key === "network/private-key";
  }
  async get(key: string) {
    const saved = await super.get(key);
    if (!saved || !this.sensitive(key)) return saved;
    const value = text.decode(saved);
    return value.startsWith("os:")
      ? unbase64(
          safeStorage.decryptString(Buffer.from(value.slice(3), "base64")),
        )
      : saved;
  }
  async set(key: string, value: Uint8Array) {
    if (this.sensitive(key)) {
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === "linux" &&
          safeStorage.getSelectedStorageBackend() === "basic_text")
      )
        throw Error(
          "Unlock the operating-system keyring before opening Taskasaur.",
        );
      return super.set(
        key,
        utf8.encode(
          "os:" + safeStorage.encryptString(base64(value)).toString("base64"),
        ),
      );
    }
    return super.set(key, value);
  }
}
