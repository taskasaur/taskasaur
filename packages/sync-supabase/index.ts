import type { LocalDatabase } from "../data-dexie";
import type { Mutation, ResourceRecord } from "../plugin-sdk";
import { CoreError } from "../core/errors";
import { SyncQueue } from "./queue";
export interface SyncTransport {
  push(mutation: Mutation): Promise<ResourceRecord>;
  pull(cursor: string): Promise<{
    records: ResourceRecord[];
    cursor: string;
    hasMore: boolean;
    authorizedIds?: string[];
    writableIds?: string[];
    workspaceWrite?: boolean;
  }>;
}
export class SyncEngine {
  private queue = new SyncQueue();
  constructor(
    private db: LocalDatabase,
    private transport: SyncTransport,
  ) {}
  async synchronize() {
    return this.queue.run(async () => {
      const blocked = new Set<string>();
      for (const entry of await this.db.outbox.orderBy("sequence").toArray()) {
        if (blocked.has(entry.resourceId)) continue;
        if (entry.state === "conflict" || entry.state === "rejected") {
          blocked.add(entry.resourceId);
          continue;
        }
        const current = await this.db.outbox.get(entry.sequence!);
        if (!current) continue;
        try {
          await this.db.acknowledge(
            entry.id,
            await this.transport.push(current),
          );
        } catch (error) {
          if (
            error instanceof CoreError &&
            [
              "REVISION_CONFLICT",
              "PERMISSION_DENIED",
              "VALIDATION_FAILED",
            ].includes(error.kind)
          ) {
            await this.db.outbox.update(entry.sequence!, {
              state:
                error.kind === "REVISION_CONFLICT" ? "conflict" : "rejected",
              error: error.message,
            });
            blocked.add(entry.resourceId);
          } else throw error;
        }
      }
      for (let page = 0; page < 100; page++) {
        const cursor =
          (await this.db.getMetadata<string>("sync.cursor")) ?? "0";
        const result = await this.transport.pull(cursor);
        await this.db.ingest(result.records, result.cursor);
        if (result.authorizedIds)
          await this.db.reconcileAccess(result.authorizedIds);
        if (result.writableIds)
          await this.db.setMetadata("access.snapshot", {
            writableIds: result.writableIds,
            workspaceWrite: result.workspaceWrite,
            checkedAt: Date.now(),
          });
        if (!result.hasMore) break;
      }
    });
  }
}
