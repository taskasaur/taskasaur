import { it, expect, vi } from "vitest";
const getUser = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser } }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
import { authenticatedUser } from "../server/auth";
const request = () =>
  new Request("https://taskasaur.example/api/workspaces", {
    headers: { Authorization: "Bearer fixture-session" },
  });
it("preserves the distinction between an expired session and a temporary auth outage", async () => {
  vi.stubEnv("SUPABASE_URL", "https://supabase.example");
  vi.stubEnv("SUPABASE_ANON_KEY", "fixture-public-key");
  try {
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 504 } });
    await expect(authenticatedUser(request())).rejects.toMatchObject({
      kind: "AUTH_SERVICE_UNAVAILABLE",
    });
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
    await expect(authenticatedUser(request())).rejects.toMatchObject({
      kind: "UNAUTHENTICATED",
    });
    getUser.mockResolvedValue({
      data: { user: { id: "fixture-user" } },
      error: null,
    });
    expect(await authenticatedUser(request())).toEqual({ id: "fixture-user" });
  } finally {
    vi.unstubAllEnvs();
  }
});
