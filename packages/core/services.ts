import type { WorkspaceNode } from "./device";
import { canonical, digest, utf8 } from "./crypto";
import { LocalState } from "./local-state";
import { invariant } from "@taskasaur/platform/core/errors";
export async function serviceToken(value: object) {
  const binding = value as {
    resourceId?: string;
    slot?: string;
    enabled?: boolean;
  };
  const { enabled, ...stable } = binding;
  return digest(
    utf8.encode(canonical(binding.resourceId && binding.slot ? stable : value)),
  );
}
export async function assignedService(node: WorkspaceNode, id: string) {
  const assignment = node.replica.read<{ deviceId: string }>(
    "setting/service." + id,
  );
  return Boolean(
    assignment?.deviceId === node.replica.identity.id &&
    (assignment as { enabled?: boolean }).enabled !== false &&
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
  successor?: { deviceId: string; generation: string },
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
  const key = `setting/service-release.${id}.${token}`;
  const previous = node.replica.read<{ successor?: unknown }>(key);
  invariant(
    !previous ||
      canonical(previous.successor ?? null) === canonical(successor ?? null),
    "SERVICE_CHANGED",
    "This item was already released to another assignment",
  );
  await new LocalState(node.replica, "released-services").set(token, {
    released: true,
  });
  await drain();
  if (!node.replica.read(key))
    await node.replica.update(key, {
      deviceId: node.replica.identity.id,
      token,
      ...(successor ? { successor } : {}),
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
