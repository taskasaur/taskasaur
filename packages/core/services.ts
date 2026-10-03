import type { WorkspaceNode } from "./device";
import { canonical, digest, utf8 } from "./crypto";
import { LocalState } from "./local-state";
import { invariant } from "@taskasaur/platform/core/errors";
export async function serviceToken(value: Record<string, unknown>) {
  return digest(utf8.encode(canonical(value)));
}
export async function assignedService(node: WorkspaceNode, id: string) {
  const assignment = node.replica.read<{ deviceId: string }>(
    "setting/service." + id,
  );
  return Boolean(
    assignment?.deviceId === node.replica.identity.id &&
    !(await new LocalState(node.replica, "released-services").get(
      await serviceToken(assignment),
    )),
  );
}
export async function releaseService(
  node: WorkspaceNode,
  id: string,
  token: string,
  drain: () => Promise<void> = async () => {},
) {
  const assignment = node.replica.read<{ deviceId: string }>(
    "setting/service." + id,
  );
  invariant(
    assignment?.deviceId === node.replica.identity.id &&
      (await serviceToken(assignment)) === token,
    "SERVICE_CHANGED",
    "Service assignment changed",
  );
  await new LocalState(node.replica, "released-services").set(token, {
    released: true,
  });
  await drain();
  const key = `setting/service-release.${id}.${token}`;
  if (!node.replica.read(key))
    await node.replica.update(key, {
      deviceId: node.replica.identity.id,
      token,
    });
}
export async function assignService(
  node: WorkspaceNode,
  id: string,
  deviceId: string,
) {
  const key = "setting/service." + id,
    previous = node.replica.read<{ deviceId: string }>(key);
  if (previous?.deviceId === deviceId) return;
  if (previous) {
    const token = await serviceToken(previous);
    await node.call("core.services.release", { id, token }, previous.deviceId);
    await node.synchronize();
  }
  await node.replica.update(key, { deviceId, generation: crypto.randomUUID() });
}
