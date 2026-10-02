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
    .getByRole("button", { name: "Connect to server", exact: true })
    .click();
  await page
    .getByLabel("Email", { exact: true })
    .fill(`plugin-ui-${crypto.randomUUID()}@example.com`);
  await page
    .getByLabel("Password", { exact: true })
    .fill(crypto.randomUUID() + "aA1!");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("Example Notes", { exact: true }) });
  await row
    .getByRole("button", { name: "Install", exact: true })
    .click({ timeout: 30000 });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Example notes", exact: true })
    .click();
  await page.getByRole("button", { name: "New entry", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Plugin browser fixture");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("button", { name: "Plugin browser fixture", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Synchronize workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Synchronize workspace", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Count server notes", exact: true })
    .click();
  await page
    .getByText("1 notes synchronized to the server", { exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "Plugin browser fixture", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(
    page
      .getByRole("navigation")
      .getByRole("button", { name: "Example notes", exact: true }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: "Enable", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Example notes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Plugin browser fixture", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Count server notes", exact: true })
    .click();
  await page
    .getByText("1 notes synchronized to the server", { exact: true })
    .waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "Installed browser module, host-provided React/UI, offline persistence, and core-routed command passed",
  );
} finally {
  await browser.close();
}
