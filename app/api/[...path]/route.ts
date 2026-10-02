import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  authenticatedUser,
  checkOrigin,
  principalFor,
  supabaseAuth,
} from "../../../server/auth";
import { services, registryFor } from "../../../server/api";
import { CoreError, invariant } from "../../../packages/core/errors";
import { FileService } from "../../../server/files";
import type { CredentialSecret } from "../../../server/credentials";
import { DeviceService } from "../../../server/devices";
import { MailService } from "../../../server/mail";
import { GithubService } from "../../../server/github";
import { dispatchWorkflow } from "../../../server/dispatch";
import {
  queueWorkflowSignal,
  rotateWorkflowHook,
  receiveWorkflowHook,
  acknowledgeSignal,
} from "../../../server/workflow-triggers";
import { loadPackageCatalog } from "../../../server/plugin-packages";
import {
  pendingDispatches,
  reportDispatch,
  executeWorkflowCommand,
  type Dispatch,
} from "../../../server/runner-dispatch";
import { AccessService } from "../../../server/access";
import { JobService } from "../../../server/jobs";
import { pullEvents, publishEvent } from "../../../server/events";
import type { PluginEvent } from "../../../packages/plugin-sdk";
import type { Value } from "../../../packages/field-types";
export const runtime = "nodejs";
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: Request, context: Context) {
  try {
    const packages = await loadPackageCatalog();
    const path = (await context.params).path.join("/"),
      url = new URL(request.url);
    if (request.method !== "GET") checkOrigin(request);
    if (path === "health") {
      await services().repo.db.query(
        "SELECT version FROM taskasaur.schema_version WHERE version=1",
      );
      return NextResponse.json({ status: "ready", platformApi: "1.0.0" });
    }
    if (path.startsWith("automation/hooks/") && request.method === "POST") {
      const id = z.string().uuid().parse(path.split("/")[2]);
      const operationId = z
        .string()
        .min(1)
        .max(200)
        .parse(request.headers.get("Idempotency-Key"));
      const reader = request.body?.getReader();
      invariant(reader, "VALIDATION_FAILED", "Webhook body is required");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          invariant(
            length <= 1024 * 1024,
            "PAYLOAD_TOO_LARGE",
            "Webhook exceeds 1 MB",
          );
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Value;
      const token =
        request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      return NextResponse.json(
        await receiveWorkflowHook(
          services().repo,
          id,
          token,
          operationId,
          input,
        ),
      );
    }
    if (path === "auth/login" || path === "auth/signup") {
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const input = z
        .object({
          email: z.string().email(),
          password: z.string().min(8).max(1000),
        })
        .parse(await request.json());
      const client = supabaseAuth();
      const result = path.endsWith("signup")
        ? await client.auth.signUp(input)
        : await client.auth.signInWithPassword(input);
      invariant(
        !result.error,
        "AUTHENTICATION_FAILED",
        result.error?.message ?? "Sign-in failed",
      );
      if (result.data.session) {
        const jar = await cookies(),
          session = result.data.session;
        const options = {
          httpOnly: true,
          secure: url.protocol === "https:",
          sameSite: "lax" as const,
          path: "/",
        };
        jar.set("taskasaur-access", session.access_token, {
          ...options,
          maxAge: session.expires_in,
        });
        jar.set("taskasaur-refresh", session.refresh_token, {
          ...options,
          maxAge: 30 * 86400,
        });
      }
      return NextResponse.json({
        user: result.data.user
          ? { id: result.data.user.id, email: result.data.user.email }
          : null,
        confirmationRequired: !result.data.session,
      });
    }
    if (path === "auth/refresh") {
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const jar = await cookies();
      const token = jar.get("taskasaur-refresh")?.value;
      invariant(token, "UNAUTHENTICATED", "No refresh session");
      const { data, error } = await supabaseAuth().auth.refreshSession({
        refresh_token: token,
      });
      invariant(!error && data.session, "UNAUTHENTICATED", "Session expired");
      const options = {
        httpOnly: true,
        secure: url.protocol === "https:",
        sameSite: "lax" as const,
        path: "/",
      };
      jar.set("taskasaur-access", data.session.access_token, {
        ...options,
        maxAge: data.session.expires_in,
      });
      jar.set("taskasaur-refresh", data.session.refresh_token, {
        ...options,
        maxAge: 30 * 86400,
      });
      return NextResponse.json({ ok: true });
    }
    if (path === "auth/logout") {
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const jar = await cookies();
      jar.delete("taskasaur-access");
      jar.delete("taskasaur-refresh");
      return NextResponse.json({ ok: true });
    }
    if (path === "devices/pair") {
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const input = z
        .object({
          code: z.string().min(10).max(100),
          name: z.string().min(1).max(120),
          platform: z.string(),
          capabilities: z.array(z.string()),
          publicKey: z.string().max(20000),
        })
        .parse(await request.json());
      return NextResponse.json(
        await new DeviceService(services().repo).enroll(
          input.code,
          input.name,
          input.platform,
          input.capabilities,
          input.publicKey,
        ),
      );
    }
    if (path.startsWith("devices/runs/")) {
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const { repo } = services(),
        deviceId = z
          .string()
          .uuid()
          .parse(request.headers.get("X-Taskasaur-Device"));
      const token =
        request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      const identity = await new DeviceService(repo).authenticate(
        deviceId,
        token,
      );
      invariant(
        Number(request.headers.get("X-Taskasaur-Lease")) ===
          identity.lease_epoch,
        "LEASE_EXPIRED",
        "Device connection was replaced",
      );
      const principal = {
        userId: identity.owner_id,
        workspaceId: identity.workspace_id,
        pluginId: "automation-runtime",
        permissions: [],
      };
      await repo.requirePlugin(principal, "automation-runtime");
      const device = await repo.get(principal, deviceId);
      invariant(
        Array.isArray(device.data.capabilities) &&
          device.data.capabilities.includes("automation.execute"),
        "CAPABILITY_UNSUPPORTED",
        "Automation execution is not enabled",
      );
      if (path.endsWith("/poll"))
        return NextResponse.json(await pendingDispatches(repo, deviceId));
      const input = await request.json(),
        runId = z.string().uuid().parse(input.runId);
      const dispatch = (
        await repo.db.query<Dispatch>(
          "SELECT * FROM taskasaur.dispatches WHERE run_id=$1 AND device_id=$2",
          [runId, deviceId],
        )
      ).rows[0];
      invariant(
        dispatch && dispatch.workspace_id === identity.workspace_id,
        "PERMISSION_DENIED",
        "Run is assigned to another device",
      );
      if (path.endsWith("/report")) {
        invariant(
          String(dispatch.assignment_epoch) === input.assignmentEpoch,
          "LEASE_EXPIRED",
          "Execution assignment changed",
        );
        await reportDispatch(
          repo,
          dispatch,
          z
            .enum(["accepted", "completed", "failed", "cancelled"])
            .parse(input.status),
          input.output ?? null,
          z.string().parse(input.engineRunId),
        );
        return NextResponse.json({ ok: true });
      }
      if (path.endsWith("/command")) {
        invariant(
          typeof input.operationId === "string" &&
            input.operationId.startsWith(runId + ":"),
          "VALIDATION_FAILED",
          "Invalid operation ID",
        );
        return NextResponse.json(
          await executeWorkflowCommand(
            repo,
            dispatch,
            z.string().parse(input.command),
            input.input,
            input.operationId,
          ),
        );
      }
      if (path.endsWith("/signal-ack")) {
        await acknowledgeSignal(repo, runId, z.string().uuid().parse(input.id));
        return NextResponse.json({ ok: true });
      }
      throw new CoreError("NOT_FOUND", "Unknown device run operation");
    }
    const user = await authenticatedUser(request),
      { repo, broker } = services();
    if (path === "workspaces") {
      if (request.method === "POST") {
        const body = z
          .object({ name: z.string().min(1).max(120) })
          .parse(await request.json());
        return NextResponse.json({
          id: await repo.createWorkspace(user.id, body.name),
        });
      }
      const { rows } = await repo.db.query(
        "SELECT w.id,w.name FROM taskasaur.workspaces w JOIN taskasaur.memberships m ON m.workspace_id=w.id WHERE m.user_id=$1",
        [user.id],
      );
      return NextResponse.json({
        user: { id: user.id, email: user.email },
        workspaces: rows,
      });
    }
    const workspaceId = z
      .string()
      .uuid()
      .parse(url.searchParams.get("workspaceId"));
    const principal = await principalFor(
      request,
      workspaceId,
      url.searchParams.get("pluginId") ?? "records",
    );
    await repo.membership(principal);
    if (path.startsWith("github/") && request.method === "POST") {
      const id = z
          .string()
          .uuid()
          .parse((await request.json()).id),
        github = new GithubService(repo, broker());
      if (path === "github/sync")
        return NextResponse.json(await github.sync(principal, id));
      if (path === "github/create-task")
        return NextResponse.json(await github.createTask(principal, id));
    }
    if (path === "jobs") {
      const jobs = new JobService(repo);
      if (request.method === "GET")
        return NextResponse.json(await repo.list(principal, "jobs"));
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const body = z
        .object({
          pluginId: z.string(),
          command: z.string(),
          input: z.unknown(),
          dueAt: z.string().datetime().optional(),
          operationId: z.string().uuid().optional(),
          intervalSeconds: z.number().int().min(60).optional(),
        })
        .parse(await request.json());
      const actor = await principalFor(request, workspaceId, body.pluginId);
      return NextResponse.json(
        await jobs.enqueue(actor, body.command, body.input as Value, body),
      );
    }
    if (path === "jobs/cancel" && request.method === "POST") {
      await new JobService(repo).cancel(
        principal,
        z
          .string()
          .uuid()
          .parse((await request.json()).id),
      );
      return NextResponse.json({ ok: true });
    }
    if (path === "events") {
      if (request.method === "GET")
        return NextResponse.json(
          await pullEvents(
            repo,
            principal,
            url.searchParams.get("cursor") ?? "0",
          ),
        );
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const body = await request.json(),
        actor = await principalFor(
          request,
          workspaceId,
          z.string().parse(body.pluginId),
        );
      await publishEvent(repo, actor, body.event as PluginEvent);
      return NextResponse.json({ ok: true });
    }
    if (path === "access/members") {
      const access = new AccessService(repo);
      if (request.method === "GET")
        return NextResponse.json(await access.members(principal));
      if (request.method === "DELETE")
        return NextResponse.json(
          await access.removeMember(
            principal,
            z
              .string()
              .uuid()
              .parse((await request.json()).userId),
          ),
        );
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const body = z
        .object({
          email: z.string().email(),
          role: z.enum(["editor", "viewer"]),
        })
        .parse(await request.json());
      return NextResponse.json(
        await access.addMember(principal, body.email, body.role),
      );
    }
    if (path === "access/grants") {
      const access = new AccessService(repo);
      if (request.method === "GET")
        return NextResponse.json(
          await access.grants(
            principal,
            z.string().uuid().parse(url.searchParams.get("resourceId")),
          ),
        );
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const body = z
        .object({
          resourceId: z.string().uuid(),
          subjectId: z.string().uuid(),
          role: z.enum(["viewer", "commenter", "editor"]).nullable(),
          expiresAt: z.string().datetime().nullable().default(null),
        })
        .parse(await request.json());
      return NextResponse.json(
        await access.grant(
          principal,
          body.resourceId,
          body.subjectId,
          body.role,
          body.expiresAt,
        ),
      );
    }
    if (path === "plugins/packages" && request.method === "GET")
      return NextResponse.json(
        packages.map(
          ({ manifest, schemas, grants, digest, browserDigest }) => ({
            manifest,
            schemas,
            grants,
            digest,
            browserDigest,
          }),
        ),
      );
    if (path === "plugins/source" && request.method === "GET") {
      const entry = packages.find(
        (p) => p.manifest.id === url.searchParams.get("id"),
      );
      invariant(
        entry?.manifest.entrypoints.browser,
        "NOT_FOUND",
        "Browser module is unavailable",
      );
      await repo.requirePlugin(principal, entry.manifest.id);
      const { readFile } = await import("node:fs/promises");
      return NextResponse.json({
        source: await readFile(
          entry.directory + "/" + entry.manifest.entrypoints.browser,
          "utf8",
        ),
      });
    }
    if (path === "devices/enroll") {
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      return NextResponse.json(
        await new DeviceService(repo).createEnrollment(principal),
      );
    }
    if (path === "devices/revoke" && request.method === "POST") {
      await new DeviceService(repo).revoke(
        principal,
        z
          .string()
          .uuid()
          .parse((await request.json()).id),
      );
      return NextResponse.json({ ok: true });
    }
    if (path === "automation/cancel" && request.method === "POST") {
      const id = z
        .string()
        .uuid()
        .parse((await request.json()).id);
      await repo.authorize(principal, id, true);
      await repo.db.query(
        "UPDATE taskasaur.dispatches SET cancel_requested=true WHERE run_id=$1 AND workspace_id=$2",
        [id, workspaceId],
      );
      return NextResponse.json({ ok: true });
    }
    if (path === "automation/signal" && request.method === "POST") {
      const input = z
        .object({
          id: z.string().uuid(),
          name: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
          data: z.unknown(),
          operationId: z.string().uuid(),
        })
        .parse(await request.json());
      return NextResponse.json(
        await queueWorkflowSignal(
          repo,
          principal,
          input.id,
          input.name,
          (input.data ?? null) as Value,
          input.operationId,
        ),
      );
    }
    if (path === "automation/webhook" && request.method === "POST") {
      return NextResponse.json(
        await rotateWorkflowHook(
          repo,
          principal,
          z
            .string()
            .uuid()
            .parse((await request.json()).id),
        ),
      );
    }
    if (path === "devices" && request.method === "GET")
      return NextResponse.json(await repo.list(principal, "devices"));
    if (path === "automation/run") {
      await repo.requirePlugin(principal, "automation-runtime");
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const input = z
        .object({
          id: z.string().uuid(),
          targetDeviceId: z.string().uuid(),
          operationId: z.string().uuid().optional(),
          input: z.unknown().optional(),
        })
        .parse(await request.json());
      return NextResponse.json(
        await dispatchWorkflow(
          repo,
          principal,
          input.id,
          input.targetDeviceId,
          { operationId: input.operationId, input: input.input as Value },
        ),
      );
    }
    if (path === "terminal/open") {
      await repo.requirePlugin(principal, "remote-terminal");
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const input = z
        .object({ deviceId: z.string().uuid() })
        .parse(await request.json());
      return NextResponse.json(
        await new DeviceService(repo).terminalTicket(principal, input.deviceId),
      );
    }
    if (path.startsWith("mail/")) {
      await repo.requirePlugin(principal, "email-client");
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const { id, mailbox, beforeSequence } = z
        .object({
          id: z.string().uuid(),
          mailbox: z.string().max(1000).optional(),
          beforeSequence: z.number().int().positive().optional(),
        })
        .parse(await request.json());
      const mail = new MailService(repo, broker());
      const action = path.slice(5);
      invariant(
        ["sync", "read", "send", "folders", "applyOperation"].includes(action),
        "NOT_FOUND",
        "Mail action not found",
      );
      return NextResponse.json(
        action === "sync"
          ? await mail.sync(principal, id, mailbox, beforeSequence)
          : await mail[
              action as "read" | "send" | "folders" | "applyOperation"
            ](principal, id),
      );
    }
    if (path === "records/get" && request.method === "GET")
      return NextResponse.json(
        await repo.get(
          principal,
          z.string().uuid().parse(url.searchParams.get("id")),
        ),
      );
    if (path === "sync" && request.method === "GET")
      return NextResponse.json(
        await repo.pull(principal, url.searchParams.get("cursor") ?? "0"),
      );
    if (path === "plugins" || path === "plugins/features") {
      const registry = registryFor(repo, principal);
      // Read inventory without modifying it. Core rows are seeded by workspace creation/migration.
      for (const state of await (
        await repo.db.query<{
          id: string;
          version: string;
          installed: boolean;
          enabled: boolean;
          features: string[];
        }>(
          "SELECT id,version,installed,enabled,features FROM taskasaur.plugins WHERE workspace_id=$1",
          [workspaceId],
        )
      ).rows)
        registry.states.set(state.id, state);
      if (request.method === "GET") return NextResponse.json(registry.list());
      invariant(
        (await repo.membership(principal, true)) === "owner",
        "PERMISSION_DENIED",
        "Owner permission is required",
      );
      if (path === "plugins/features") {
        invariant(
          request.method === "POST",
          "METHOD_NOT_ALLOWED",
          "POST required",
        );
        const input = z
          .object({ id: z.string(), features: z.array(z.string()) })
          .parse(await request.json());
        return NextResponse.json(
          await registry.configure(input.id, input.features),
        );
      }
      const input = z
        .object({
          id: z.string(),
          action: z.enum(["install", "enable", "disable", "uninstall"]),
        })
        .parse(await request.json());
      return NextResponse.json(await registry[input.action](input.id));
    }
    if (path === "credentials/secret") {
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const input = z
        .object({
          id: z.string().uuid(),
          secret: z
            .object({
              username: z.string().optional(),
              password: z.string().optional(),
              apiKey: z.string().optional(),
              accessToken: z.string().optional(),
              refreshToken: z.string().optional(),
              privateKey: z.string().optional(),
              expiresAt: z.string().datetime().optional(),
              clientId: z.string().max(64000).optional(),
              clientSecret: z.string().max(64000).optional(),
              tokenEndpoint: z.string().url().optional(),
            })
            .strict(),
        })
        .parse(await request.json());
      await broker().set(principal, input.id, input.secret as CredentialSecret);
      return NextResponse.json({ ok: true });
    }
    if (path === "credentials/revoke") {
      invariant(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "POST required",
      );
      const { id } = z
        .object({ id: z.string().uuid() })
        .parse(await request.json());
      await broker().revoke(principal, id);
      return NextResponse.json({ ok: true });
    }
    if (path === "files") {
      const id = z.string().uuid().parse(url.searchParams.get("id")),
        files = new FileService(repo);
      if (request.method === "GET")
        return new Response(
          await files.download(
            principal,
            id,
            url.searchParams.get("version") ?? undefined,
          ),
          {
            headers: {
              "Cache-Control": "private, no-store",
              "Content-Disposition": "attachment",
            },
          },
        );
      invariant(request.method === "PUT", "METHOD_NOT_ALLOWED", "PUT required");
      return NextResponse.json(
        await files.upload(
          principal,
          id,
          Buffer.from(await request.arrayBuffer()),
          request.headers.get("content-type") ?? "application/octet-stream",
          url.searchParams.get("parent"),
          z.string().uuid().parse(url.searchParams.get("version")),
        ),
      );
    }
    throw new CoreError("NOT_FOUND", "API route not found");
  } catch (error) {
    const kind =
      error instanceof CoreError
        ? error.kind
        : error instanceof z.ZodError
          ? "VALIDATION_FAILED"
          : "INTERNAL_ERROR";
    const status =
      kind === "UNAUTHENTICATED"
        ? 401
        : kind === "PERMISSION_DENIED"
          ? 403
          : kind === "NOT_FOUND"
            ? 404
            : kind === "REVISION_CONFLICT"
              ? 409
              : kind === "INTERNAL_ERROR"
                ? 500
                : 400;
    return NextResponse.json(
      {
        error: {
          kind,
          message:
            error instanceof CoreError
              ? error.message
              : kind === "VALIDATION_FAILED"
                ? "Invalid request"
                : "The operation failed",
        },
      },
      { status },
    );
  }
}
export const GET = handle,
  POST = handle,
  PUT = handle,
  DELETE = handle;
