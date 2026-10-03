import type { Value } from "@taskasaur/platform/field-types";
export function runBrowserTypeScript(
  source: string,
  input: Value,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./code-worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(Error("TypeScript node exceeded its 10 second limit"));
    }, 10000);
    worker.onmessage = (event) => {
      finish();
      if (event.data.error) reject(Error(event.data.error));
      else resolve(event.data.value);
    };
    worker.onerror = () => {
      finish();
      reject(Error("TypeScript worker failed"));
    };
    worker.postMessage({ source, input });
  });
}
