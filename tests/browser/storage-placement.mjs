import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createWorkspace, navigate } from "./navigation-helpers.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  const click = (name) =>
    page.getByRole("button", { name, exact: true }).click();
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58597");
  await createWorkspace(page);
  await navigate(page, "Variables");
  await click("New entry");
  await page.getByLabel("Name", { exact: true }).fill("Last retained record");
  await click("Save");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await click("Storage copies");
  await expect(
    page.getByRole("heading", { name: "Storage copies", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Verified copy", { exact: true })).toBeVisible();
  await page.getByRole("switch").click();
  await expect(page.getByRole("dialog")).toContainText(
    "Keep a copy or delete this version?",
  );
  await click("Keep pending copies");
  await expect(
    page.getByText("Retained until safe handoff", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Retained until safe handoff", { exact: true }),
  ).toBeVisible();
  await navigate(page, "Variables");
  await expect(page.locator("[data-record-id]")).toContainText(
    "Last retained record",
  );
  await click("Storage copies");
  await click("Delete version…");
  await click("Delete this version everywhere");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/Deletion requested/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Deletion requested/)).toBeVisible();
  await navigate(page, "Variables");
  await expect(page.locator("[data-record-id]")).toHaveCount(0);
  await navigate(page, "Files");
  await page.locator('input[type="file"]').setInputFiles({
    name: "placement.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Versioned storage test"),
  });
  await expect(page.locator("[data-record-id]")).toContainText("placement.txt");
  const searchFiles = async () => {
    await click("Open plugins menu");
    await click("Search");
    await page
      .getByRole("combobox", { name: "Search content and commands" })
      .fill("Versioned storage test");
  };
  await searchFiles();
  await expect(
    page.getByRole("option").filter({ hasText: "placement.txt" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await click("Storage copies");
  await expect(page.getByText(/File version/).first()).toBeVisible();
  await click("Delete version…");
  await click("Delete this version everywhere");
  await expect(page.getByText(/Deletion requested/)).toBeVisible();
  await searchFiles();
  await expect(
    page.getByText("No results found.", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Storage copies", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/taskasaur-storage-mobile.png",
    fullPage: true,
  });
  await navigate(page, "Settings");
  await click("Manage storage copies");
  await expect(
    page.getByRole("heading", { name: "Storage copies", exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "Record/file storage controls, pending last copy, explicit deletion, reload and mobile navigation passed",
  );
} finally {
  await browser.close();
}
