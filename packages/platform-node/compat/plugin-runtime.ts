import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Repository } from "./repository";
import { CredentialBroker } from "./credentials";
import { FileService } from "./files";
import { DeviceService } from "./devices";
import { JobService } from "./jobs";
import { routerFor } from "./api";
import { operationUuid } from "./runner-dispatch";
import { pendingSignals, acknowledgeSignal } from "./device-signals";
import { loadPackageCatalog } from "./plugin-packages";
import { isRequiredCore } from "@taskasaur/platform/core/catalog";
import * as fields from "@taskasaur/platform/field-types";
import * as errors from "@taskasaur/platform/core/errors";
import * as workflows from "@taskasaur/platform/core/workflows";
import * as calendarValues from "@taskasaur/platform/core/calendar-values";
import * as typescript from "@taskasaur/platform/automation/typescript";
import type {
  Principal,
  Mutation,
  ResourceRecord,
} from "@taskasaur/platform/plugin-sdk";
const require = createRequire(import.meta.url);
const shared: Record<string, unknown> = {
  "@taskasaur/server-host": {
    Repository,
    CredentialBroker,
    FileService,
    DeviceService,
    JobService,
    routerFor,
    operationUuid,
    pendingSignals,
    acknowledgeSignal,
  },
  "@taskasaur/platform/field-types": fields,
  "@taskasaur/platform/core/errors": errors,
  "@taskasaur/platform/core/workflows": workflows,
  "@taskasaur/platform/core/calendar-values": calendarValues,
  "@taskasaur/platform/automation/typescript": typescript,
};
export function serverAdapter(repo: Repository, principal?: Principal) {
  return {
    repo,
    principal,
    field: fields.field,
    require: (id: string) => {
      if (id in shared) return shared[id];
      errors.invariant(
        id.startsWith("node:") || require("node:module").isBuiltin(id),
        "UNDECLARED_DEPENDENCY",
        `Bundle this server dependency: ${id}`,
      );
      return require(id);
    },
  };
}
export interface MutationHook {
  repo: Repository;
  principal: Principal;
  mutation: Mutation;
  data: Record<string, fields.Value>;
  schema: fields.RecordSchema;
  record?: ResourceRecord;
}
interface Backend {
  http?(
    request: Request,
    path: string,
    context: { repo: Repository; principal?: Principal },
  ): Promise<Response | undefined>;
  tick?(context: { repo: Repository; workspaceId: string }): Promise<void>;
  beforeMutation?(context: MutationHook): Promise<void>;
  afterMutation?(context: MutationHook): Promise<void>;
}
const modules = new Map<
  string,
  Promise<{
    createBackend: (core: ReturnType<typeof serverAdapter>) => Backend;
  }>
>();
async function backend(
  entry: Awaited<ReturnType<typeof loadPackageCatalog>>[number],
  repo: Repository,
  principal?: Principal,
) {
  errors.invariant(
    entry.grants.includes("core.server"),
    "PERMISSION_DENIED",
    "Server adapter grant is missing",
  );
  let imported = modules.get(entry.digest);
  if (!imported) {
    imported = import(
      pathToFileURL(entry.directory + "/" + entry.manifest.entrypoints.server)
        .href
    );
    modules.set(entry.digest, imported!);
  }
  const module = await imported!;
  errors.invariant(
    typeof module.createBackend === "function",
    "INVALID_PACKAGE",
    "Server hooks require createBackend(core)",
  );
  return module.createBackend(serverAdapter(repo, principal));
}
export async function pluginHttp(
  request: Request,
  path: string,
  context: { repo: Repository; principal?: Principal },
  authentication: "workspace" | "plugin",
) {
  for (const entry of await loadPackageCatalog()) {
    if (!entry.manifest.entrypoints.server) continue;
    const match = entry.manifest.server?.routes.find(
      (r) =>
        r.authentication === authentication &&
        (r.path.endsWith("*")
          ? path.startsWith(r.path.slice(0, -1))
          : path === r.path),
    );
    if (!match) continue;
    errors.invariant(
      match.methods.includes(request.method as "GET"),
      "METHOD_NOT_ALLOWED",
      "Unsupported plugin method",
    );
    if (authentication === "workspace") {
      errors.invariant(context.principal, "UNAUTHENTICATED", "Sign in first");
      await context.repo.requirePlugin(context.principal, entry.manifest.id);
    }
    const handler = await backend(entry, context.repo, context.principal);
    errors.invariant(
      handler.http,
      "INVALID_PACKAGE",
      "Declared HTTP handler is missing",
    );
    const response = await handler.http(request, path, context);
    errors.invariant(response, "NOT_FOUND", "Plugin route was not found");
    return response;
  }
}
export async function pluginTick(repo: Repository, workspaceId: string) {
  const states = await repo.db.query<{ id: string }>(
    "SELECT id FROM taskasaur.plugins WHERE workspace_id=$1 AND enabled",
    [workspaceId],
  );
  const enabled = new Set(states.rows.map((row) => row.id));
  for (const entry of await loadPackageCatalog())
    if (enabled.has(entry.manifest.id) && entry.manifest.server?.background) {
      if (["automation-runtime", "reminders"].includes(entry.manifest.id))
        continue;
      const node = repo.db.core.workspaces.get(workspaceId)!;
      if (
        !(await (
          await import("../../core/services")
        ).assignedService(node, entry.manifest.id))
      )
        continue;
      try {
        const handler = await backend(entry, repo);
        await handler.tick?.({ repo, workspaceId });
      } catch (error) {
        console.error(
          "Plugin background operation failed",
          entry.manifest.id,
          error instanceof errors.CoreError
            ? error.kind
            : "PLUGIN_BACKGROUND_FAILED",
        );
      }
    }
}
export async function pluginMutation(
  phase: "beforeMutation" | "afterMutation",
  context: MutationHook,
) {
  if (isRequiredCore(context.schema.pluginId)) return;
  const entry = (await loadPackageCatalog()).find(
    (p) => p.manifest.id === context.schema.pluginId,
  );
  if (!entry?.manifest.server?.mutationHooks) return;
  const handler = await backend(entry, context.repo, context.principal);
  await handler[phase]?.(context);
}
