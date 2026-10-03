import { navigate } from "./navigation-helpers.mjs";
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
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await navigate(page, "Plugins");
  await page
    .getByRole("row")
    .filter({ has: page.getByText("Email Client", { exact: true }) })
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm install", exact: true })
    .click();
  await page
    .getByRole("row")
    .filter({ has: page.getByText("Email Client", { exact: true }) })
    .getByRole("button", { name: "Disable", exact: true })
    .waitFor({ timeout: 30000 });
  await navigate(page, "Mail");
  await page.getByRole("button", { name: "Compose", exact: true }).waitFor();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByLabel("Subject", { exact: true }).fill("Offline saved draft");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Draft written with no network.");
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  // Closing awaits the durable draft write; a click alone does not await that work.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Offline saved draft", exact: true })
    .click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Draft written with no network.",
  );
  await page
    .getByLabel("Message", { exact: true })
    .fill("Saved immediately on closing.");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  // Closing awaits the durable draft write; a click alone does not await that work.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await context.setOffline(false);
  await page.reload();
  await page
    .getByRole("button", { name: "Offline saved draft", exact: true })
    .click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Saved immediately on closing.",
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "Offline compose, autosave, immediate-close persistence and reload passed",
  );
} finally {
  await browser.close();
}
