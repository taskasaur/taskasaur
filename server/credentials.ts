import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { Principal } from "../packages/plugin-sdk";
import { invariant } from "../packages/core/errors";
import type { Repository } from "./repository";
import { Repository as RepositoryStore } from "./repository";
export type CredentialSecret = {
  username?: string;
  password?: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  privateKey?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
};
export class CredentialBroker {
  private readonly key: Buffer;
  constructor(
    private repository: Repository,
    key: string,
  ) {
    invariant(
      /^[a-f0-9]{64}$/i.test(key),
      "CONFIGURATION_REQUIRED",
      "CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as hex",
    );
    this.key = Buffer.from(key, "hex");
  }
  private encrypt(secret: CredentialSecret, context: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secret), "utf8"),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((v) => v.toString("base64"))
      .join(".");
  }
  private decrypt(secret: string, context: string): CredentialSecret {
    const [iv, tag, value] = secret
      .split(".")
      .map((v) => Buffer.from(v, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(value), decipher.final()]).toString(
        "utf8",
      ),
    ) as CredentialSecret;
  }
  async set(principal: Principal, id: string, secret: CredentialSecret) {
    const resource = await this.repository.authorize(principal, id, true);
    invariant(
      resource.collection === "credentials" &&
        resource.owner_id === principal.userId,
      "PERMISSION_DENIED",
      "Only the credential owner can change secret material",
    );
    const ciphertext = this.encrypt(secret, `${principal.workspaceId}:${id}`);
    await this.repository.db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO taskasaur.secrets(resource_id,ciphertext) VALUES($1,$2) ON CONFLICT(resource_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,version=taskasaur.secrets.version+1,revoked_at=NULL",
        [id, ciphertext],
      );
      const repo = new RepositoryStore(tx),
        record = await repo.get(principal, id);
      await repo.mutate(principal, {
        id: randomUUID(),
        resourceId: id,
        pluginId: "credentials",
        collection: "credentials",
        operation: "put",
        baseRevision: record.revision,
        createdAt: new Date().toISOString(),
        data: { ...record.data, status: "ready" },
      });
    });
  }
  async use<T>(
    principal: Principal,
    id: string,
    pluginId: string,
    destination: string,
    action: string,
    operation: (secret: CredentialSecret) => Promise<T>,
  ): Promise<T> {
    await this.repository.requirePlugin(principal, pluginId);
    const resource = await this.repository.get(principal, id);
    invariant(
      resource.collection === "credentials" && resource.data.status === "ready",
      "CREDENTIAL_UNAVAILABLE",
      "Credential is not ready",
    );
    invariant(
      Array.isArray(resource.data.allowed_plugins) &&
        resource.data.allowed_plugins.includes(pluginId),
      "PERMISSION_DENIED",
      "Credential does not allow this plugin",
    );
    invariant(
      Array.isArray(resource.data.allowed_destinations) &&
        resource.data.allowed_destinations.includes(destination),
      "PERMISSION_DENIED",
      "Credential does not allow this destination",
    );
    const row = (
      await this.repository.db.query<{
        ciphertext: string;
        revoked_at: string | null;
      }>(
        "SELECT ciphertext,revoked_at FROM taskasaur.secrets WHERE resource_id=$1",
        [id],
      )
    ).rows[0];
    invariant(
      row && !row.revoked_at,
      "CREDENTIAL_UNAVAILABLE",
      "Credential has no active secret",
    );
    let secret = this.decrypt(row.ciphertext, `${principal.workspaceId}:${id}`);
    if (
      secret.expiresAt &&
      Date.parse(secret.expiresAt) <= Date.now() + 30000 &&
      secret.refreshToken
    ) {
      invariant(
        secret.tokenEndpoint && secret.clientId,
        "CREDENTIAL_EXPIRED",
        "OAuth refresh configuration is missing",
      );
      secret = await this.repository.db.transaction(async (tx) => {
        const current = (
          await tx.query<{ ciphertext: string; revoked_at: string | null }>(
            "SELECT ciphertext,revoked_at FROM taskasaur.secrets WHERE resource_id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        invariant(
          current && !current.revoked_at,
          "CREDENTIAL_UNAVAILABLE",
          "Credential was revoked",
        );
        const latest = this.decrypt(
          current.ciphertext,
          `${principal.workspaceId}:${id}`,
        );
        if (
          !latest.expiresAt ||
          Date.parse(latest.expiresAt) > Date.now() + 30000
        )
          return latest;
        invariant(
          latest.tokenEndpoint && latest.clientId && latest.refreshToken,
          "CREDENTIAL_EXPIRED",
          "OAuth refresh configuration is missing",
        );
        const endpoint = new URL(latest.tokenEndpoint);
        const authorized = await new RepositoryStore(tx).get(principal, id);
        invariant(
          authorized.data.status === "ready" &&
            Array.isArray(authorized.data.allowed_plugins) &&
            authorized.data.allowed_plugins.includes(pluginId) &&
            endpoint.protocol === "https:" &&
            Array.isArray(authorized.data.allowed_destinations) &&
            authorized.data.allowed_destinations.includes(destination) &&
            authorized.data.allowed_destinations.includes(endpoint.href),
          "PERMISSION_DENIED",
          "OAuth refresh or destination is no longer authorized",
        );
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: latest.refreshToken!,
          client_id: latest.clientId!,
        });
        if (latest.clientSecret) body.set("client_secret", latest.clientSecret);
        const response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        invariant(
          response.ok,
          "CREDENTIAL_EXPIRED",
          "OAuth refresh failed; reconnect this credential",
        );
        const tokens = await response.json();
        invariant(
          typeof tokens.access_token === "string" &&
            tokens.access_token.length <= 64000,
          "CREDENTIAL_EXPIRED",
          "Provider returned an invalid access token",
        );
        const refreshed = {
          ...latest,
          accessToken: tokens.access_token,
          refreshToken:
            typeof tokens.refresh_token === "string"
              ? tokens.refresh_token
              : latest.refreshToken,
          expiresAt: new Date(
            Date.now() +
              Math.max(
                1,
                Math.min(31536000, Number(tokens.expires_in) || 3600),
              ) *
                1000,
          ).toISOString(),
        };
        await tx.query(
          "UPDATE taskasaur.secrets SET ciphertext=$2,version=version+1 WHERE resource_id=$1",
          [id, this.encrypt(refreshed, `${principal.workspaceId}:${id}`)],
        );
        return refreshed;
      });
    }
    invariant(
      !secret.expiresAt || Date.parse(secret.expiresAt) > Date.now(),
      "CREDENTIAL_EXPIRED",
      "Reconnect this credential",
    );
    await this.repository.db.query(
      "INSERT INTO taskasaur.audit(id,workspace_id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
      [
        randomUUID(),
        principal.workspaceId,
        principal.userId,
        `${pluginId}:${action}`,
        id,
      ],
    );
    return operation(secret);
  }
  async revoke(principal: Principal, id: string) {
    const owned = await this.repository.authorize(principal, id, true);
    invariant(
      owned.collection === "credentials" && owned.owner_id === principal.userId,
      "PERMISSION_DENIED",
      "Only the credential owner can revoke it",
    );
    await this.repository.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE taskasaur.secrets SET revoked_at=now(),version=version+1 WHERE resource_id=$1",
        [id],
      );
      const repo = new RepositoryStore(tx),
        record = await repo.get(principal, id);
      await repo.mutate(principal, {
        id: randomUUID(),
        resourceId: id,
        pluginId: "credentials",
        collection: "credentials",
        operation: "put",
        baseRevision: record.revision,
        createdAt: new Date().toISOString(),
        data: { ...record.data, status: "revoked" },
      });
    });
  }
}
