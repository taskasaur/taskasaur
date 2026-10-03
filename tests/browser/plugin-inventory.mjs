import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const connected of [false, true]) {
    const context = await browser.newContext(),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.env.TEST_APP_URL ?? "http://localhost:5173");
    if (connected) {
      // Installed manifests can arrive before the remote inventory; review must still be shown.
      await page.route("**/api/plugins/inventory?**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.continue();
      });
      await page
        .getByRole("button", { name: "Connect to server", exact: true })
        .click();
      await page
        .getByLabel("Server URL", { exact: true })
        .fill(process.env.TEST_SERVER_URL ?? "http://localhost:3210");
      await page
        .getByLabel("Email", { exact: true })
        .fill(`inventory-${crypto.randomUUID()}@example.com`);
      await page
        .getByLabel("Password", { exact: true })
        .fill(crypto.randomUUID() + "aA1!");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
    } else
      await page
        .getByRole("button", { name: "Create local workspace", exact: true })
        .click();
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText("Tasks", { exact: true }) });
    await row
      .getByRole("button", { name: "Install", exact: true })
      .click({ timeout: 30000 });
    await expect(page.getByRole("dialog")).toContainText("taskasaur");
    await expect(page.getByRole("dialog")).toContainText("tasks.write");
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
    await expect(
      page.getByRole("button", { name: "Board", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "New entry", exact: true }).click();
    await page
      .getByLabel("Title", { exact: true })
      .fill("Downloaded task plugin");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Downloaded task plugin", exact: true }),
    ).toBeVisible();
    if (connected) {
      await page
        .getByRole("button", { name: "Synchronize workspace", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Synchronize workspace",
          exact: true,
        }),
      ).toBeEnabled({ timeout: 30000 });
    }
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Downloaded task plugin", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await context.setOffline(true);
    // Existing verified modules and records remain usable when downloads/server are unavailable.
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    if (!connected) {
      await row.getByRole("button", { name: "Disable", exact: true }).click();
      await row.getByRole("button", { name: "Enable", exact: true }).click();
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Tasks", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Downloaded task plugin",
          exact: true,
        }),
      ).toBeVisible();
    }
    assert.equal(errors.length, 0, errors.join("\n"));
    await context.close();
    console.log(
      connected
        ? "Connected inventory install and sync passed"
        : "Local inventory install, cached module and data passed",
    );
  }
} finally {
  await browser.close();
}
