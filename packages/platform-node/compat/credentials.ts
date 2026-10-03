import type { Repository } from "./repository";
import { nodeFor } from "./database";
import { projectRecord } from "./projection";
import type { Principal } from "@taskasaur/platform/plugin-sdk";
export type CredentialSecret = import("../../core/vault").Secret;
/** Native plugin compatibility for the portable, device-scoped encrypted vault. */
export class CredentialBroker {
  constructor(
    private repo: Repository,
    _legacyKey?: string,
  ) {}
  async set(actor: Principal, id: string, secret: CredentialSecret) {
    await this.repo.authorize(actor, id, true);
    const node = nodeFor(this.repo.db, actor.workspaceId);
    await node.vault.set(id, secret);
    await projectRecord(this.repo.db, node.records.get(id)!);
  }
  async use<T>(
    actor: Principal,
    id: string,
    pluginId: string,
    destination: string,
    _action: string,
    operation: (secret: CredentialSecret) => Promise<T>,
  ) {
    await this.repo.membership(actor);
    await this.repo.requirePlugin(actor, pluginId);
    return nodeFor(this.repo.db, actor.workspaceId).vault.use(
      id,
      pluginId,
      destination,
      (secret) =>
        operation({
          ...secret,
          accessToken: secret.access_token ?? secret.accessToken,
          apiKey: secret.api_key ?? secret.apiKey,
          refreshToken: secret.refresh_token ?? secret.refreshToken,
          expiresAt: secret.expires_at ?? secret.expiresAt,
          clientId: secret.client_id ?? secret.clientId,
          clientSecret: secret.client_secret ?? secret.clientSecret,
          tokenEndpoint: secret.token_endpoint ?? secret.tokenEndpoint,
        }),
    );
  }
  async revoke(actor: Principal, id: string) {
    await this.repo.authorize(actor, id, true);
    const node = nodeFor(this.repo.db, actor.workspaceId);
    await node.vault.revoke(id);
    await projectRecord(this.repo.db, node.records.get(id)!);
  }
}
