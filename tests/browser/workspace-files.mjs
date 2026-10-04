import { chromium, expect } from "@playwright/test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { navigate } from "./navigation-helpers.mjs";
const liveFile = process.env.TEST_WORKSPACE_KIND === "file";
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  directory = await mkdtemp(path.join(tmpdir(), "taskasaur-workspace-ui-"));
try {
  const a = await browser.newContext(),
    b = await browser.newContext(),
    first = await a.newPage(),
    second = await b.newPage(),
    errors = [];
  for (const page of [first, second]) {
    page.setDefaultTimeout(30000);
    page.on("pageerror", (e) => errors.push(e.message));
  }
  const url = process.env.TEST_APP_URL ?? "http://127.0.0.1:4177";
  const click = (page, name) =>
    page.getByRole("button", { name, exact: true }).click();
  for (const context of [a, b])
    await context.addInitScript(() => {
      const file = async () =>
        (await navigator.storage.getDirectory()).getFileHandle(
          "workspace.taskasaur",
          { create: true },
        );
      window.showSaveFilePicker = file;
      window.showOpenFilePicker = async () => [await file()];
      window.showDirectoryPicker = async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle(
          "workspace",
          {
            create: true,
          },
        );
    });
  await first.goto(url);
  await click(first, "Create workspace");
  await navigate(first, "Settings");
  await click(
    first,
    liveFile ? "Save and work from file" : "Save and work from folder",
  );
  await expect(first.getByRole("status")).toContainText(
    "Workspace writes now go directly",
  );
  await navigate(first, "Files");
  await first.locator('input[type="file"]').setInputFiles({
    name: "portable.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Whole workspace file bytes"),
  });
  await expect(
    first.getByRole("button", { name: "portable.txt", exact: true }),
  ).toBeVisible();
  await navigate(first, "Variables");
  await click(first, "New entry");
  await first.getByLabel("Name", { exact: true }).fill("Portable variable");
  await first.getByLabel("Value type", { exact: true }).click();
  await first.getByRole("option", { name: "text", exact: true }).click();
  await click(first, "Add optional fields");
  await first.getByLabel("Value", { exact: true }).fill('"A shared value"');
  await click(first, "Save");
  await expect(first.getByRole("dialog")).toHaveCount(0);
  const fileManifest = async (page) => {
    const bytes = await page.evaluate(async () =>
      Array.from(
        new Uint8Array(
          await (
            await (
              await navigator.storage.getDirectory()
            ).getFileHandle("workspace.taskasaur")
          )
            .getFile()
            .then((f) => f.arrayBuffer()),
        ),
      ),
    );
    const zip = await JSZip.loadAsync(new Uint8Array(bytes));
    return JSON.parse(await zip.file("workspace.json").async("string"));
  };
  const folderBefore = liveFile
    ? await fileManifest(first)
    : await first.evaluate(async () =>
        JSON.parse(
          await (
            await (
              await (
                await navigator.storage.getDirectory()
              ).getDirectoryHandle("workspace")
            ).getFileHandle("workspace.json")
          )
            .getFile()
            .then((f) => f.text()),
        ),
      );
  expect(
    Object.keys(folderBefore.entries).some((k) => k.includes("/blobs/")),
  ).toBe(true);
  await first.reload();
  await navigate(first, "Variables");
  await expect(
    first.locator('[data-record-collection="variables"]'),
  ).toContainText("Portable variable");
  await navigate(first, "Settings");
  await first.getByLabel("Color theme", { exact: true }).click();
  await first.getByRole("option", { name: "Dark", exact: true }).click();
  const downloaded = first.waitForEvent("download");
  await click(first, "Export complete workspace");
  const file = await downloaded,
    archive = path.join(directory, "workspace.taskasaur");
  await file.saveAs(archive);
  const zip = await JSZip.loadAsync(await readFile(archive)),
    manifest = JSON.parse(await zip.file("workspace.json").async("string"));
  expect(
    Object.keys(manifest.entries).some((k) =>
      /identity|\/local\/|network\//.test(k),
    ),
  ).toBe(false);
  await second.goto(url);
  if (liveFile) {
    await second.evaluate(
      async (bytes) => {
        const handle = await (
          await navigator.storage.getDirectory()
        ).getFileHandle("workspace.taskasaur", { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array(bytes));
        await writable.close();
      },
      Array.from(await readFile(archive)),
    );
    await click(second, "Open workspace file");
  } else
    await second
      .getByLabel("Workspace archive", { exact: true })
      .setInputFiles(archive);
  await expect(
    second.getByLabel("Workspace file device request", { exact: true }),
  ).not.toHaveValue("");
  await click(
    second,
    liveFile ? "Open and write to file" : "Import and open workspace",
  );
  await expect(second.getByRole("alert")).toContainText("Approve this device");
  const request = await second
    .getByLabel("Workspace file device request", { exact: true })
    .inputValue();
  await navigate(first, "Devices");
  await first.getByLabel("Device request", { exact: true }).fill(request);
  await click(first, "Approve device");
  await expect(
    first.getByRole("textbox", { name: "Encrypted invitation", exact: true }),
  ).not.toHaveValue("");
  await second
    .getByLabel("Workspace file approval", { exact: true })
    .fill(
      await first
        .getByRole("textbox", { name: "Encrypted invitation", exact: true })
        .inputValue(),
    );
  await a.close(); // The original writer is closed before the new identity restores.
  await click(
    second,
    liveFile ? "Open and write to file" : "Import and open workspace",
  );
  await expect(
    second.getByRole("button", { name: "Open settings menu", exact: true }),
  ).toBeVisible();
  await navigate(second, "Variables");
  await expect(
    second.locator('[data-record-collection="variables"]'),
  ).toContainText("Portable variable");
  await navigate(second, "Files");
  const restored = second.waitForEvent("download");
  await click(second, "portable.txt");
  const restoredFile = path.join(directory, "restored.txt");
  await (await restored).saveAs(restoredFile);
  expect(await readFile(restoredFile, "utf8")).toBe(
    "Whole workspace file bytes",
  );
  if (liveFile) {
    const after = await fileManifest(second);
    expect(after.packageId).toBe(manifest.packageId);
    expect(after.workspace.policies.length).toBeGreaterThan(
      manifest.workspace.policies.length,
    );
    expect(after.revision).toBeGreaterThan(manifest.revision);
  }
  await navigate(second, "Settings");
  await expect(
    second.getByLabel("Color theme", { exact: true }),
  ).not.toContainText("Dark");
  await second.evaluate(() => navigator.serviceWorker.ready);
  await b.setOffline(true);
  await second.reload();
  await navigate(second, "Files");
  await expect(
    second.getByRole("button", { name: "portable.txt", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    `${liveFile ? "Live single-file" : "Folder and archive"} writes, identity exclusion, approval, original-device shutdown, byte-exact restore and offline restart passed.`,
  );
} catch (e) {
  console.error(e);
  throw e;
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
