import { it, expect } from "vitest";
import { DeviceCore } from "../packages/core/device";
import { MemoryStorage, snapshotStorage } from "../packages/storage";
import {
  exportWorkspace,
  openWorkspaceArchive,
  importWorkspace,
} from "../packages/core/workspace-package";
import { currentPolicy } from "../packages/core/identity";
import { PeerSync, type PeerPacket } from "../packages/sync/protocol";
const device = (name: string) =>
  DeviceCore.open(snapshotStorage(new MemoryStorage()), name);
it("opens an optionally encrypted file with scoped connection and plugin credentials on independent devices", async () => {
  const owner = await device("Owner"),
    a = await owner.createWorkspace("Portable access");
  const row = await a.records.put("variables", {
    name: "Shared",
    value_type: "text",
    value: "initial",
  });
  const secret = await a.records.put("credentials", {
    name: "Mail",
    provider: "generic",
    allowed_plugins: ["mail"],
    allowed_destinations: ["https://example.test"],
  });
  await a.vault.set(secret.id, { password: "plugin-secret" });
  const bytes = await exportWorkspace(a, {
    includeCredentials: true,
    password: "workspace password",
  });
  await expect(openWorkspaceArchive(bytes)).rejects.toThrow(
    "workspace password",
  );
  await expect(openWorkspaceArchive(bytes, "wrong password")).rejects.toThrow(
    "Incorrect workspace password",
  );
  const left = await device("Left"),
    right = await device("Right");
  const b = await importWorkspace(
    left,
    await openWorkspaceArchive(bytes, "workspace password"),
  );
  const c = await importWorkspace(
    right,
    await openWorkspaceArchive(bytes, "workspace password"),
  );
  expect(left.identity.id).not.toBe(owner.identity.id);
  expect(left.identity.id).not.toBe(right.identity.id);
  await expect(
    b.vault.use(
      secret.id,
      "mail",
      "https://example.test",
      async (secret) => secret.password,
    ),
  ).resolves.toBe("plugin-secret");
  await b.records.put("variables", { ...row.data, value: "left edit" }, row.id);
  await c.records.put("variables", { ...row.data, name: "Right name" }, row.id);
  const peers = new Map([
    ["owner", a],
    ["left", b],
    ["right", c],
  ]);
  const transport = {
    addresses: () => [],
    close: async () => {},
    request: async (address: string, packet: PeerPacket) =>
      peers.get(address)!.protocol.receive(packet),
  };
  await new PeerSync(b.protocol, transport).synchronize("owner");
  await new PeerSync(c.protocol, transport).synchronize("owner");
  await new PeerSync(b.protocol, transport).synchronize("owner");
  expect(a.records.get(row.id)?.data).toMatchObject({
    name: "Right name",
    value: "left edit",
  });
  expect(a.replica.heads("record/" + row.id)).toEqual(
    b.replica.heads("record/" + row.id),
  );
  const credentialId = currentPolicy(b.replica.access).members[left.identity.id]
    .delegatedBy!;
  await owner.revoke(a.replica.workspaceId, credentialId);
  await expect(
    a.protocol.receive(await b.protocol.pack({ kind: "capabilities" })),
  ).rejects.toThrow();
  const plain = await exportWorkspace(a, { includeCredentials: true });
  const fourth = await device("Fourth");
  const restored = await importWorkspace(
    fourth,
    await openWorkspaceArchive(plain),
  );
  expect(restored.replica.identity.id).toBe(fourth.identity.id);
  await owner.close();
  await left.close();
  await right.close();
  await fourth.close();
});

it("requires approval without exported access and rejects forged, foreign and escalated connection grants", async () => {
  const { delegateDevice, validateDelegations, acceptPolicies } =
    await import("../packages/core/identity");
  const { createIdentity, publicIdentity, sign } =
    await import("../packages/core/crypto");
  const owner = await device("Owner"),
    newcomer = await device("Newcomer");
  try {
    const node = await owner.createWorkspace("Private");
    const noAccess = await openWorkspaceArchive(await exportWorkspace(node));
    expect(noAccess.manifest.connectionCredential).toBeUndefined();
    await expect(importWorkspace(newcomer, noAccess)).rejects.toThrow(
      "Approve this device",
    );
    const archive = await openWorkspaceArchive(
      await exportWorkspace(node, { includeCredentials: true }),
    );
    const credential = archive.manifest.connectionCredential!;
    expect(credential.id).not.toBe(owner.identity.id);
    const access = await acceptPolicies(
      credential,
      node.replica.access.policies,
    );
    const grant = await delegateDevice(
      credential,
      access,
      publicIdentity(newcomer.identity),
    );
    await validateDelegations(access.policies, [grant]);
    const { signature, ...body } = grant;
    const foreign = { ...body, workspaceId: crypto.randomUUID() };
    await expect(
      validateDelegations(access.policies, [
        { ...foreign, signature: await sign(credential.privateKey, foreign) },
      ]),
    ).rejects.toThrow("Invalid workspace connection grant");
    const escalated = { ...body, role: "owner" };
    await expect(
      validateDelegations(access.policies, [
        {
          ...escalated,
          signature: await sign(credential.privateKey, escalated),
        } as typeof grant,
      ]),
    ).rejects.toThrow("Invalid workspace connection grant");
    const impostor = await createIdentity("Impostor");
    await expect(
      validateDelegations(access.policies, [
        { ...grant, signature: await sign(impostor.privateKey, body) },
      ]),
    ).rejects.toThrow("Invalid workspace connection grant");
    await owner.revoke(node.replica.workspaceId, credential.id);
    await expect(
      acceptPolicies(
        newcomer.identity,
        node.replica.access.policies,
        undefined,
        credential,
        [grant],
      ),
    ).rejects.toThrow();
  } finally {
    await owner.close();
    await newcomer.close();
  }
});

it("keeps live writes encrypted and never stores the file password in workspace entries", async () => {
  const { ArchiveWorkspaceFiles } =
    await import("../packages/storage/workspace-archive");
  const { WorkspaceStorage } = await import("../packages/storage/workspace");
  const { workspaceSnapshot } =
    await import("../packages/core/workspace-package");
  const { encryptedWorkspace } =
    await import("../packages/core/workspace-encryption");
  const { utf8 } = await import("../packages/core/crypto");
  const owner = await device("Owner");
  let disk: Uint8Array | undefined;
  const io = {
    read: async () => disk,
    replace: async (value: Uint8Array) => {
      disk = value.slice();
    },
  };
  try {
    const node = await owner.createWorkspace("Encrypted"),
      snapshot = await workspaceSnapshot(node, { includeCredentials: true });
    const files = await ArchiveWorkspaceFiles.open(
      io,
      true,
      "live file password",
    );
    const workspace = await WorkspaceStorage.create(
      files,
      snapshot.workspace,
      snapshot.entries,
      snapshot.connectionCredential,
    );
    const first = disk!;
    const blobKey = `workspace/${node.replica.workspaceId}/blobs/${"a".repeat(64)}`;
    await workspace.set(blobKey, utf8.encode("live content"));
    expect(encryptedWorkspace(disk!)).toBe(true);
    expect(disk).not.toEqual(first);
    await workspace.close();
    await expect(ArchiveWorkspaceFiles.open(io)).rejects.toThrow(
      "workspace password",
    );
    const reopened = await WorkspaceStorage.open(
      await ArchiveWorkspaceFiles.open(io, false, "live file password"),
    );
    expect(await reopened.get(blobKey)).toEqual(utf8.encode("live content"));
    expect(JSON.stringify(reopened.manifest)).not.toContain(
      "live file password",
    );
    expect(
      Object.keys(reopened.manifest.entries).some((key) =>
        key.includes("/local/"),
      ),
    ).toBe(false);
    await reopened.close();
  } finally {
    await owner.close();
  }
});
