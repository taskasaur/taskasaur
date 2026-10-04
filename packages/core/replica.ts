import { catalogKey, validateStorageControl } from "./storage-placement";
import * as A from "@automerge/automerge";
import type { DurableStorage } from "../storage";
import {
  canonical,
  base64,
  unbase64,
  digest,
  utf8,
  text,
  sign,
  verify,
  encrypt,
  decrypt,
  type Identity,
} from "./crypto";
import {
  acceptPolicies,
  currentPolicy,
  type WorkspaceAccess,
  type Policy,
  memberAt,
  validateDelegations,
  type DeviceDelegation,
} from "./identity";
import { invariant } from "@taskasaur/platform/core/errors";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { validateRecord } from "@taskasaur/platform/field-types";
import { schemaById } from "@taskasaur/platform/core/catalog";
import { serviceToken } from "./services";
export type DocumentValue = { value: Record<string, unknown> };
export interface ChangeBody {
  version: 1;
  workspaceId: string;
  documentId: string;
  author: string;
  epoch: number;
  hash: string;
  change: string;
}
export interface SignedChange extends ChangeBody {
  signature: string;
}
export interface ReplicaStatus {
  documents: number;
  changes: number;
  quarantined: number;
  pending: number;
  peers: number;
  error?: string;
}
/** One replica per workspace/device. Changes are signed individually so untrusted relays cannot forge forwarded edits. */
export class Replica {
  private active = true;
  deactivate() {
    this.active = false;
    this.listeners.clear();
    this.outgoing.clear();
    this.policyListeners.clear();
  }
  private assertActive() {
    invariant(this.active, "WORKSPACE_CLOSED", "This workspace is closed");
  }
  wantsDocument: (id: string, deviceId?: string) => boolean = () => true;
  private evicted = new Set<string>();
  private coldDocuments = new Map<string, Uint8Array>();
  private documents = new Map<string, A.Doc<DocumentValue>>();
  private changes = new Map<string, SignedChange>();
  private pending = new Map<string, SignedChange>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly listeners = new Set<(id: string) => void>();
  readonly outgoing = new Set<(change: SignedChange) => void>();
  readonly policyListeners = new Set<() => void>();
  quarantined = 0;
  peers = 0;
  error = "";
  constructor(
    readonly identity: Identity,
    public access: WorkspaceAccess,
    readonly storage: DurableStorage,
  ) {}
  get workspaceId() {
    return currentPolicy(this.access).workspaceId;
  }
  get member() {
    return currentPolicy(this.access).members[this.identity.id];
  }
  private prefix() {
    return `workspace/${this.workspaceId}/`;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    this.assertActive();
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  async open() {
    const grants = await this.storage.get(this.prefix() + "delegations");
    if (grants) {
      const delegations = JSON.parse(text.decode(grants)) as DeviceDelegation[];
      const merged = new Map(
        [...(this.access.delegations ?? []), ...delegations].map((grant) => [
          grant.identity.id,
          grant,
        ]),
      );
      this.access.delegations = [...merged.values()];
    }
    const saved = await this.storage.get(this.prefix() + "access");
    if (saved)
      this.access = await acceptPolicies(
        this.identity,
        JSON.parse(text.decode(saved)) as Policy[],
        this.access,
      );
    else
      await this.storage.set(
        this.prefix() + "access",
        utf8.encode(canonical(this.access.policies)),
      );
    await validateDelegations(
      this.access.policies,
      this.access.delegations ?? [],
    );
    for (const key of await this.storage.keys(this.prefix() + "evicted/"))
      this.evicted.add(key.slice((this.prefix() + "evicted/").length));
    for (const key of await this.storage.keys(this.prefix() + "changes/")) {
      try {
        const saved = JSON.parse(
          text.decode((await this.storage.get(key))!),
        ) as { epoch: number; ciphertext: string };
        const entry = JSON.parse(
          text.decode(
            await decrypt(
              this.access.keys[String(saved.epoch)],
              saved.ciphertext,
              key,
            ),
          ),
        ) as SignedChange;
        if (this.evicted.has(entry.documentId)) {
          await this.storage.delete(key);
          continue;
        }
        await this.acceptInternal(entry, false);
      } catch (error) {
        this.quarantined++;
        this.error = String(error);
      }
    }
    return this;
  }
  private document(id: string) {
    this.assertActive();
    let doc = this.documents.get(id);
    const cold = this.coldDocuments.get(id);
    if (!doc && cold) {
      doc = A.load<DocumentValue>(cold, { actor: this.identity.id });
      this.coldDocuments.delete(id);
      this.documents.set(id, doc);
    }
    return doc;
  }
  heads(id: string) {
    const doc = this.document(id);
    return doc ? A.getHeads(doc) : [];
  }
  hasHeads(id: string, heads: string[]) {
    return (
      heads.length > 0 &&
      heads.every((h) => this.changes.get(h)?.documentId === id)
    );
  }
  /** Move inactive documents into Automerge's compressed binary format. The journal stays indexed. */
  compact(maxLoaded = 128) {
    for (const [id, doc] of this.documents) {
      if (this.documents.size <= maxLoaded) break;
      if (id.startsWith("setting/storage.")) continue;
      this.coldDocuments.set(id, A.save(doc));
      this.documents.delete(id);
      A.free(doc);
    }
  }
  private async publishCatalogInternal(id: string) {
    const record = this.read<ResourceRecord>(id);
    if (!record) return;
    const existing = this.read<{ heads: string[] }>(catalogKey(record.id));
    // A selective replica may keep an older payload while knowing a newer remote head.
    // Releasing that payload must not roll discovery metadata back to the old version.
    if (existing?.heads.some((head) => !this.changes.has(head))) return;
    await this.updateInternal(catalogKey(record.id), {
      id: record.id,
      pluginId: record.managedBy ?? record.pluginId,
      collection: record.collection,
      label: String(
        record.data.title ??
          record.data.name ??
          record.data.subject ??
          record.data.summary ??
          record.id,
      ).slice(0, 200),
      heads: this.heads(id),
    });
  }
  publishCatalog(id: string) {
    return this.serial(() => this.publishCatalogInternal(id));
  }
  evictDocument(id: string, reviewedHeads: string[]) {
    return this.serial(async () => {
      invariant(
        id.startsWith("record/") &&
          canonical(this.heads(id).sort()) ===
            canonical([...reviewedHeads].sort()),
        "STORAGE_CHANGED",
        "The record changed before handoff completed",
      );
      // A durable marker prevents partial cleanup from resurrecting an item after a crash.
      await this.storage.set(this.prefix() + "evicted/" + id, utf8.encode("1"));
      this.evicted.add(id);
      for (const [hash, change] of [...this.changes, ...this.pending])
        if (change.documentId === id) {
          await this.storage.delete(this.prefix() + "changes/" + hash);
          this.changes.delete(hash);
          this.pending.delete(hash);
        }
      const doc = this.documents.get(id);
      if (doc) A.free(doc);
      this.documents.delete(id);
      this.coldDocuments.delete(id);
      for (const listener of this.listeners) listener(id);
    });
  }
  status(): ReplicaStatus {
    return {
      documents: this.ids().length,
      changes: this.changes.size,
      quarantined: this.quarantined,
      pending: this.pending.size,
      peers: this.peers,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  ids(prefix = "") {
    this.assertActive();
    return [
      ...new Set([...this.documents.keys(), ...this.coldDocuments.keys()]),
    ].filter((id) => id.startsWith(prefix));
  }
  read<T = Record<string, unknown>>(id: string): T | undefined {
    const doc = this.document(id);
    return doc?.value ? (structuredClone(A.toJS(doc).value) as T) : undefined;
  }
  conflicts(id: string, field: string, nested = false) {
    const doc = this.document(id);
    if (!doc?.value) return {};
    const object = nested
      ? (doc.value.data as Record<string, unknown>)
      : doc.value;
    return A.getConflicts(object, field) ?? {};
  }
  async update(
    id: string,
    value: Record<string, unknown>,
    resolveFields: string[] = [],
  ) {
    return this.serial(async () => {
      invariant(
        !this.evicted.has(id) &&
          !(
            id.startsWith("record/") &&
            this.read(catalogKey(id.slice(7))) &&
            !this.heads(id).length
          ),
        "NOT_LOCAL",
        "Retain this item on the device before editing it",
      );
      const catalog = id.startsWith("record/")
        ? this.read<{ heads: string[] }>(catalogKey(id.slice(7)))
        : undefined;
      invariant(
        !catalog || catalog.heads.every((h) => this.changes.has(h)),
        "COPY_PENDING",
        "Wait for the complete record history before editing",
      );
      await this.updateInternal(id, value, resolveFields);
      if (id.startsWith("record/")) await this.publishCatalogInternal(id);
    });
  }
  private async updateInternal(
    id: string,
    value: Record<string, unknown>,
    resolveFields: string[] = [],
  ) {
    invariant(
      this.member && this.member.role !== "viewer",
      "PERMISSION_DENIED",
      "This device cannot edit this workspace",
    );
    invariant(
      /^(record|setting|file|event|job|vault)\/[a-zA-Z0-9_.:-]{1,256}$/.test(
        id,
      ),
      "INVALID_DOCUMENT",
      "Invalid document identifier",
    );
    invariant(
      utf8.encode(canonical(value)).length <= 2 * 1024 * 1024,
      "PAYLOAD_TOO_LARGE",
      "Store large content through the file service",
    );
    const previous =
      this.document(id) ?? A.init<DocumentValue>({ actor: this.identity.id });
    const draft = A.clone(previous, { actor: this.identity.id });
    const next = A.change(draft, { message: id }, (doc) => {
      if (!doc.value) doc.value = {};
      // Patch fields individually: replacing the entire record discards concurrent independent edits.
      for (const key of new Set([
        ...Object.keys(doc.value),
        ...Object.keys(value),
      ])) {
        if (!(key in value)) {
          delete doc.value[key];
          continue;
        }
        if (
          key === "data" &&
          value.data &&
          typeof value.data === "object" &&
          !Array.isArray(value.data)
        ) {
          if (!doc.value.data) doc.value.data = {};
          const target = doc.value.data as Record<string, unknown>,
            incoming = value.data as Record<string, unknown>;
          for (const field of new Set([
            ...Object.keys(target),
            ...Object.keys(incoming),
          ])) {
            if (!(field in incoming)) delete target[field];
            else if (
              canonical(target[field]) !== canonical(incoming[field]) ||
              resolveFields.includes("data." + field)
            )
              target[field] = structuredClone(incoming[field]);
          }
        } else if (
          canonical(doc.value[key]) !== canonical(value[key]) ||
          resolveFields.includes(key)
        )
          doc.value[key] = structuredClone(value[key]);
      }
    });
    const change = A.getLastLocalChange(next);
    if (!change || A.getHeads(previous).join() === A.getHeads(next).join())
      return;
    const decoded = A.decodeChange(change);
    const body: ChangeBody = {
      version: 1,
      workspaceId: this.workspaceId,
      documentId: id,
      author: this.identity.id,
      epoch: currentPolicy(this.access).epoch,
      hash: decoded.hash!,
      change: base64(change),
    };
    const entry = {
      ...body,
      signature: await sign(this.identity.privateKey, body),
    };
    await this.acceptInternal(entry, true, true);
    for (const listener of this.outgoing) listener(entry);
  }
  async accept(entry: SignedChange) {
    return this.serial(() => this.acceptInternal(entry, true));
  }
  private async acceptInternal(
    entry: SignedChange,
    persist: boolean,
    localWrite = false,
  ) {
    invariant(
      entry.version === 1 &&
        entry.workspaceId === this.workspaceId &&
        /^[a-f0-9]{64}$/.test(entry.hash),
      "INVALID_CHANGE",
      "Invalid change envelope",
    );
    if (this.changes.has(entry.hash)) return;
    if (persist && !localWrite && !this.wantsDocument(entry.documentId)) return;
    invariant(
      /^(record|setting|file|event|job|vault)\/[a-zA-Z0-9_.:-]{1,256}$/.test(
        entry.documentId,
      ) && entry.change.length <= 4 * 1024 * 1024,
      "INVALID_CHANGE",
      "Change exceeds the document limits",
    );
    const policy = this.access.policies[entry.epoch - 1],
      member = memberAt(this.access, entry.epoch, entry.author);
    invariant(
      member && member.role !== "viewer",
      "PERMISSION_DENIED",
      "Change author was not permitted to write",
    );
    const cutoff =
      currentPolicy(this.access).revoked[entry.author] ??
      (member?.delegatedBy
        ? currentPolicy(this.access).revoked[member.delegatedBy]
        : undefined);
    invariant(
      !cutoff || cutoff.includes(entry.hash),
      "REVOKED",
      "Change was not approved before the device was revoked",
    );
    const { signature, ...body } = entry;
    invariant(
      await verify(member.identity.publicKey, body, signature),
      "INVALID_SIGNATURE",
      "Change signature is invalid",
    );
    const bytes = unbase64(entry.change),
      decoded = A.decodeChange(bytes);
    invariant(
      decoded.actor === entry.author &&
        decoded.hash === entry.hash &&
        decoded.message === entry.documentId,
      "INVALID_CHANGE",
      "Change identity, document binding or hash mismatch",
    );
    if (this.evicted.has(entry.documentId)) {
      await this.storage.delete(this.prefix() + "evicted/" + entry.documentId);
      this.evicted.delete(entry.documentId);
    }
    // Dependencies cannot cross record boundaries, even when their hashes are valid.
    for (const dep of decoded.deps)
      invariant(
        !this.changes.has(dep) ||
          this.changes.get(dep)!.documentId === entry.documentId,
        "INVALID_CHANGE",
        "Cross-document dependency",
      );
    if (decoded.deps.some((dep) => !this.changes.has(dep))) {
      invariant(
        this.pending.size < 10000 || this.pending.has(entry.hash),
        "PAYLOAD_TOO_LARGE",
        "Too many changes awaiting dependencies",
      );
      if (persist) await this.persistChange(entry);
      this.pending.set(entry.hash, entry);
      return;
    }
    const previous =
      this.document(entry.documentId) ??
      A.init<DocumentValue>({ actor: this.identity.id });
    const [next] = A.applyChanges(
      A.clone(previous, { actor: this.identity.id }),
      [bytes],
    );
    if (next.value && !A.getMissingDeps(next, []).length) {
      invariant(
        typeof next.value === "object" && !Array.isArray(next.value),
        "INVALID_CHANGE",
        "Invalid document value",
      );
      invariant(
        utf8.encode(canonical(next.value)).length <= 2 * 1024 * 1024,
        "PAYLOAD_TOO_LARGE",
        "Document exceeds the value limit",
      );
      if (entry.documentId.startsWith("record/")) {
        invariant(
          next.value.id === entry.documentId.slice(7),
          "INVALID_RECORD",
          "Document and resource identity differ",
        );
        this.validateResource(
          next.value as unknown as ResourceRecord,
          previous.value as unknown as ResourceRecord | undefined,
        );
        if (next.value.collection === "credentials")
          invariant(
            next.value.ownerId === member.userId,
            "PERMISSION_DENIED",
            "Only the credential owner may change its authorization",
          );
      } else if (entry.documentId.startsWith("vault/")) {
        invariant(
          next.value.owner === member.userId &&
            (next.value.sender as { id?: string })?.id === entry.author,
          "PERMISSION_DENIED",
          "Only the credential issuer may write secret material",
        );
        if (previous.value)
          invariant(
            previous.value.owner === next.value.owner,
            "PERMISSION_DENIED",
            "Credential ownership cannot change",
          );
      } else if (entry.documentId.startsWith("file/")) {
        const value = next.value;
        invariant(
          value.id === entry.documentId.slice(5) &&
            typeof value.fileId === "string" &&
            Number.isSafeInteger(value.size) &&
            Number(value.size) >= 0 &&
            Number(value.size) <= 512 * 1024 * 1024 &&
            Array.isArray(value.chunks) &&
            value.chunks.length <= 2048 &&
            value.chunks.every(
              (h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h),
            ) &&
            typeof value.checksum === "string" &&
            /^[a-f0-9]{64}$/.test(value.checksum),
          "INVALID_FILE",
          "Invalid file manifest",
        );
        if (previous.value)
          invariant(
            canonical(previous.value) === canonical(value),
            "INVALID_FILE",
            "File versions are immutable",
          );
      } else if (entry.documentId.startsWith("event/")) {
        const event = next.value,
          data = event.data as Record<string, unknown> | undefined;
        invariant(
          event.id === entry.documentId.slice(6) &&
            typeof event.id === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              event.id,
            ) &&
            event.specversion === "1.0" &&
            typeof event.source === "string" &&
            /^\/plugins\/[a-z0-9-]+$/.test(event.source) &&
            typeof event.type === "string" &&
            event.type.startsWith("taskasaur.") &&
            data?.workspaceId === this.workspaceId &&
            typeof data.resourceId === "string",
          "INVALID_EVENT",
          "Invalid workspace event",
        );
        if (previous.value)
          invariant(
            canonical(previous.value) === canonical(event),
            "INVALID_EVENT",
            "Events are immutable",
          );
      } else if (entry.documentId.startsWith("setting/storage.")) {
        await validateStorageControl(
          entry.documentId,
          next.value,
          entry.author,
        );
      } else if (entry.documentId.startsWith("setting/workflow.")) {
        if (previous.value)
          invariant(
            decoded.deps.length === 0 ||
              canonical(previous.value) === canonical(next.value),
            "INVALID_WORKFLOW",
            "Published workflow versions are immutable",
          );
      } else if (entry.documentId.startsWith("setting/service.")) {
        const item = entry.documentId.startsWith("setting/service.execution.");
        invariant(
          item || entry.author === currentPolicy(this.access).owner.id,
          "PERMISSION_DENIED",
          "Only the workspace owner assigns background services",
        );
        if (item) {
          invariant(
            typeof next.value.resourceId === "string" &&
              typeof next.value.slot === "string" &&
              entry.documentId ===
                `setting/service.execution.${next.value.resourceId}.${next.value.slot}` &&
              typeof next.value.enabled === "boolean" &&
              typeof next.value.generation === "string" &&
              typeof next.value.deviceId === "string",
            "INVALID_EXECUTION",
            "Invalid item execution assignment",
          );
          const record = this.read<ResourceRecord>(
            "record/" + next.value.resourceId,
          );
          if (!record) {
            invariant(
              !persist || entry.author !== this.identity.id,
              "NOT_FOUND",
              "Save the item before choosing its computer",
            );
            if (persist) await this.persistChange(entry);
            this.pending.set(entry.hash, entry);
            return;
          }
          invariant(
            record.collection === next.value.collection &&
              record.pluginId === next.value.pluginId,
            "INVALID_EXECUTION",
            "Assignment belongs to a different item",
          );
          invariant(
            /^[a-f0-9]{64}$/.test(String(next.value.deviceId)) &&
              typeof next.value.generation === "string" &&
              /^[a-f0-9-]{36}$/.test(next.value.generation),
            "INVALID_EXECUTION",
            "Invalid execution device or generation",
          );
          if (previous.value?.deviceId === next.value.deviceId)
            invariant(
              previous.value.generation === next.value.generation,
              "INVALID_EXECUTION",
              "A generation changes only when an item moves to another computer",
            );
          if (previous.value)
            invariant(
              previous.value.resourceId === next.value.resourceId &&
                previous.value.pluginId === next.value.pluginId &&
                previous.value.collection === next.value.collection &&
                previous.value.slot === next.value.slot,
              "INVALID_EXECUTION",
              "An execution assignment cannot change its item",
            );
        }
        if (previous.value && previous.value.deviceId !== next.value.deviceId) {
          const token = await serviceToken(previous.value),
            release = this.read<{
              deviceId: string;
              successor?: { deviceId: string; generation: string };
            }>(
              `setting/service-release.${entry.documentId.slice(16)}.${token}`,
            );
          if (!release) {
            invariant(
              !persist || entry.author !== this.identity.id,
              "SERVICE_BUSY",
              "The previous device must release this service before it can move",
            );
            if (persist) await this.persistChange(entry);
            this.pending.set(entry.hash, entry);
            return;
          }
          if (item)
            invariant(
              release.successor?.deviceId === next.value.deviceId &&
                release.successor?.generation === next.value.generation,
              "SERVICE_CHANGED",
              "The previous computer released this item to a different assignment",
            );
          invariant(
            release.deviceId === previous.value.deviceId,
            "PERMISSION_DENIED",
            "Service release belongs to another device",
          );
        }
      } else if (entry.documentId.startsWith("setting/service-release.")) {
        invariant(
          next.value.deviceId === entry.author &&
            entry.documentId.endsWith("." + String(next.value.token)),
          "PERMISSION_DENIED",
          "Only the assigned device can release its service",
        );
        if (previous.value)
          invariant(
            canonical(previous.value) === canonical(next.value),
            "INVALID_CHANGE",
            "Service releases are immutable",
          );
      }
    }
    if (persist) await this.persistChange(entry);
    this.documents.set(entry.documentId, next);
    this.changes.set(entry.hash, entry);
    this.pending.delete(entry.hash);
    for (const listener of this.listeners) listener(entry.documentId);
    // Validate each deferred change with its own signer, never with the signer
    // of the dependency that happened to arrive last.
    for (const waiting of [...this.pending.values()])
      if (
        A.decodeChange(unbase64(waiting.change)).deps.every((dep) =>
          this.changes.has(dep),
        )
      ) {
        this.pending.delete(waiting.hash);
        try {
          await this.acceptInternal(waiting, false);
        } catch (error) {
          this.quarantined++;
          this.error = String(error);
        }
      }
  }
  private async persistChange(entry: SignedChange) {
    const key = this.prefix() + "changes/" + entry.hash,
      epoch = currentPolicy(this.access).epoch;
    const ciphertext = await encrypt(
      this.access.keys[String(epoch)],
      utf8.encode(canonical(entry)),
      key,
    );
    await this.storage.set(key, utf8.encode(canonical({ epoch, ciphertext })));
  }
  private validateResource(record: ResourceRecord, previous?: ResourceRecord) {
    invariant(
      record.workspaceId === this.workspaceId &&
        typeof record.id === "string" &&
        record.data &&
        typeof record.collection === "string",
      "INVALID_RECORD",
      "Resource scope is invalid",
    );
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    invariant(
      uuid.test(record.id) &&
        uuid.test(record.ownerId) &&
        /^[a-z0-9-]+$/.test(record.pluginId) &&
        /^[a-z][a-z0-9_]*$/.test(record.collection) &&
        Number.isSafeInteger(record.revision) &&
        record.revision > 0 &&
        Number.isFinite(Date.parse(record.createdAt)) &&
        Number.isFinite(Date.parse(record.updatedAt)) &&
        (record.deletedAt === null ||
          Number.isFinite(Date.parse(record.deletedAt))) &&
        Number.isSafeInteger(record.schemaVersion ?? 1) &&
        (record.schemaVersion ?? 1) > 0,
      "INVALID_RECORD",
      "Invalid resource metadata",
    );
    if (previous)
      for (const field of [
        "id",
        "workspaceId",
        "ownerId",
        "pluginId",
        "collection",
        "createdAt",
        "managedBy",
      ] as const)
        invariant(
          record[field] === previous[field],
          "INVALID_RECORD",
          `Immutable field changed: ${field}`,
        );
    // Unknown plugin data can replicate without installing or executing its package.
    const schema = schemaById.get(record.collection);
    if (schema) {
      invariant(
        schema.pluginId === record.pluginId,
        "INVALID_RECORD",
        "Collection owner mismatch",
      );
      if ((record.schemaVersion ?? 1) <= schema.version)
        validateRecord(schema, record.data);
    }
  }
  entries(hashes?: string[]) {
    return hashes
      ? hashes.flatMap((h) =>
          this.changes.get(h) ? [this.changes.get(h)!] : [],
        )
      : [...this.changes.values()];
  }
  hashes() {
    return [...this.changes.keys()];
  }
  async setDelegations(incoming: DeviceDelegation[]) {
    invariant(
      Array.isArray(incoming) && incoming.length <= 1000,
      "INVALID_CREDENTIAL",
      "Too many workspace connection grants",
    );
    return this.serial(async () => {
      const grants = new Map(
        (this.access.delegations ?? []).map((grant) => [
          grant.identity.id,
          grant,
        ]),
      );
      for (const grant of incoming) {
        const previous = grants.get(grant.identity.id);
        invariant(
          !previous || canonical(previous) === canonical(grant),
          "INVALID_CREDENTIAL",
          "Conflicting device connection grants",
        );
        grants.set(grant.identity.id, grant);
      }
      const delegations = [...grants.values()];
      await validateDelegations(this.access.policies, delegations);
      if (canonical(delegations) === canonical(this.access.delegations ?? []))
        return;
      await this.storage.set(
        this.prefix() + "delegations",
        utf8.encode(canonical(delegations)),
      );
      this.access.delegations = delegations;
      for (const listener of this.policyListeners) listener();
    });
  }
  async setPolicies(policies: Policy[]) {
    return this.serial(async () => {
      const access = await acceptPolicies(this.identity, policies, this.access);
      await this.storage.set(
        this.prefix() + "access",
        utf8.encode(canonical(policies)),
      );
      this.access = access;
      // Membership changes are owner-signed; never merge them as ordinary editable records.
      const entries = [...this.changes.values(), ...this.pending.values()];
      this.documents.clear();
      this.coldDocuments.clear();
      this.changes.clear();
      this.pending.clear();
      this.quarantined = 0;
      for (const entry of entries)
        try {
          await this.acceptInternal(entry, false);
        } catch {
          this.quarantined++;
        }
      for (const listener of this.policyListeners) listener();
      for (const id of this.ids())
        for (const listener of this.listeners) listener(id);
    });
  }
  async flush() {
    await this.queue;
  }
}
