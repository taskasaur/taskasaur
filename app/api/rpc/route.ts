import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, principalFor } from "../../../server/auth";
import { services, routerFor } from "../../../server/api";
import { CoreError } from "../../../packages/core/errors";
import { loadPackageCatalog } from "../../../server/plugin-packages";
import { serverPluginHost } from "../../../server/plugin-host";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    await loadPackageCatalog();
    const body = await request.json();
    const context = z
      .object({ workspaceId: z.string().uuid(), pluginId: z.string() })
      .parse(body.context);
    const principal = await principalFor(
      request,
      context.workspaceId,
      context.pluginId,
    );
    const { repo } = services();
    await repo.membership(principal);
    const router = await routerFor(repo, principal);
    const host = await serverPluginHost(repo, principal, router);
    try {
      return NextResponse.json(
        await router.receive(body.request, {
          principal,
          signal: request.signal,
        }),
      );
    } finally {
      await host.close();
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          kind: error instanceof CoreError ? error.kind : "VALIDATION_FAILED",
          message:
            error instanceof CoreError ? error.message : "Invalid request",
        },
      },
      {
        status:
          error instanceof CoreError && error.kind === "UNAUTHENTICATED"
            ? 401
            : 400,
      },
    );
  }
}
