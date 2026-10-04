import { readFile } from "node:fs/promises";
import path from "node:path";
/** Optional local release review; normal CI always downloads published, pinned artifacts. */
export async function reviewInventory(context) {
  const filename = process.env.TASKASAUR_TEST_INVENTORY;
  if (!filename) return;
  const inventory = JSON.parse(await readFile(filename, "utf8"));
  await context.route("**/plugins.json", (route) =>
    route.fulfill({ json: inventory }),
  );
  for (const entry of inventory.plugins) {
    const file = path.resolve(
      path.dirname(filename),
      `../taskasaur-plugin-${entry.id}/releases/${entry.id}-${entry.version}.zip`,
    );
    let body;
    try {
      body = await readFile(file);
    } catch {
      continue;
    }
    await context.route(entry.downloadUrl, (route) =>
      route.fulfill({ body, contentType: "application/zip" }),
    );
  }
}
