/** Automerge actor sequences require one active writer per device profile. */
export async function acquireWriter() {
  if (!navigator.locks)
    throw Error(
      "This browser needs Web Locks support to safely open a local replica.",
    );
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request(
        "taskasaur-device-writer",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            reject(
              Error(
                "Taskasaur is already open in another tab. Close that tab before opening this workspace.",
              ),
            );
            return;
          }
          resolve();
          await held;
        },
      )
      .catch(reject);
  });
  return release;
}
