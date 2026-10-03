import { useState, useEffect, useSyncExternalStore } from "react";
import type { NativeInfo, NativeSettings } from "./network";
import { exportBackup } from "../core/backup";
import { assignService } from "../core/services";
import { download } from "./download";
import type { AppRuntime } from "./runtime";
import { currentPolicy, type Role } from "../core/identity";
import { Button } from "../ui/primitives/button";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
export function PeerDevicesView({ runtime }: { runtime: AppRuntime }) {
  useSyncExternalStore(
    (listener) => {
      runtime.surfaceListeners.add(listener);
      return () => {
        runtime.surfaceListeners.delete(listener);
      };
    },
    () => runtime.surfacesVersion,
    () => 0,
  );
  const [request, setRequest] = useState(""),
    [invitation, setInvitation] = useState(""),
    [role, setRole] = useState<Role>("editor"),
    [error, setError] = useState(""),
    [peers, setPeers] = useState(runtime.node.link.peers.join("\n")),
    [busy, setBusy] = useState(false);
  const policy = currentPolicy(runtime.node.replica.access),
    self = runtime.device.identity.id,
    status = runtime.node.replica.status();
  const [native, setNative] = useState<NativeInfo>(),
    [nativeInvitation, setNativeInvitation] = useState(""),
    [plugin, setPlugin] = useState(""),
    [target, setTarget] = useState(""),
    [passphrase, setPassphrase] = useState(""),
    [missing, setMissing] = useState(0);
  useEffect(() => {
    void window.taskasaurNative?.peer.info().then(setNative);
    void runtime.node.protocol.files
      .missing()
      .then((v) => setMissing(v.length));
  }, [runtime, runtime.surfacesVersion]);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
      runtime.notifySurfaces();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <p className="page-description">
        Each approved device stores a workspace copy. Computers can also provide
        terminal access and run automations when enabled on that computer.
      </p>
      <div className="settings-card">
        <p>
          {status.documents} local documents · {status.peers} online peers ·{" "}
          {status.pending} pending dependencies · {missing} file chunks still
          downloading
        </p>
        {status.quarantined > 0 && (
          <p role="alert">
            {status.quarantined} changes need membership review. The original
            changes are retained for recovery.
          </p>
        )}
        {status.error && <p className="text-sm">{status.error}</p>}
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Device</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Connection</TableHead>
            <TableHead>Capabilities</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.values(policy.members).map((member) => {
            const peer = runtime.node.peerDevices.get(member.identity.id),
              local = member.identity.id === self;
            return (
              <TableRow key={member.identity.id}>
                <TableCell>
                  {member.identity.name}
                  {local ? " (this device)" : ""}
                </TableCell>
                <TableCell>{member.role}</TableCell>
                <TableCell>
                  {local
                    ? "Local"
                    : peer && Date.now() - peer.lastSeen < 45000
                      ? "Online"
                      : "Offline"}
                </TableCell>
                <TableCell>
                  {local
                    ? "Local records and files"
                    : (peer?.capabilities.join(", ") ??
                      "Available when connected")}
                </TableCell>
                <TableCell>
                  {self === policy.owner.id && !local && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          runtime.device.revoke(
                            runtime.profile.workspaceId,
                            member.identity.id,
                          ),
                        )
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <section className="settings-card space-y-3">
        <h2>Automations in this app</h2>
        <p className="text-sm">
          Run on this device while the app is active. Checkpoints survive
          restarts. Phones and browsers pause execution when suspended.
        </p>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={runtime.automationOptions.enabled}
            onChange={(e) =>
              void act(() =>
                runtime.configureAutomation({
                  ...runtime.automationOptions,
                  enabled: e.target.checked,
                }),
              )
            }
          />
          Enable local automation execution
        </label>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={runtime.automationOptions.trustedCode}
            onChange={(e) =>
              void act(() =>
                runtime.configureAutomation({
                  ...runtime.automationOptions,
                  trustedCode: e.target.checked,
                }),
              )
            }
          />
          Allow trusted TypeScript code in an isolated worker
        </label>
      </section>
      {native && (
        <section className="settings-card space-y-3">
          <h2>This computer’s capabilities</h2>
          <p className="text-sm">
            These services keep running in the tray when you close the window.
            Quit Taskasaur to stop them.
          </p>
          {(
            [
              "terminal",
              "automation",
              "trustedCode",
              "background",
              "plugins",
            ] as const
          ).map((key) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={native.options[key]}
                disabled={busy}
                onChange={(e) =>
                  void act(async () => {
                    setNative(
                      await window.taskasaurNative!.peer.configure({
                        ...native.options,
                        [key]: e.target.checked,
                      }),
                    );
                  })
                }
              />
              {
                {
                  terminal: "Incoming terminal access",
                  automation: "Run automations",
                  trustedCode: "Run trusted TypeScript code",
                  background: "Scheduled plugin services",
                  plugins:
                    "Allow native plugin installation by workspace owners",
                }[key]
              }
            </label>
          ))}
          {!native.workspaces.includes(runtime.profile.workspaceId) && (
            <>
              <p>
                Ask the workspace owner to approve this computer’s background
                services identity.
              </p>
              <textarea
                readOnly
                className="core-input"
                value={native.request}
              />
              <label>
                Invitation for this computer
                <textarea
                  className="core-input"
                  value={nativeInvitation}
                  onChange={(e) => setNativeInvitation(e.target.value)}
                />
              </label>
              <Button
                disabled={busy || !nativeInvitation}
                onClick={() =>
                  void act(async () => {
                    await window.taskasaurNative!.peer.join(nativeInvitation);
                    await runtime.device.setPeers(runtime.profile.workspaceId, [
                      "local:desktop",
                      ...runtime.node.link.peers,
                    ]);
                    setNative(await window.taskasaurNative!.peer.info());
                    await runtime.synchronize();
                  })
                }
              >
                Link background services
              </Button>
            </>
          )}
        </section>
      )}
      <section className="settings-card space-y-3">
        <h2>Native plugin services</h2>
        <p className="text-sm">
          Choose the computer that handles external accounts and background
          work. It must explicitly allow native plugins. This installs the
          reviewed package and its dependencies there.
        </p>
        <label className="field-row">
          Plugin
          <select
            className="core-select"
            value={plugin}
            onChange={(e) => setPlugin(e.target.value)}
          >
            <option value="">Choose an installed plugin</option>
            {runtime.availablePlugins
              .filter(
                (p) =>
                  runtime.registry.enabled(p.id) &&
                  p.grants.includes("core.server"),
              )
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field-row">
          Computer
          <select
            className="core-select"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose a computer</option>
            {[...runtime.node.peerDevices.values()]
              .filter((p) => p.capabilities.includes("core.plugins.install"))
              .map((p) => (
                <option key={p.deviceId} value={p.deviceId}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        {plugin && (
          <p className="text-xs break-words">
            Permissions:{" "}
            {runtime.availablePlugins
              .find((p) => p.id === plugin)
              ?.grants.join(", ")}
          </p>
        )}
        <Button
          disabled={busy || !target || !plugin}
          onClick={() =>
            void act(async () => {
              const seen = new Set<string>();
              const install = async (id: string) => {
                if (seen.has(id)) return;
                seen.add(id);
                const entry = runtime.availablePlugins.find((p) => p.id === id);
                if (!entry) return;
                for (const dependency of entry.dependencies)
                  await install(dependency);
                await runtime.node.call(
                  "core.plugins.install",
                  {
                    id,
                    version: entry.version,
                    sha256: entry.sha256,
                    grants: entry.grants,
                  },
                  target,
                );
              };
              await install(plugin);
              await assignService(runtime.node, plugin, target);
              await runtime.synchronize();
            })
          }
        >
          Install and assign to this computer
        </Button>
      </section>
      <section className="settings-card space-y-3">
        <h2>Peer connections</h2>
        <p className="text-sm text-muted-foreground">
          Add an address from another approved device. For browser-to-browser
          connections, first connect both devices to a reachable relay.
          Background availability depends on the device.
        </p>
        <label className="field-row">
          Peer addresses
          <textarea
            className="core-input min-h-24 font-mono text-xs"
            value={peers}
            onChange={(e) => setPeers(e.target.value)}
            placeholder="/dns4/device.example/tcp/443/wss/p2p/…"
          />
        </label>
        <Button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await runtime.device.setPeers(
                runtime.profile.workspaceId,
                peers.split("\n"),
              );
              await runtime.synchronize();
            })
          }
        >
          Save and synchronize
        </Button>
        <label className="field-row">
          This device’s addresses
          <textarea
            readOnly
            className="core-input min-h-16 text-xs"
            value={
              runtime.device.transport?.addresses().join("\n") ||
              "No incoming address yet. Connect to a reachable peer or relay."
            }
          />
        </label>
      </section>
      {self === policy.owner.id && (
        <section className="settings-card space-y-3">
          <h2>Approve another device</h2>
          <p className="text-sm">
            On the other device, choose Join workspace and copy its device
            request here. The invitation can only be opened by that device.
          </p>
          <label className="field-row">
            Device request
            <textarea
              className="core-input min-h-24"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
            />
          </label>
          <label className="field-row">
            Access
            <select
              className="core-select"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              <option value="editor">Edit this workspace</option>
              <option value="viewer">Read this workspace</option>
            </select>
          </label>
          <Button
            disabled={busy || !request}
            onClick={() =>
              void act(async () => {
                setInvitation(
                  await runtime.device.approve(
                    runtime.profile.workspaceId,
                    request,
                    role,
                  ),
                );
              })
            }
          >
            Approve device
          </Button>
          {invitation && (
            <>
              <label className="field-row">
                Encrypted invitation
                <textarea
                  readOnly
                  className="core-input min-h-24"
                  value={invitation}
                />
              </label>
              <Button
                variant="outline"
                onClick={() =>
                  void act(() => navigator.clipboard.writeText(invitation))
                }
              >
                Copy invitation
              </Button>
            </>
          )}
        </section>
      )}
      <section className="settings-card space-y-3">
        <h2>Encrypted device backup</h2>
        <p className="text-sm">
          Includes locally saved records, files and this device’s recovery keys.
          Keep the passphrase separately. Restore only after retiring the
          original device identity; use pairing for an additional device.
        </p>
        <label className="field-row">
          Backup passphrase
          <input
            type="password"
            autoComplete="new-password"
            className="core-input"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </label>
        <Button
          disabled={busy || passphrase.length < 12}
          onClick={() =>
            void act(async () => {
              await runtime.node.replica.flush();
              download(
                "taskasaur-device-backup.json",
                new Blob(
                  [await exportBackup(runtime.device.storage, passphrase)],
                  { type: "application/json" },
                ),
              );
              setPassphrase("");
            })
          }
        >
          Download encrypted backup
        </Button>
      </section>
    </div>
  );
}
