import { it, expect } from "vitest";
import { SyncQueue } from "../packages/sync/queue";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("flushes writes added after an in-flight synchronization snapshot", async () => {
  const queue = new SyncQueue();
  const gate = deferred();
  const pending = ["first"];
  const saved: string[] = [];
  let passes = 0;
  const pass = async () => {
    passes++;
    const batch = pending.splice(0);
    if (passes === 1) await gate.promise;
    saved.push(...batch);
  };
  const background = queue.run(pass);
  pending.push("saved during sync");
  const manual = queue.run(pass);
  expect(manual).toBe(background);
  gate.resolve();
  await manual;
  expect(saved).toEqual(["first", "saved during sync"]);
  expect(passes).toBe(2);
});

it("reports transport failures to joined callers and permits a later retry", async () => {
  const queue = new SyncQueue();
  const gate = deferred();
  const failed = queue.run(() => gate.promise);
  const joined = queue.run(() => gate.promise);
  gate.reject(new Error("Network unavailable"));
  await expect(failed).rejects.toThrow("Network unavailable");
  await expect(joined).rejects.toThrow("Network unavailable");
  await expect(queue.run(async () => {})).resolves.toBeUndefined();
});
