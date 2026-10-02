import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://localhost:8080");
  await page
    .getByRole("button", { name: "Create local workspace", exact: true })
    .click();
  await page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) })
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await page.getByRole("button", { name: "New entry", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Cold offline task");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await page
    .getByRole("button", { name: "Cold offline task", exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "New entry", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Created after offline startup");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("button", { name: "Created after offline startup", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "Created after offline startup", exact: true })
    .waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "Production service-worker cold startup, existing records, offline creation and second reload passed",
  );
} finally {
  await browser.close();
}
