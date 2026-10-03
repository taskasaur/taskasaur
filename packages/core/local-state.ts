import type { Replica } from "./replica";
import { currentPolicy } from "./identity";
import { encrypt, decrypt, utf8, text, canonical } from "./crypto";
/** Encrypted device-only checkpoints, never interpreted from replicated workspace data. */
export class LocalState {
  private static queues = new WeakMap<Replica, Map<string, Promise<unknown>>>();
  constructor(
    readonly replica: Replica,
    readonly namespace: string,
  ) {}
  private key(id: string) {
    return `workspace/${this.replica.workspaceId}/local/${this.namespace}/${id}`;
  }
  async get<T>(id: string): Promise<T | undefined> {
    const key = this.key(id),
      stored = await this.replica.storage.get(key);
    if (!stored) return;
    const value = JSON.parse(text.decode(stored));
    return JSON.parse(
      text.decode(
        await decrypt(
          this.replica.access.keys[String(value.epoch)],
          value.ciphertext,
          key,
        ),
      ),
    );
  }
  async update<T>(
    id: string,
    change: (prior: T | undefined) => T | Promise<T>,
  ): Promise<T> {
    let queues = LocalState.queues.get(this.replica);
    if (!queues) {
      queues = new Map();
      LocalState.queues.set(this.replica, queues);
    }
    const key = this.key(id),
      pending = (queues.get(key) ?? Promise.resolve()).then(async () => {
        const value = await change(await this.get<T>(id)),
          epoch = currentPolicy(this.replica.access).epoch;
        await this.replica.storage.set(
          key,
          utf8.encode(
            canonical({
              epoch,
              ciphertext: await encrypt(
                this.replica.access.keys[String(epoch)],
                utf8.encode(canonical(value)),
                key,
              ),
            }),
          ),
        );
        return value;
      });
    queues.set(
      key,
      pending.catch(() => {}),
    );
    return pending;
  }
  async set(id: string, value: unknown) {
    await this.update(id, () => value);
  }
  async ids() {
    const prefix = this.key("");
    return (await this.replica.storage.keys(prefix)).map((key) =>
      key.slice(prefix.length),
    );
  }
}
