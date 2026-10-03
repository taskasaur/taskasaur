import type { CredentialVault } from "./vault";
import type { Value } from "@taskasaur/platform/field-types";
import { invariant } from "@taskasaur/platform/core/errors";
import { base64, utf8 } from "./crypto";
/** HTTP broker never returns secret material to the requesting plugin. */
export async function credentialHttp(
  vault: CredentialVault,
  pluginId: string,
  id: string,
  destination: string,
  options: { method?: string; body?: Value } = {},
) {
  const url = new URL(destination);
  invariant(
    url.protocol === "https:" && !url.username && !url.password,
    "TLS_REQUIRED",
    "Credential HTTP requests require HTTPS",
  );
  return vault.use(id, pluginId, url.href, async (secret) => {
    const token =
      secret.access_token ??
      secret.accessToken ??
      secret.api_key ??
      secret.apiKey;
    invariant(
      token || secret.password,
      "CREDENTIAL_UNAVAILABLE",
      "This HTTP credential needs a token or password",
    );
    const authorization = token
      ? "Bearer " + token
      : "Basic " +
        base64(utf8.encode(`${secret.username ?? ""}:${secret.password}`));
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
    });
    invariant(response.ok, "PROVIDER_ERROR", "Credential request failed");
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        invariant(
          size <= 1024 * 1024,
          "PAYLOAD_TOO_LARGE",
          "Credential response exceeds 1 MB",
        );
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const body = new TextDecoder().decode(bytes);
    return body ? (JSON.parse(body) as Value) : null;
  });
}
