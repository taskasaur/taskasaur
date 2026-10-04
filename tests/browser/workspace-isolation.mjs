import { chromium, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  createWorkspace,
  leaveWorkspace,
  navigate,
} from "./navigation-helpers.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const directory = await mkdtemp(path.join(tmpdir(), "taskasaur-isolation-ui-"));
const url = process.env.TEST_APP_URL ?? "http://127.0.0.1:4177";
try {
  const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    }),
    page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  await context.addInitScript(() => {
    const file = async () =>
      (await navigator.storage.getDirectory()).getFileHandle("live.taskasaur", {
        create: true,
      });
    window.showSaveFilePicker = file;
    window.showOpenFilePicker = async () => [await file()];
  });
  const click = (name) =>
    page.getByRole("button", { name, exact: true }).click();
  await page.goto(url);
  await expect(page.getByAltText("Taskasaur")).toBeVisible();
  await expect(
    page.getByText(
      "Your workspace lives on this device. Work offline and synchronize directly with your approved devices.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/taskasaur-welcome-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/taskasaur-welcome-mobile.png" });
  await click("Join");
  await expect(page.getByAltText("Taskasaur")).toHaveCount(0);
  await expect(
    page.getByLabel("Device request", { exact: true }),
  ).not.toHaveValue("");
  expect(
    await page
      .getByLabel("Device request", { exact: true })
      .evaluate((element) => element.tagName),
  ).toBe("INPUT");
  await expect(
    page.getByLabel("Workspace invitation", { exact: true }),
  ).toBeVisible();
  await click("Copy device request");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await page.getByLabel("Device request", { exact: true }).inputValue(),
  );
  await expect(page.getByRole("status")).toHaveText("Device request copied");
  await page.screenshot({ path: "/tmp/taskasaur-join-mobile.png" });
  await click("Back");
  await page.setViewportSize({ width: 1280, height: 900 });
  await createWorkspace(page, "Workspace A");
  const workspaceA = await page.evaluate(() =>
    localStorage.getItem("taskasaur.active-workspace"),
  );
  await navigate(page, "Files");
  await page.locator('input[type="file"]').setInputFiles({
    name: "only-in-a.odt",
    mimeType: "application/vnd.oasis.opendocument.text",
    buffer: Buffer.from("Workspace A file bytes"),
  });
  await expect(
    page.getByRole("button", { name: "only-in-a.odt", exact: true }),
  ).toBeVisible();
  await navigate(page, "Settings");
  await expect(
    page.getByRole("switch", { name: "Include credentials", exact: true }),
  ).toHaveCount(0);
  const downloaded = page.waitForEvent("download");
  await click("Export complete workspace");
  const archive = path.join(directory, "portable.taskasaur");
  await (await downloaded).saveAs(archive);
  const zip = await JSZip.loadAsync(await readFile(archive));
  const manifest = JSON.parse(await zip.file("workspace.json").async("string"));
  expect(manifest.connectionCredential).toBeDefined();
  await leaveWorkspace(page);
  await createWorkspace(page, "Workspace B");
  const workspaceB = await page.evaluate(() =>
    localStorage.getItem("taskasaur.active-workspace"),
  );
  expect(workspaceA).not.toBe(workspaceB);
  await navigate(page, "Files");
  await expect(
    page.getByRole("button", { name: "only-in-a.odt", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Workspace B");
  await navigate(page, "Files");
  await expect(
    page.getByRole("button", { name: "only-in-a.odt", exact: true }),
  ).toHaveCount(0);
  const databases = await page.evaluate(async () =>
    (await indexedDB.databases()).map((db) => db.name),
  );
  expect(databases).toContain(`taskasaur-peer-v1.workspace.${workspaceA}`);
  expect(databases).toContain(`taskasaur-peer-v1.workspace.${workspaceB}`);
  await leaveWorkspace(page);
  await page.reload();
  await click("Open");
  await page.getByLabel("Open internal workspace", { exact: true }).click();
  await page.getByRole("option", { name: "Workspace A", exact: true }).click();
  await navigate(page, "Files");
  await expect(
    page.getByRole("button", { name: "only-in-a.odt", exact: true }),
  ).toBeVisible();
  await leaveWorkspace(page);

  const other = await browser.newContext(),
    second = await other.newPage();
  await second.goto(url);
  await second.getByRole("button", { name: "Join", exact: true }).click();
  await expect(
    second.getByLabel("Device request", { exact: true }),
  ).not.toHaveValue("");
  const otherIdentity = JSON.parse(
    await second.getByLabel("Device request", { exact: true }).inputValue(),
  ).identity.id;
  await second.getByRole("button", { name: "Back", exact: true }).click();
  await second.getByRole("button", { name: "Open", exact: true }).click();
  await second
    .getByLabel("Workspace archive", { exact: true })
    .setInputFiles(archive);
  await navigate(second, "Files");
  await expect(
    second.getByRole("button", { name: "only-in-a.odt", exact: true }),
  ).toBeVisible();
  expect(otherIdentity).not.toBe(manifest.workspace.policies[0].owner.id);
  await other.close();

  await click("Create");
  await expect(
    page.getByText(
      "Create an internal workspace or file based .taskasaur file.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("separator")).toHaveCount(1);
  await expect(
    page.getByRole("group", { name: "File workspace", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/taskasaur-create-desktop.png" });
  await page
    .getByRole("switch", { name: "Encrypt workspace file", exact: true })
    .click();
  await page
    .getByLabel("New workspace password", { exact: true })
    .fill("browser workspace password");
  await expect(
    page.getByRole("switch", { name: "Include credentials", exact: true }),
  ).toHaveCount(0);
  await click("Create file workspace");
  await navigate(page, "Files");
  await page.locator('input[type="file"]').setInputFiles({
    name: "encrypted.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Encrypted live bytes"),
  });
  await expect(
    page.getByRole("button", { name: "encrypted.txt", exact: true }),
  ).toBeVisible();
  const encrypted = await page.evaluate(async () =>
    new TextDecoder().decode(
      new Uint8Array(
        await (
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle("live.taskasaur")
        )
          .getFile()
          .then((f) => f.arrayBuffer()),
      ).slice(0, "TASKASAUR-ENCRYPTED-1\n".length),
    ),
  );
  expect(encrypted).toBe("TASKASAUR-ENCRYPTED-1\n");
  await leaveWorkspace(page);
  await click("Open");
  await expect(page.getByRole("separator")).toHaveCount(1);
  await expect(
    page.getByRole("group", { name: "File workspace", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/taskasaur-open-desktop.png" });
  await page.getByLabel("Open internal workspace", { exact: true }).click();
  await expect(
    page.getByRole("option", { name: "live", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("option", { name: "Workspace A", exact: true })
    .press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await click("Open file workspace");
  await expect(
    page.getByRole("dialog", { name: "Unlock workspace" }),
  ).toBeVisible();
  await page
    .getByLabel("Workspace password", { exact: true })
    .fill("browser workspace password");
  await click("Unlock");
  await navigate(page, "Files");
  await expect(
    page.getByRole("button", { name: "encrypted.txt", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "only-in-a.odt", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page
    .getByLabel("Workspace password", { exact: true })
    .fill("browser workspace password");
  await click("Unlock");
  await navigate(page, "Files");
  await expect(
    page.getByRole("button", { name: "encrypted.txt", exact: true }),
  ).toBeVisible();
  // Browsers without direct file access still create a real portable file.
  const fallbackContext = await browser.newContext();
  await fallbackContext.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showOpenFilePicker;
    // Exercise the clipboard fallback used by embedded browsers.
    Object.defineProperty(navigator, "clipboard", { value: undefined });
  });
  const fallback = await fallbackContext.newPage();
  fallback.on("pageerror", (error) => errors.push(error.message));
  await fallback.goto(url);
  await fallback.getByRole("button", { name: "Join", exact: true }).click();
  await fallback
    .getByRole("button", { name: "Copy device request", exact: true })
    .click();
  await expect(fallback.getByRole("status")).toHaveText(
    "Device request copied",
  );
  await fallback.getByRole("button", { name: "Back", exact: true }).click();
  await fallback.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    fallback.getByRole("button", {
      name: "Create file workspace",
      exact: true,
    }),
  ).toBeEnabled();
  await fallback.setViewportSize({ width: 390, height: 844 });
  await fallback.screenshot({
    path: "/tmp/taskasaur-create-fallback-mobile.png",
  });
  const fallbackDownload = fallback.waitForEvent("download");
  await fallback
    .getByRole("button", { name: "Create file workspace", exact: true })
    .click();
  const fallbackArchive = path.join(directory, "fallback.taskasaur");
  await (await fallbackDownload).saveAs(fallbackArchive);
  await expect(
    fallback.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Workspace");
  const fallbackZip = await JSZip.loadAsync(await readFile(fallbackArchive));
  const fallbackManifest = JSON.parse(
    await fallbackZip.file("workspace.json").async("string"),
  );
  expect(fallbackManifest.connectionCredential).toBeDefined();
  await fallback.reload();
  await expect(
    fallback.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Workspace");
  await fallbackContext.close();
  const reopenedContext = await browser.newContext();
  const reopened = await reopenedContext.newPage();
  await reopened.goto(url);
  await reopened.getByRole("button", { name: "Open", exact: true }).click();
  await reopened
    .getByLabel("Workspace archive", { exact: true })
    .setInputFiles(fallbackArchive);
  await expect(
    reopened.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Workspace");
  await expect(
    reopened.getByLabel("Workspace file device request", { exact: true }),
  ).toHaveCount(0);
  await reopenedContext.close();
  expect(errors).toEqual([]);
  console.log(
    "Welcome layouts, request copying, separate databases, automatic credentials, fresh-device import, encrypted live-file reopen and file creation without picker support passed.",
  );
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
