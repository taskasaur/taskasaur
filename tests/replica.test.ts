import { describe, it, expect } from "vitest";
import { createIdentity, publicIdentity } from "../packages/core/crypto";
import {
  createWorkspaceAccess,
  approveMember,
  acceptPolicies,
  revokeMember,
} from "../packages/core/identity";
import { Replica } from "../packages/core/replica";
import { MemoryStorage } from "../packages/storage";
async function pair(role: "editor" | "viewer" = "editor") {
  const alice = await createIdentity("Laptop"),
    bob = await createIdentity("Phone");
  let access = await createWorkspaceAccess(alice, "Test workspace");
  access = await approveMember(access, alice, publicIdentity(bob), role);
  const a = await new Replica(alice, access, new MemoryStorage()).open();
  const b = await new Replica(
    bob,
    await acceptPolicies(bob, access.policies),
    new MemoryStorage(),
  ).open();
  return { a, b };
}
async function exchange(a: Replica, b: Replica) {
  for (const change of a.entries()) await b.accept(change);
  for (const change of b.entries()) await a.accept(change);
}
describe("durable signed offline replicas", () => {
  it("binds identical content to separate documents and validates out-of-order changes", async () => {
    const { a, b } = await pair();
    await a.update("setting/first", { value: 1 });
    await a.update("setting/second", { value: 1 });
    await a.update("setting/first", { value: 2 });
    expect(new Set(a.hashes()).size).toBe(3);
    for (const change of a.entries().reverse()) await b.accept(change);
    expect(b.read("setting/first")).toEqual({ value: 2 });
    expect(b.read("setting/second")).toEqual({ value: 1 });
    expect(b.status().pending).toBe(0);
    const restored = await new Replica(b.identity, b.access, b.storage).open();
    expect(restored.read("setting/first")).toEqual({ value: 2 });
  });
  it("merges independent offline edits and retains same-field conflicts across restart", async () => {
    const { a, b } = await pair();
    await a.update("setting/example", {
      data: { title: "initial", status: "open" },
    });
    await exchange(a, b);
    await a.update("setting/example", {
      data: { title: "Laptop title", status: "open" },
    });
    await b.update("setting/example", {
      data: { title: "initial", status: "done" },
    });
    await exchange(a, b);
    expect(a.read("setting/example")).toEqual({
      data: { title: "Laptop title", status: "done" },
    });
    expect(b.read("setting/example")).toEqual(a.read("setting/example"));
    await a.update("setting/example", {
      data: { title: "Alice", status: "done" },
    });
    await b.update("setting/example", {
      data: { title: "Bob", status: "done" },
    });
    await exchange(a, b);
    expect(
      Object.values(a.conflicts("setting/example", "title", true)).sort(),
    ).toEqual(["Alice", "Bob"]);
    const restarted = await new Replica(a.identity, a.access, a.storage).open();
    expect(restarted.read("setting/example")).toEqual(
      a.read("setting/example"),
    );
    expect(
      Object.values(
        restarted.conflicts("setting/example", "title", true),
      ).sort(),
    ).toEqual(["Alice", "Bob"]);
  });
  it("rejects tampering, read-only writes, and unauthorized workspaces", async () => {
    const { a, b } = await pair("viewer");
    await a.update("setting/value", { value: 1 });
    await expect(b.update("setting/value", { value: 2 })).rejects.toThrow(
      "cannot edit",
    );
    await expect(
      b.accept({ ...a.entries()[0], documentId: "setting/forged" }),
    ).rejects.toThrow("signature");
    await expect(
      b.accept({ ...a.entries()[0], workspaceId: crypto.randomUUID() }),
    ).rejects.toThrow("envelope");
    await b.accept(a.entries()[0]);
    expect(b.read("setting/value")).toEqual({ value: 1 });
  });
  it("fences revoked offline edits while retaining approved historical changes", async () => {
    const { a, b } = await pair();
    await b.update("setting/approved", { value: 1 });
    await exchange(a, b);
    await b.update("setting/offline", { value: 2 });
    const access = await revokeMember(
      a.access,
      a.identity,
      b.identity.id,
      a
        .entries()
        .filter((e) => e.author === b.identity.id)
        .map((e) => e.hash),
    );
    await a.setPolicies(access.policies);
    await expect(a.accept(b.entries().at(-1)!)).rejects.toThrow("revoked");
    expect(a.read("setting/approved")).toEqual({ value: 1 });
    const restarted = await new Replica(a.identity, access, a.storage).open();
    expect(restarted.read("setting/approved")).toEqual({ value: 1 });
    await expect(acceptPolicies(b.identity, access.policies)).rejects.toThrow(
      "not a member",
    );
  });
  it("does not acknowledge a write whose durable save fails", async () => {
    const { a } = await pair();
    a.storage.set = async () => {
      throw Error("Disk full");
    };
    await expect(a.update("setting/not-saved", { value: 1 })).rejects.toThrow(
      "Disk full",
    );
    expect(a.read("setting/not-saved")).toBeUndefined();
    expect(a.hashes()).toHaveLength(0);
  });
});
