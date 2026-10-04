import { chromium, expect } from "@playwright/test";
import {
  createWorkspace,
  leaveWorkspace,
  navigate,
} from "./navigation-helpers.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4177");
  await createWorkspace(page, "Delete A");
  const id = await page.evaluate(() =>
    localStorage.getItem("taskasaur.active-workspace"),
  );
  await navigate(page, "Files");
  await page
    .locator('input[type="file"]')
    .setInputFiles({
      name: "remove.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Remove these file bytes"),
    });
  await expect(
    page.getByRole("button", { name: "remove.txt", exact: true }),
  ).toBeVisible();
  await leaveWorkspace(page);
  await createWorkspace(page, "Delete B");
  await leaveWorkspace(page);
  await createWorkspace(page, "Keep C");
  await leaveWorkspace(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Open internal workspace", { exact: true }).click();
  const picker = page.getByLabel("Internal workspaces", { exact: true });
  await picker
    .getByRole("button", { name: "Delete Delete A", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog", {
    name: "Delete workspace?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Delete A", { exact: true })).toBeVisible();
  const confirm = dialog.getByRole("button", {
    name: "Delete workspace",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByLabel("Workspace name to confirm deletion")
    .fill("delete a");
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("button", { name: "Delete A", exact: true }),
  ).toBeVisible();
  await picker
    .getByRole("button", { name: "Delete Delete A", exact: true })
    .click();
  await dialog
    .getByLabel("Workspace name to confirm deletion")
    .fill("Delete A");
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("button", { name: "Delete A", exact: true }),
  ).toHaveCount(0);
  const databases = await page.evaluate(async () =>
    (await indexedDB.databases()).map((db) => db.name),
  );
  expect(databases.some((name) => name.includes(id))).toBe(false);
  await picker
    .getByRole("button", { name: "Delete Delete B", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Workspace name to confirm deletion"),
  ).toHaveValue("");
  await dialog
    .getByLabel("Workspace name to confirm deletion")
    .fill("Delete B");
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(picker).toBeVisible();
  await page.screenshot({
    path: "/tmp/taskasaur-workspace-picker-deletion.png",
  });
  await picker.getByRole("button", { name: "Keep C", exact: true }).click();
  await navigate(page, "Settings");
  await page
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  await expect(dialog.getByText("Keep C", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/taskasaur-delete-dialog-mobile.png" });
  await dialog.getByLabel("Workspace name to confirm deletion").fill("Keep C");
  await confirm.click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Open internal workspace", { exact: true }).click();
  await expect(
    picker.getByText("No internal workspaces", { exact: true }),
  ).toBeVisible();
  const remaining = await page.evaluate(async () =>
    (await indexedDB.databases()).map((db) => db.name),
  );
  expect(
    remaining.filter(
      (name) =>
        name.startsWith("taskasaur-peer-v1.workspace.") ||
        name.startsWith("taskasaur-v2-"),
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
  console.log(
    "Exact-name confirmation, cancel, repeated deletion with the picker open, Settings deletion, physical data cleanup and reload passed.",
  );
} finally {
  await browser.close();
}
