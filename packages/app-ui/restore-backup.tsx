import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { BrowserStorage } from "../platform-browser/storage";
import { NativeStorage } from "../platform-native/storage";
import { restoreBackup } from "../core/backup";
import { DeviceCore } from "../core/device";
import { saveProfile, type WorkspaceProfile } from "./runtime";
import { Button } from "../ui/primitives/button";
import {acquireWriter} from '../platform-browser/writer-lock';
export function RestoreBackup({
  onOpen,
}: {
  onOpen: (profile: WorkspaceProfile) => Promise<void>;
}) {
  const [file, setFile] = useState<File>(),
    [password, setPassword] = useState(""),
    [retired, setRetired] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <details className="mt-6">
      <summary className="cursor-pointer text-sm">
        Restore an encrypted device backup
      </summary>
      <div className="space-y-3 mt-3">
        <input
          aria-label="Device backup file"
          type="file"
          accept="application/json"
          onChange={(e) => setFile(e.target.files?.[0])}
        />
        <label className="field-row">
          Backup passphrase
          <input
            className="core-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={retired}
            onChange={(e) => setRetired(e.target.checked)}
          />
          The original device identity is retired and will stay offline. I am
          restoring into an empty profile.
        </label>
        {error && <p role="alert">{error}</p>}
        <Button
          disabled={busy || !file || password.length < 12 || !retired}
          onClick={async () => {
            setBusy(true);
            let release:(()=>void)|undefined;
            try {
              release=await acquireWriter();
              const storage =
                window.taskasaurNative?.storage ??
                (Capacitor.isNativePlatform()
                  ? new NativeStorage()
                  : new BrowserStorage());
              await restoreBackup(storage, await file!.text(), password);
              const core = await DeviceCore.open(storage, "Recovered device");
              let first: WorkspaceProfile | undefined;
              for (const link of core.profiles()) {
                const node = await core.workspace(link.id),
                  profile: WorkspaceProfile = {
                    id: link.id,
                    workspaceId: link.id,
                    userId: node.replica.member.userId,
                    name: link.name,
                    serverUrl: "",
                    connected: true,
                  };
                await saveProfile(profile);
                first ??= profile;
              }
              await core.close();
              release();release=undefined;
              if (first) await onOpen(first);
              else throw Error("Backup contains no workspace");
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              release?.();
              setBusy(false);
            }
          }}
        >
          Restore device
        </Button>
      </div>
    </details>
  );
}
