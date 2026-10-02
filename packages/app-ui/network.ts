type NativeRequest = {
  url: string;
  method: string;
  contentType?: string;
  body?: Uint8Array;
};
declare global {
  interface Window {
    taskasaurNative?: {
      request(input: NativeRequest): Promise<{
        status: number;
        headers: Record<string, string>;
        body: Uint8Array;
      }>;
      capabilities(): Promise<{
        platform: string;
        terminalHost: boolean;
        automationExecute: boolean;
        secureCredentials: boolean;
      }>;
      pair(input: {
        serverUrl: string;
        code: string;
        terminal: boolean;
        automation: boolean;
      }): Promise<unknown>;
    };
  }
}
const refreshing = new Map<string, Promise<boolean>>();
export function defaultServerUrl() {
  return (
    (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim() ||
    location.origin
  );
}
async function transport(url: URL, options: RequestInit) {
  const host = window.taskasaurNative;
  if (!host) return fetch(url, { ...options, credentials: "include" });
  const body =
    options.body == null
      ? undefined
      : new Uint8Array(await new Response(options.body).arrayBuffer());
  const result = await host.request({
    url: url.href,
    method: options.method ?? "GET",
    contentType: new Headers(options.headers).get("Content-Type") ?? undefined,
    body,
  });
  return new Response(
    [204, 205, 304].includes(result.status)
      ? null
      : new Uint8Array(result.body),
    { status: result.status, headers: result.headers },
  );
}
export async function serverFetch(
  input: string | URL,
  options: RequestInit = {},
) {
  const url = new URL(input, defaultServerUrl());
  let response = await transport(url, options);
  if (response.status === 401 && !url.pathname.startsWith("/api/auth/")) {
    let refresh = refreshing.get(url.origin);
    if (!refresh) {
      refresh = transport(new URL("/api/auth/refresh", url), { method: "POST" })
        .then((r) => r.ok)
        .finally(() => refreshing.delete(url.origin));
      refreshing.set(url.origin, refresh);
    }
    if (await refresh) response = await transport(url, options);
  }
  return response;
}
