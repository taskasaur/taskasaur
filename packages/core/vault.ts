import { seal, unseal, publicIdentity, type Identity } from "./crypto";
import { currentPolicy } from "./identity";
import type { Replica } from "./replica";
import { ReplicaRecords } from "./records";
import { invariant } from "@taskasaur/platform/core/errors";
export type Secret = Record<string, string | undefined>;
interface VaultValue {
  owner: string;
  sender: ReturnType<typeof publicIdentity>;
  version: string;
  recipients: Record<string, string>;
  revoked: boolean;
}
export class CredentialVault {
  readonly records: ReplicaRecords;
  private refreshing = new Map<string, Promise<void>>();
  constructor(
    readonly replica: Replica,
    private remoteRefresh?: (
      deviceId: string,
      id: string,
      pluginId: string,
      destination: string,
    ) => Promise<void>,
  ) {
    this.records = new ReplicaRecords(replica);
  }
  private recipient(value: VaultValue) {
    if (value.recipients[this.replica.identity.id])
      return this.replica.identity;
    const credential = this.replica.access.credential;
    if (
      credential &&
      this.replica.member.delegatedBy === credential.id &&
      currentPolicy(this.replica.access).members[credential.id]?.portable &&
      value.recipients[credential.id]
    )
      return credential;
    return undefined;
  }
  private canRefresh(value: VaultValue) {
    return (
      value.sender.id === this.replica.identity.id ||
      Boolean(
        this.replica.access.credential &&
        this.recipient(value) &&
        value.owner === this.replica.member.userId,
      )
    );
  }
  async exportableSecrets() {
    const secrets: Array<{ id: string; secret: Secret; recipients: string[] }> =
      [];
    for (const record of this.records
      .all()
      .filter(
        (row) =>
          !row.deletedAt &&
          row.collection === "credentials" &&
          row.data.status === "ready",
      )) {
      const value = this.replica.read<VaultValue>("vault/" + record.id);
      invariant(
        record.ownerId === this.replica.member.userId &&
          value &&
          !value.revoked &&
          this.recipient(value),
        "CREDENTIAL_UNAVAILABLE",
        "Grant this device access to all workspace credentials before exporting them",
      );
      const secret = (await unseal(
        this.recipient(value)!,
        value.sender,
        value.recipients[this.recipient(value)!.id],
        `${this.replica.workspaceId}:${record.id}:${value.version}`,
      )) as Secret;
      secrets.push({
        id: record.id,
        secret,
        recipients: Object.keys(value.recipients).filter(
          (id) => currentPolicy(this.replica.access).members[id],
        ),
      });
    }
    return secrets;
  }
  async grantExport(
    identity: Identity,
    secrets: Awaited<ReturnType<CredentialVault["exportableSecrets"]>>,
  ) {
    for (const item of secrets)
      await this.set(item.id, item.secret, [...item.recipients, identity.id]);
  }
  async set(
    id: string,
    secret: Secret,
    deviceIds: string[] = [this.replica.identity.id],
  ) {
    const record = this.records.get(id);
    invariant(
      record?.collection === "credentials" &&
        record.ownerId === this.replica.member.userId,
      "PERMISSION_DENIED",
      "Only the credential owner can change secret material",
    );
    const version = crypto.randomUUID(),
      recipients: Record<string, string> = {};
    for (const deviceId of new Set([...deviceIds, this.replica.identity.id])) {
      const member = currentPolicy(this.replica.access).members[deviceId];
      invariant(
        member,
        "NOT_FOUND",
        "Credential recipient is not an approved device",
      );
      recipients[deviceId] = await seal(
        this.replica.identity,
        member.identity,
        secret,
        `${this.replica.workspaceId}:${id}:${version}`,
      );
    }
    await this.replica.update("vault/" + id, {
      owner: record.ownerId,
      sender: publicIdentity(this.replica.identity),
      version,
      recipients,
      revoked: false,
    });
    await this.records.put(
      "credentials",
      { ...record.data, status: "ready" },
      id,
    );
  }
  private async authorized(id: string, pluginId: string, destination: string) {
    const record = this.records.get(id),
      value = this.replica.read<VaultValue>("vault/" + id);
    invariant(
      record?.collection === "credentials" &&
        record.data.status === "ready" &&
        value &&
        !value.revoked,
      "CREDENTIAL_UNAVAILABLE",
      "Credential is not ready",
    );
    invariant(
      Array.isArray(record.data.allowed_plugins) &&
        record.data.allowed_plugins.includes(pluginId),
      "PERMISSION_DENIED",
      "Credential does not allow this plugin",
    );
    invariant(
      Array.isArray(record.data.allowed_destinations) &&
        record.data.allowed_destinations.includes(destination),
      "PERMISSION_DENIED",
      "Credential does not allow this destination",
    );
    const recipient = this.recipient(value);
    const ciphertext = recipient && value.recipients[recipient.id];
    invariant(
      ciphertext,
      "CREDENTIAL_UNAVAILABLE",
      "Approve this device to use the credential",
    );
    invariant(
      currentPolicy(this.replica.access).members[value.sender.id],
      "CREDENTIAL_UNAVAILABLE",
      "Credential issuer has been revoked",
    );
    const secret = (await unseal(
      recipient!,
      value.sender,
      ciphertext,
      `${this.replica.workspaceId}:${id}:${value.version}`,
    )) as Secret;
    return { record, value, secret };
  }
  async use<T>(
    id: string,
    pluginId: string,
    destination: string,
    execute: (secret: Secret) => Promise<T>,
  ) {
    let authorized = await this.authorized(id, pluginId, destination);
    const expiry = authorized.secret.expires_at ?? authorized.secret.expiresAt;
    if (expiry && Date.parse(expiry) <= Date.now() + 30000) {
      if (this.canRefresh(authorized.value))
        await this.refresh(id, pluginId, destination);
      else {
        invariant(
          this.remoteRefresh,
          "CREDENTIAL_EXPIRED",
          "The credential authority must reconnect to refresh this token",
        );
        await this.remoteRefresh(
          authorized.value.sender.id,
          id,
          pluginId,
          destination,
        );
      }
      authorized = await this.authorized(id, pluginId, destination);
    }
    const expires = authorized.secret.expires_at ?? authorized.secret.expiresAt;
    invariant(
      !expires || Date.parse(expires) > Date.now(),
      "CREDENTIAL_EXPIRED",
      "Reconnect this credential",
    );
    return execute(authorized.secret);
  }
  async refresh(id: string, pluginId: string, destination: string) {
    const authorized = await this.authorized(id, pluginId, destination);
    invariant(
      this.canRefresh(authorized.value),
      "WRONG_EXECUTION_TARGET",
      "Refresh must run on the credential authority",
    );
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const work = async () => {
      const { record, value, secret } = await this.authorized(
          id,
          pluginId,
          destination,
        ),
        expiry = secret.expires_at ?? secret.expiresAt;
      if (expiry && Date.parse(expiry) > Date.now() + 30000) return;
      invariant(
        secret.refresh_token && secret.token_endpoint,
        "CREDENTIAL_EXPIRED",
        "Reconnect this credential to renew access",
      );
      const endpoint = new URL(secret.token_endpoint);
      invariant(
        endpoint.protocol === "https:" &&
          !endpoint.username &&
          !endpoint.password &&
          Array.isArray(record.data.allowed_destinations) &&
          record.data.allowed_destinations.includes(endpoint.href),
        "PERMISSION_DENIED",
        "Authorize the exact HTTPS token endpoint before refreshing",
      );
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: secret.refresh_token,
      });
      if (secret.client_id) form.set("client_id", secret.client_id);
      if (secret.client_secret) form.set("client_secret", secret.client_secret);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      invariant(
        response.ok,
        "CREDENTIAL_EXPIRED",
        "OAuth refresh failed; reconnect the account",
      );
      const body = await response.text();
      invariant(
        body.length < 65536,
        "PAYLOAD_TOO_LARGE",
        "OAuth response is too large",
      );
      const token = JSON.parse(body);
      invariant(
        typeof token.access_token === "string" && Number(token.expires_in) > 0,
        "CREDENTIAL_EXPIRED",
        "Token response lacks an access token or expiry",
      );
      await this.set(
        id,
        {
          ...secret,
          access_token: token.access_token,
          refresh_token:
            typeof token.refresh_token === "string"
              ? token.refresh_token
              : secret.refresh_token,
          expires_at: new Date(
            Date.now() + Math.min(Number(token.expires_in), 31536000) * 1000,
          ).toISOString(),
        },
        Object.keys(value.recipients).filter(
          (device) => currentPolicy(this.replica.access).members[device],
        ),
      );
    };
    const pending = work().finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, pending);
    return pending;
  }
  async revoke(id: string) {
    const record = this.records.get(id);
    invariant(
      record?.collection === "credentials" &&
        record.ownerId === this.replica.member.userId,
      "PERMISSION_DENIED",
      "Only the credential owner can revoke it",
    );
    const value = this.replica.read<VaultValue>("vault/" + id);
    if (value)
      await this.replica.update("vault/" + id, {
        ...value,
        sender: publicIdentity(this.replica.identity),
        revoked: true,
        recipients: {},
      });
    await this.records.put(
      "credentials",
      { ...record.data, status: "revoked" },
      id,
    );
  }
}
