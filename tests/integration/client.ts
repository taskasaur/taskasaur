import assert from "node:assert/strict";
export class TestClient {
  readonly base = process.env.TEST_APP_URL ?? "http://127.0.0.1:3210";
  workspaceId = "";
  userId = "";
  private cookies = new Map<string, string>();
  async request<T = any>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    const url = new URL("/api/" + path, this.base);
    if (this.workspaceId) url.searchParams.set("workspaceId", this.workspaceId);
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: [...this.cookies].map(([k, v]) => k + "=" + v).join("; "),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0],
        at = pair.indexOf("=");
      this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const result = await response.json();
    assert(
      response.ok && !result.error,
      result.error?.message ?? "API request failed",
    );
    return result as T;
  }
  async setup() {
    const auth = await this.request("auth/signup", {
      email: `test-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID() + "aA1!",
    });
    this.userId = auth.user.id;
    this.workspaceId = (
      await this.request("workspaces", { name: "Integration fixture" })
    ).id;
    return this;
  }
  async enable(id: string) {
    await this.request("plugins", { id, action: "install" });
    await this.request("plugins", { id, action: "enable" });
  }
  async put(pluginId: string, collection: string, data: unknown) {
    const resourceId = crypto.randomUUID();
    return (
      await this.request("rpc", {
        context: { workspaceId: this.workspaceId, pluginId },
        request: {
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: collection + ".put",
          params: {
            id: crypto.randomUUID(),
            resourceId,
            pluginId,
            collection,
            operation: "put",
            baseRevision: 0,
            data,
            createdAt: new Date().toISOString(),
          },
        },
      })
    ).result;
  }
}
export async function eventually<T>(
  read: () => Promise<T>,
  accept: (v: T) => boolean,
  ms = 30000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Integration check timed out");
}
