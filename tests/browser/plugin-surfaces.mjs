import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://localhost:5173");
  await page
    .getByRole("button", { name: "Create local workspace", exact: true })
    .click();
  for (const name of [
    "Tasks",
    "Track",
    "Time",
    "Calendar",
    "Reminders",
    "Email Client",
    "Automation Editor",
    "Remote Terminal",
    "Office Editor",
    "Sharing",
    "Connector Github",
  ]) {
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await row
      .getByRole("button", { name: "Install", exact: true })
      .click({ timeout: 30000 });
    await page
      .getByRole("button", { name: "Confirm install", exact: true })
      .click();
    await expect(row.getByText("Enabled", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(row.getByText(/could not start/)).toHaveCount(0);
    await page
      .getByRole("navigation")
      .getByRole("button", {
        name:
          {
            "Email Client": "Mail",
            "Automation Editor": "Automations",
            "Remote Terminal": "Terminal",
            "Office Editor": "Office",
            "Connector Github": "GitHub",
          }[name] ?? name,
        exact: true,
      })
      .click();
    await expect(page.getByText(/This plugin could not render/)).toHaveCount(0);
    console.log(name + " surface activated");
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  await context.close();
} finally {
  await browser.close();
}
