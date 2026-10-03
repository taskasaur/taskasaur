// A caller joining an in-flight pass may have saved data after that pass took
// its snapshot. Run one additional pass before resolving any joined callers.
export class SyncQueue {
  private running?: Promise<void>;
  private requested = false;

  run(pass: () => Promise<void>): Promise<void> {
    this.requested = true;
    if (!this.running) {
      this.running = (async () => {
        do {
          this.requested = false;
          await pass();
        } while (this.requested);
      })().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }
}
