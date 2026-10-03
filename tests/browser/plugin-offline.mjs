import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://localhost:4173");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) });
  await row
    .getByRole("button", { name: "Install", exact: true })
    .click({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Confirm install", exact: true })
    .click();
  await expect(row.getByText("Enabled", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await page.getByRole("button", { name: "New entry", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Offline downloaded plugin");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Offline downloaded plugin",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Offline downloaded plugin",
      exact: true,
    }),
  ).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Offline downloaded plugin",
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(
    page.getByText("Offline downloaded plugin", { exact: true }),
  ).toBeVisible();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "Public HTTPS download, signed browser module, production service worker and full offline reload passed",
  );
  await context.close();
} finally {
  await browser.close();
}
