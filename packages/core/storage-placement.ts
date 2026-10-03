import type { Replica } from "./replica";
import type { ReplicaFiles } from "./files";
import { currentPolicy } from "./identity";
import { LocalState } from "./local-state";
import { canonical, digest, utf8 } from "./crypto";
import { invariant } from "@taskasaur/platform/core/errors";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import type {
  StorageItem,
  StorageItemStatus,
  StorageVersion,
} from "@taskasaur/platform/plugin-sdk/storage-placement";

export interface StorageCatalog {
  id: string;
  pluginId: string;
  collection: string;
  label: string;
  heads: string[];
}
export const itemKey = (item: StorageItem) => `${item.kind}.${item.id}`;
export const catalogKey = (id: string) => "setting/storage.catalog." + id;
const ruleKey = (item: StorageItem, device: string) =>
  `setting/storage.want.${itemKey(item)}.${device}`;
const deleteKey = (item: StorageItem, token: string) =>
  `setting/storage.delete.${itemKey(item)}.${token}`;
export const essentialCollections = new Set([
  "devices",
  "tables",
  "files",
  "credentials",
]);
export async function validateStorageControl(
  id: string,
  value: Record<string, unknown>,
  author: string,
) {
  if (id.startsWith("setting/storage.catalog.")) {
    invariant(
      id === catalogKey(String(value.id)) &&
        /^[0-9a-f-]{36}$/.test(String(value.id)) &&
        typeof value.pluginId === "string" &&
        typeof value.collection === "string" &&
        typeof value.label === "string" &&
        value.label.length <= 200 &&
        Array.isArray(value.heads) &&
        value.heads.length <= 128 &&
        value.heads.every(
          (h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h),
        ),
      "INVALID_STORAGE_POLICY",
      "Invalid storage catalog entry",
    );
    return;
  }
  const item = value.item as StorageItem | undefined;
  invariant(
    item &&
      ["record", "file-version"].includes(item.kind) &&
      /^[0-9a-f-]{36}$/.test(item.id),
    "INVALID_STORAGE_POLICY",
    "Invalid storage item",
  );
  if (id.startsWith("setting/storage.want.")) {
    invariant(
      typeof value.keep === "boolean" &&
        /^[a-f0-9]{64}$/.test(String(value.deviceId)) &&
        id === ruleKey(item, String(value.deviceId)),
      "INVALID_STORAGE_POLICY",
      "Invalid copy request",
    );
  } else if (id.startsWith("setting/storage.delete.")) {
    invariant(
      value.confirmed === true &&
        Array.isArray(value.heads) &&
        value.heads.length <= 128 &&
        value.heads.every(
          (h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h),
        ) &&
        /^[a-f0-9]{64}$/.test(String(value.token)) &&
        id === deleteKey(item, String(value.token)),
      "INVALID_STORAGE_POLICY",
      "Deletion requires an explicit version confirmation",
    );
    invariant(
      value.token ===
        (await digest(
          utf8.encode(
            canonical({ item, heads: [...(value.heads as string[])].sort() }),
          ),
        )),
      "INVALID_STORAGE_POLICY",
      "Deletion is not bound to the reviewed version",
    );
  } else if (id.startsWith("setting/storage.receipt.")) {
    invariant(
      value.deviceId === author &&
        id === `setting/storage.receipt.${itemKey(item)}.${author}` &&
        typeof value.retained === "boolean" &&
        /^[a-f0-9]{64}$/.test(String(value.token)),
      "INVALID_STORAGE_RECEIPT",
      "Only the retaining device may acknowledge its copy",
    );
  } else invariant(false, "INVALID_STORAGE_POLICY", "Unknown storage control");
}

/** Placement and handoff use Automerge heads, existing signed peer messages and durable storage. */
export class StoragePlacement {
  private queue: Promise<unknown> = Promise.resolve();
  private local: LocalState;
  readonly listeners = new Set<() => void>();
  constructor(
    readonly replica: Replica,
    readonly files: ReplicaFiles,
  ) {
    this.local = new LocalState(replica, "storage-retention");
    replica.wantsDocument = (id, device = replica.identity.id) => {
      if (!id.startsWith("record/")) return true;
      const record = replica.read<ResourceRecord>(id);
      const catalog = replica.read<StorageCatalog>(catalogKey(id.slice(7)));
      if (
        essentialCollections.has(
          record?.collection ?? catalog?.collection ?? "",
        )
      )
        return true;
      return this.wanted({ kind: "record", id: id.slice(7) }, device);
    };
    files.wantsVersion = (id) => this.wanted({ kind: "file-version", id });
  }
  private serial<T>(work: () => Promise<T>) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  private changed() {
    for (const fn of this.listeners) fn();
  }
  wanted(item: StorageItem, device = this.replica.identity.id) {
    const heads =
      item.kind === "record"
        ? this.replica.heads("record/" + item.id)
        : [
            this.replica.read<{ checksum: string }>("file/" + item.id)
              ?.checksum,
          ].filter(Boolean);
    const known = heads.length
      ? heads
      : (this.replica.read<StorageCatalog>(catalogKey(item.id))?.heads ?? []);
    if (
      this.replica
        .ids("setting/storage.delete." + itemKey(item) + ".")
        .some(
          (id) =>
            canonical(this.replica.read<{ heads: string[] }>(id)?.heads) ===
            canonical([...known].sort()),
        )
    )
      return false;
    const id = ruleKey(item, device),
      value = this.replica.read<{ keep: boolean }>(id);
    // Concurrent enable requests preserve data until the conflict is resolved.
    return (
      !value ||
      value.keep ||
      Object.values(this.replica.conflicts(id, "keep")).some((v) => v === true)
    );
  }
  async version(item: StorageItem): Promise<StorageVersion> {
    const heads =
      item.kind === "record" ? this.replica.heads("record/" + item.id) : [];
    const known = heads.length
      ? heads
      : (this.replica.read<StorageCatalog>(catalogKey(item.id))?.heads ?? []);
    const manifest =
      item.kind === "file-version"
        ? this.replica.read<{ checksum: string }>("file/" + item.id)
        : undefined;
    invariant(
      item.kind === "record" ? known.length : manifest,
      "NOT_FOUND",
      "Storage item is unavailable",
    );
    const normalized =
      item.kind === "record" ? [...known].sort() : [manifest!.checksum];
    return {
      heads: normalized,
      token: await digest(utf8.encode(canonical({ item, heads: normalized }))),
    };
  }
  private deleted(item: StorageItem, token: string) {
    return Boolean(this.replica.read(deleteKey(item, token)));
  }
  async present(item: StorageItem, version: StorageVersion) {
    if (item.kind === "record")
      return (
        canonical(this.replica.heads("record/" + item.id).sort()) ===
        canonical(version.heads)
      );
    return this.files.hasVersion(item.id);
  }
  async list() {
    const recordIds = new Set([
      ...this.replica.ids("record/").map((id) => id.slice(7)),
      ...this.replica
        .ids("setting/storage.catalog.")
        .map((id) => id.slice("setting/storage.catalog.".length)),
    ]);
    const items: StorageItem[] = [...recordIds]
      .filter((id) => {
        const record = this.replica.read<ResourceRecord>("record/" + id),
          meta = this.replica.read<StorageCatalog>(catalogKey(id));
        return !essentialCollections.has(
          record?.collection ?? meta?.collection ?? "",
        );
      })
      .map((id) => ({ kind: "record", id }));
    items.push(
      ...this.files
        .manifests()
        .map((m) => ({ kind: "file-version" as const, id: m.id })),
    );
    return Promise.all(items.map((item) => this.status(item)));
  }
  async status(item: StorageItem): Promise<StorageItemStatus> {
    const version = await this.version(item),
      local = await this.present(item, version);
    const record =
      item.kind === "record"
        ? this.replica.read<ResourceRecord>("record/" + item.id)
        : undefined;
    const meta = this.replica.read<StorageCatalog>(catalogKey(item.id));
    const manifest =
      item.kind === "file-version"
        ? this.files.manifests().find((m) => m.id === item.id)
        : undefined;
    const file =
      manifest &&
      this.replica.read<ResourceRecord>("record/" + manifest.fileId);
    return {
      item,
      version,
      local,
      deleted: this.deleted(item, version.token),
      label: record
        ? String(
            record.data.title ??
              record.data.name ??
              record.data.subject ??
              record.data.summary ??
              record.id,
          )
        : (meta?.label ??
          (file ? String(file.data.name) : "File version") +
            " · " +
            item.id.slice(0, 8)),
      pluginId:
        record?.managedBy ??
        record?.pluginId ??
        meta?.pluginId ??
        file?.managedBy ??
        "files",
      collection: record?.collection ?? meta?.collection ?? "files",
      copies: Object.keys(currentPolicy(this.replica.access).members).map(
        (deviceId) => {
          const receipt = this.replica.read<{
            retained: boolean;
            token: string;
          }>(`setting/storage.receipt.${itemKey(item)}.${deviceId}`);
          return {
            deviceId,
            requested: this.wanted(item, deviceId),
            retained:
              deviceId === this.replica.identity.id
                ? local
                : Boolean(receipt?.retained && receipt.token === version.token),
            version: receipt?.token,
          };
        },
      ),
    };
  }
  async setCopy(item: StorageItem, deviceId: string, keep: boolean) {
    invariant(
      this.replica.member.role !== "viewer" &&
        currentPolicy(this.replica.access).members[deviceId],
      "PERMISSION_DENIED",
      "An editor may configure approved devices",
    );
    const status = await this.status(item);
    invariant(
      !status.deleted,
      "VERSION_DELETED",
      "This version has been deleted",
    );
    invariant(
      !essentialCollections.has(
        item.kind === "record" ? status.collection : "",
      ),
      "CORE_METADATA",
      "Core routing metadata stays on every device",
    );
    await this.replica.update(ruleKey(item, deviceId), {
      item,
      deviceId,
      keep,
    });
    this.changed();
  }
  async deleteVersion(item: StorageItem, reviewedToken: string) {
    const version = await this.version(item);
    invariant(
      version.token === reviewedToken,
      "STORAGE_CHANGED",
      "The item changed. Review its current version before deleting",
    );
    const status = await this.status(item);
    invariant(
      !essentialCollections.has(
        item.kind === "record" ? status.collection : "",
      ),
      "CORE_METADATA",
      "Core routing metadata cannot be deleted here",
    );
    if (item.kind === "record")
      await this.replica.publishCatalog("record/" + item.id);
    await this.replica.update(deleteKey(item, version.token), {
      item,
      ...version,
      confirmed: true,
    });
    this.changed();
  }
  /** Only a live request can create a durable retention promise, never a received command record. */
  retain(item: StorageItem, version: StorageVersion) {
    return this.serial(async () => {
      const current = await this.version(item);
      invariant(
        version.token ===
          (await digest(
            utf8.encode(canonical({ item, heads: [...version.heads].sort() })),
          )),
        "STORAGE_CHANGED",
        "Invalid reviewed version",
      );
      const includesVersion =
        item.kind === "record"
          ? this.replica.hasHeads("record/" + item.id, version.heads)
          : current.token === version.token;
      invariant(
        includesVersion,
        "STORAGE_CHANGED",
        "The requested version is unavailable",
      );
      invariant(
        this.wanted(item) && !this.deleted(item, current.token),
        "COPY_NOT_REQUESTED",
        "This device is not retaining this item",
      );
      invariant(
        await this.present(item, current),
        "COPY_PENDING",
        "This device has not durably received this version",
      );
      await this.local.set(itemKey(item), { item, ...version, retained: true });
      await this.receipt(item, current, true);
      return {
        deviceId: this.replica.identity.id,
        token: version.token,
        heads: version.heads,
      };
    });
  }
  private async receipt(
    item: StorageItem,
    version: StorageVersion,
    retained: boolean,
  ) {
    if (this.replica.member.role === "viewer") return;
    const id = `setting/storage.receipt.${itemKey(item)}.${this.replica.identity.id}`;
    const value = {
      item,
      deviceId: this.replica.identity.id,
      token: version.token,
      retained,
    };
    if (canonical(this.replica.read(id)) !== canonical(value))
      await this.replica.update(id, value);
  }
  async reconcile(
    retainElsewhere: (
      item: StorageItem,
      version: StorageVersion,
    ) => Promise<boolean>,
  ) {
    {
      for (const manifest of this.files.manifests())
        if (
          this.wanted({ kind: "file-version", id: manifest.id }) &&
          !this.files.retainedVersion(manifest.id)
        ) {
          try {
            await this.files.read(manifest.id, true);
            await this.files.markRetained(manifest.id);
          } catch (error) {
            if ((error as { kind?: string }).kind !== "OFFLINE_UNAVAILABLE")
              throw error;
          }
        }
      for (const status of await this.list()) {
        if (!status.local) continue;
        if (!status.deleted && this.wanted(status.item)) {
          await this.receipt(status.item, status.version, true);
          continue;
        }
        // Bind handoff to this exact placement decision. A delayed acknowledgement
        // must not authorize a later off/on/off sequence after the other peer releases.
        const decision = canonical(
          this.replica
            .heads(ruleKey(status.item, this.replica.identity.id))
            .sort(),
        );
        const epoch = currentPolicy(this.replica.access).epoch;
        if (
          !status.deleted &&
          !(await retainElsewhere(status.item, status.version))
        )
          continue;
        await this.serial(async () => {
          // A later edit, enable request or new head invalidates the pending removal.
          const current = await this.version(status.item);
          if (
            current.token !== status.version.token ||
            (!status.deleted &&
              (this.wanted(status.item) ||
                epoch !== currentPolicy(this.replica.access).epoch ||
                decision !==
                  canonical(
                    this.replica
                      .heads(ruleKey(status.item, this.replica.identity.id))
                      .sort(),
                  )))
          )
            return;
          await this.local.set(itemKey(status.item), {
            item: status.item,
            ...current,
            retained: false,
          });
          if (status.item.kind === "record") {
            if (this.replica.member.role !== "viewer")
              await this.replica.publishCatalog("record/" + status.item.id);
            await this.replica.evictDocument(
              "record/" + status.item.id,
              current.heads,
            );
          } else await this.files.evictVersion(status.item.id);
          await this.receipt(status.item, current, false);
          this.changed();
        });
      }
    }
  }
  async bootstrap() {
    if (this.replica.member.role === "viewer") return;
    for (const id of this.replica.ids("record/"))
      if (!this.replica.read(catalogKey(id.slice(7))))
        await this.replica.publishCatalog(id);
  }
}
