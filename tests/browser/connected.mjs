import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://localhost:8080");
  await page
    .getByRole("button", { name: "Connect to server", exact: true })
    .click();
  if (process.env.TEST_SERVER_URL)
    await page
      .getByLabel("Server URL", { exact: true })
      .fill(process.env.TEST_SERVER_URL);
  await page
    .getByLabel("Email", { exact: true })
    .fill(`rebuild-${crypto.randomUUID()}@example.com`);
  await page
    .getByLabel("Password", { exact: true })
    .fill(crypto.randomUUID() + "A1!");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) })
    .getByRole("button", { name: "Install", exact: true })
    .click({ timeout: 30000 });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await page.getByRole("button", { name: "New entry", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Connected fixture");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(2000);
  await page
    .getByRole("button", { name: "Synchronize workspace", exact: true })
    .click();
  await page.waitForTimeout(2000);
  const result = await page.evaluate(async (server) => {
    const base = server || location.origin;
    const workspaces = await (
      await fetch(new URL("/api/workspaces", base), { credentials: "include" })
    ).json();
    const sync = await (
      await fetch(
        new URL("/api/sync?workspaceId=" + workspaces.workspaces[0].id, base),
        { credentials: "include" },
      )
    ).json();
    return sync;
  }, process.env.TEST_SERVER_URL);
  assert(
    result.records.some(
      (r) => r.collection === "tasks" && r.data.title === "Connected fixture",
    ),
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Authenticated container task sync passed");
} finally {
  await browser.close();
}
