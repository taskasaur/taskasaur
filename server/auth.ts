import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { invariant } from "../packages/core/errors";
import type { Principal } from "../packages/plugin-sdk";
import { manifestById } from "../packages/core/catalog";
export function supabaseAuth() {
  invariant(
    process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY,
    "CONFIGURATION_REQUIRED",
    "Supabase Auth is not configured",
  );
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export async function authenticatedUser(request: Request) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : (await cookies()).get("taskasaur-access")?.value;
  invariant(token, "UNAUTHENTICATED", "Sign in to connect to the server");
  const { data, error } = await supabaseAuth().auth.getUser(token);
  invariant(
    !error && data.user,
    "UNAUTHENTICATED",
    "Session expired; sign in again",
  );
  return data.user;
}
export async function principalFor(
  request: Request,
  workspaceId: string,
  pluginId: string,
): Promise<Principal> {
  const user = await authenticatedUser(request);
  const manifest = manifestById.get(pluginId);
  invariant(manifest, "PLUGIN_NOT_FOUND", "Unknown plugin");
  return {
    userId: user.id,
    workspaceId,
    pluginId,
    permissions: manifest.permissions,
  };
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const allowed = new Set([
    new URL(request.url).origin,
    ...(process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
  ]);
  invariant(
    !origin || allowed.has(origin),
    "PERMISSION_DENIED",
    "Request origin is not allowed",
  );
}
