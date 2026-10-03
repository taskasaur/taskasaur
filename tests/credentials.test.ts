import { it, expect, vi } from "vitest";
import { DeviceCore } from "../packages/core/device";
import { MemoryStorage } from "../packages/storage";
it("shares secrets only with approved recipients and refreshes on one credential authority", async () => {
  const owner = await DeviceCore.open(new MemoryStorage(), "Owner"),
    recipient = await DeviceCore.open(new MemoryStorage(), "Recipient"),
    outsider = await DeviceCore.open(new MemoryStorage(), "Other device"),
    a = await owner.createWorkspace("Credentials");
  const b = await recipient.join(
    await owner.approve(a.replica.workspaceId, recipient.pairingRequest()),
  );
  await outsider.join(
    await owner.approve(a.replica.workspaceId, outsider.pairingRequest()),
  );
  const record = await a.records.put("credentials", {
    name: "Mail",
    provider: "example",
    auth_kind: "oauth2",
    allowed_plugins: ["email-client"],
    allowed_destinations: [
      "https://mail.example/",
      "https://auth.example/token",
    ],
  });
  await a.vault.set(
    record.id,
    {
      access_token: "old",
      refresh_token: "refresh",
      token_endpoint: "https://auth.example/token",
      expires_at: new Date(Date.now() - 60000).toISOString(),
    },
    [recipient.identity.id],
  );
  const c = await outsider.workspace(a.replica.workspaceId);
  await b.replica.setPolicies(a.replica.access.policies);
  for (const change of a.replica.entries()) {
    await b.replica.accept(change);
    await c.replica.accept(change);
  }
  await expect(
    c.vault.use(
      record.id,
      "email-client",
      "https://mail.example/",
      async () => null,
    ),
  ).rejects.toThrow("Approve this device");
  await expect(
    a.vault.use(record.id, "tasks", "https://mail.example/", async () => null),
  ).rejects.toThrow("plugin");
  await expect(
    a.vault.use(
      record.id,
      "email-client",
      "https://bad.example/",
      async () => null,
    ),
  ).rejects.toThrow("destination");
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(
      JSON.stringify({ access_token: "renewed", expires_in: 3600 }),
    );
  });
  try {
    const values = await Promise.all([
      a.vault.use(
        record.id,
        "email-client",
        "https://mail.example/",
        async (secret) => secret.access_token,
      ),
      a.vault.use(
        record.id,
        "email-client",
        "https://mail.example/",
        async (secret) => secret.access_token,
      ),
    ]);
    expect(values).toEqual(["renewed", "renewed"]);
    expect(calls).toBe(1);
    for (const change of a.replica.entries()) await b.replica.accept(change);
    expect(
      await b.vault.use(
        record.id,
        "email-client",
        "https://mail.example/",
        async (secret) => secret.access_token,
      ),
    ).toBe("renewed");
  } finally {
    vi.unstubAllGlobals();
  }
});
