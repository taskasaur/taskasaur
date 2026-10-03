import type { WorkspaceNode } from "./device";
import { currentPolicy } from "./identity";
import { deviceRecordId } from "./records";
import { canonical } from "./crypto";
import { assignedService, serviceToken } from "./services";
import { peerService } from "./peer-service";
import { getSchema, manifestById } from "@taskasaur/platform/core/catalog";
import { invariant } from "@taskasaur/platform/core/errors";
import { allNodes, validateGraph } from "@taskasaur/platform/core/workflows";
import {
  executionDefinitionSchema,
  type ExecutionSlot,
  type ExecutionBinding,
  type ExecutionState,
  type DevicePluginStatus,
} from "@taskasaur/platform/plugin-sdk/execution";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";

// Compatibility declarations for already signed v1 packages; package bytes stay unchanged.
const legacy: Record<string, unknown[]> = {
  "automation-runtime": [
    {
      id: "run",
      collection: "workflows",
      label: "Automation execution",
      targetField: "target_device_id",
      enabledField: "enabled",
      plugins: [{ id: "automation-runtime" }],
      capabilities: ["automation.execute"],
      commands: ["automation.run"],
      routes: ["automation/run", "automation/webhook"],
    },
  ],
  "email-client": [
    {
      id: "account",
      collection: "mail_accounts",
      label: "Email account execution",
      plugins: [{ id: "email-client" }],
      capabilities: ["core.http", "plugins.native", "background.execute"],
      commands: [
        "mail.sync",
        "mail.read",
        "mail.send",
        "mail.folders",
        "mail.applyOperation",
      ],
      routes: [
        "mail/sync",
        "mail/read",
        "mail/send",
        "mail/folders",
        "mail/applyOperation",
      ],
      references: [
        { collection: "mail", field: "account_id" },
        { collection: "mail_operations", field: "account_id" },
        { collection: "mailboxes", field: "account_id" },
      ],
    },
  ],
  "connector-github": [
    {
      id: "repository",
      collection: "github_connections",
      label: "Repository execution",
      plugins: [{ id: "connector-github" }],
      capabilities: ["core.http"],
      routes: ["github/sync"],
      references: [{ collection: "github_issues", field: "connection_id" }],
    },
  ],
};
export function executionSlots(pluginId?: string): ExecutionSlot[] {
  return [...manifestById.values()]
    .filter((m) => !pluginId || m.id === pluginId)
    .flatMap((m) =>
      (
        m.execution ??
        (m.publisher === "taskasaur" && m.version === "1.0.0"
          ? (legacy[m.id] ?? [])
          : [])
      ).map((d) => ({ ...executionDefinitionSchema.parse(d), pluginId: m.id })),
    );
}
export function slotFor(record: ResourceRecord, slotId?: string) {
  return executionSlots(record.pluginId).find(
    (s) => s.collection === record.collection && (!slotId || s.id === slotId),
  );
}
export const executionServiceId = (slot: ExecutionSlot, resourceId: string) =>
  `execution.${resourceId}.${slot.id}`;
export function bindingFor(
  node: WorkspaceNode,
  slot: ExecutionSlot,
  id: string,
) {
  const key = "setting/service." + executionServiceId(slot, id);
  for (const field of ["deviceId", "generation", "enabled"])
    invariant(
      new Set(Object.values(node.replica.conflicts(key, field)).map(canonical))
        .size <= 1,
      "EXECUTION_CONFLICT",
      "Resolve the conflicting computer assignments before executing this item",
    );
  return node.replica.read<ExecutionBinding>(key);
}
export function executionRequirements(
  slot: ExecutionSlot,
  record: ResourceRecord,
) {
  const plugins = [{ id: slot.pluginId }, ...slot.plugins],
    capabilities = [
      ...slot.capabilities,
      ...(slot.background ? ["background.execute"] : []),
    ];
  if (record.collection === "workflows") {
    // Incomplete drafts can still choose a runner. Publishing validates the graph.
    let steps: ReturnType<typeof allNodes> = [];
    try {
      steps = allNodes(validateGraph(record.data.graph));
    } catch {}
    for (const step of steps) {
      if (step.type === "typescript")
        capabilities.push("automation.typescript");
      if (step.type === "command") {
        const command = String(step.config.command);
        const provider = [...manifestById.values()].find((m) =>
          m.provides.commands.includes(command),
        );
        plugins.push({
          id:
            provider?.id ??
            (command.startsWith("mail.")
              ? "email-client"
              : command.split(".")[0]),
        });
      }
    }
  }
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of manifestById.get(id)?.dependencies ?? []) {
      plugins.push({ id: dep });
      visit(dep);
    }
  };
  for (const p of [...plugins]) visit(p.id);
  const required = new Map<string, { id: string; version?: string }>();
  for (const plugin of plugins) {
    const old = required.get(plugin.id);
    invariant(
      !old?.version || !plugin.version || old.version === plugin.version,
      "PLUGIN_VERSION_CONFLICT",
      "Execution requirements contain conflicting plugin versions",
    );
    required.set(plugin.id, {
      id: plugin.id,
      ...(plugin.version || old?.version
        ? { version: plugin.version ?? old?.version }
        : {}),
    });
  }
  return {
    plugins: [...required.values()],
    capabilities: [...new Set(capabilities)],
  };
}
export async function inspectExecution(
  node: WorkspaceNode,
  record: ResourceRecord,
  slot: ExecutionSlot,
): Promise<ExecutionState> {
  const requirements = executionRequirements(slot, record),
    binding = bindingFor(node, slot, record.id);
  const candidates = await Promise.all(
    (await peerService(node).list())
      .filter(
        (peer) =>
          currentPolicy(node.replica.access).members[peer.id]?.role !==
          "viewer",
      )
      .map(async (peer) => {
        let status: DevicePluginStatus | undefined, error: string | undefined;
        if (peer.online)
          try {
            status = (await node.call(
              "core.plugins.status",
              {},
              peer.id,
            )) as DevicePluginStatus;
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
        const plugins = status?.plugins ?? [];
        const missingPlugins = requirements.plugins.flatMap((required) => {
          const state = plugins.find((p) => p.id === required.id);
          const reason = !state?.installed
            ? "missing"
            : !state.enabled
              ? "disabled"
              : state.error
                ? "failed"
                : required.version && state.version !== required.version
                  ? "version"
                  : undefined;
          return reason
            ? [
                {
                  ...required,
                  reason: reason as
                    "missing" | "disabled" | "failed" | "version",
                },
              ]
            : [];
        });
        const capabilities = status?.capabilities ?? peer.capabilities;
        const missingCapabilities = requirements.capabilities.filter(
          (c) => !capabilities.includes(c),
        );
        return {
          ...peer,
          capabilities,
          plugins,
          missingPlugins,
          missingCapabilities,
          statusKnown: Boolean(status),
          ready: Boolean(
            peer.online &&
            status &&
            !missingPlugins.length &&
            !missingCapabilities.length,
          ),
          canInstall: Boolean(status?.canInstall),
          ...(error ? { error } : {}),
        };
      }),
  );
  return {
    ...(binding ? { binding } : {}),
    candidates,
    configured: Boolean(binding),
    enabled: binding?.enabled ?? false,
    targetDeviceId: binding ? deviceRecordId(binding.deviceId) : null,
  };
}
export async function configureExecution(
  node: WorkspaceNode,
  record: ResourceRecord,
  slot: ExecutionSlot,
  deviceId: string,
  enabled: boolean,
): Promise<ExecutionBinding> {
  invariant(
    node.records.canWrite(),
    "PERMISSION_DENIED",
    "This workspace is read-only",
  );
  invariant(
    !record.deletedAt &&
      record.pluginId === slot.pluginId &&
      record.collection === slot.collection,
    "INVALID_EXECUTION",
    "Execution slot does not belong to this item",
  );
  const member = Object.values(currentPolicy(node.replica.access).members).find(
    (m) =>
      m.identity.id === deviceId || deviceRecordId(m.identity.id) === deviceId,
  );
  invariant(
    member && member.role !== "viewer",
    "INVALID_EXECUTION_TARGET",
    "Select an approved device with workspace write access",
  );
  const id = executionServiceId(slot, record.id),
    key = "setting/service." + id,
    previous = bindingFor(node, slot, record.id);
  const next: ExecutionBinding = {
    resourceId: record.id,
    pluginId: record.pluginId,
    collection: record.collection,
    slot: slot.id,
    deviceId: member.identity.id,
    enabled,
    generation: crypto.randomUUID(),
  };
  if (previous) {
    const release = node.replica.read<{
      successor?: { deviceId: string; generation: string };
    }>(`setting/service-release.${id}.${await serviceToken(previous)}`);
    if (release) {
      invariant(
        release.successor?.deviceId === next.deviceId,
        "SERVICE_CHANGED",
        "Finish the pending move before changing this item again",
      );
      next.generation = release.successor.generation;
    }
  }
  if (previous?.deviceId !== next.deviceId && previous) {
    await node.call(
      "core.services.release",
      {
        id,
        token: await serviceToken(previous),
        successor: { deviceId: next.deviceId, generation: next.generation },
      },
      previous.deviceId,
    );
    await node.synchronize();
  }
  if (previous?.deviceId === next.deviceId)
    next.generation = previous.generation;
  await node.replica.update(key, next as unknown as Record<string, unknown>);
  if (slot.targetField || slot.enabledField) {
    const latest = node.records.get(record.id)!;
    await node.records.put(
      record.collection,
      {
        ...latest.data,
        ...(slot.targetField
          ? { [slot.targetField]: deviceRecordId(next.deviceId) }
          : {}),
        ...(slot.enabledField ? { [slot.enabledField]: enabled } : {}),
      },
      record.id,
    );
  }
  return next;
}
export async function executionActive(
  node: WorkspaceNode,
  record: ResourceRecord,
  slot = slotFor(record),
): Promise<boolean> {
  if (!slot) return false;
  try {
    const binding = bindingFor(node, slot, record.id);
    return Boolean(
      binding?.enabled &&
      !record.deletedAt &&
      (!slot.enabledField || record.data[slot.enabledField] === true) &&
      (!slot.targetField ||
        record.data[slot.targetField] === deviceRecordId(binding.deviceId)) &&
      (await assignedService(node, executionServiceId(slot, record.id))),
    );
  } catch {
    return false;
  }
}
export async function requireExecution(
  node: WorkspaceNode,
  record: ResourceRecord,
  slot = slotFor(record),
) {
  invariant(
    slot,
    "EXECUTION_UNDECLARED",
    "This item has no execution declaration",
  );
  const binding = bindingFor(node, slot, record.id);
  invariant(
    binding,
    "EXECUTION_UNASSIGNED",
    "Choose an execution computer for this item",
  );
  invariant(
    binding.enabled &&
      (!slot.enabledField || record.data[slot.enabledField] === true),
    "EXECUTION_PAUSED",
    "Execution is turned off for this item",
  );
  invariant(
    await executionActive(node, record, slot),
    "WRONG_EXECUTION_TARGET",
    "This item must execute on its assigned computer",
  );
  return binding;
}
/** Route a child operation through its declared parent account/item. No peer fallback. */
export function executionRecord(
  node: WorkspaceNode,
  operation: string,
  input: unknown,
) {
  const id = (input as { id?: string } | undefined)?.id;
  if (!id) return undefined;
  const source = node.records.get(id);
  if (!source) return undefined;
  for (const slot of executionSlots()) {
    if (
      !slot.commands.includes(operation) &&
      slot.background?.command !== operation &&
      !slot.routes.includes(operation)
    )
      continue;
    if (source.collection === slot.collection) return { record: source, slot };
    const reference = slot.references.find(
      (r) => r.collection === source.collection,
    );
    const record =
      reference && node.records.get(String(source.data[reference.field]));
    if (record?.collection === slot.collection) return { record, slot };
  }
}

export function executionService(
  node: WorkspaceNode,
  pluginId: string,
  grants: string[] = [],
) {
  const resource = (id: string, slotId: string | undefined, write = false) => {
    const record = node.records.get(id);
    invariant(
      record && !record.deletedAt,
      "NOT_FOUND",
      "Execution item not found",
    );
    const manifest = manifestById.get(pluginId);
    invariant(
      record.pluginId === pluginId ||
        (manifest?.consumes.commands.includes(
          `${record.collection}.${write ? "put" : "list"}`,
        ) &&
          grants.includes(`${record.collection}.${write ? "put" : "list"}`)),
      "UNDECLARED_COLLECTION",
      "Declare access to this execution item",
    );
    const slot = slotFor(record, slotId);
    invariant(
      slot,
      "EXECUTION_UNDECLARED",
      "This item does not declare execution",
    );
    return { record, slot };
  };
  return {
    definitions: () => executionSlots(pluginId),
    inspect: (id: string, slotId?: string) => {
      const { record, slot } = resource(id, slotId);
      return inspectExecution(node, record, slot);
    },
    configure: (
      id: string,
      options: { slotId?: string; deviceId: string; enabled: boolean },
    ) => {
      const { record, slot } = resource(id, options.slotId, true);
      return configureExecution(
        node,
        record,
        slot,
        options.deviceId,
        options.enabled,
      );
    },
  };
}

export function executionForResource(
  node: WorkspaceNode,
  pluginId: string,
  id: string,
) {
  const record = node.records.get(id);
  if (!record) return undefined;
  for (const slot of executionSlots(pluginId)) {
    if (record.collection === slot.collection) return { record, slot };
    const ref = slot.references.find((r) => r.collection === record.collection);
    const parent = ref && node.records.get(String(record.data[ref.field]));
    if (parent?.collection === slot.collection) return { record: parent, slot };
  }
}

/** Executors recheck the actual local registry, not a replicated device advertisement. */
export function executionReady(
  record: ResourceRecord,
  slot: ExecutionSlot,
  status: DevicePluginStatus,
) {
  const requirements = executionRequirements(slot, record);
  return (
    requirements.capabilities.every((c) => status.capabilities.includes(c)) &&
    requirements.plugins.every((required) =>
      status.plugins.some(
        (p) =>
          p.id === required.id &&
          p.installed &&
          p.enabled &&
          !p.error &&
          (!required.version || p.version === required.version),
      ),
    )
  );
}
