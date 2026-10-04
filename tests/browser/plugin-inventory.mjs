import {
  createWorkspace,
  navigate,
  addColumnTemplates,
} from "./navigation-helpers.mjs";
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const delayedInventory of [false, true]) {
    const context = await browser.newContext(),
      page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => errors.push(error.message));
    if (delayedInventory)
      await page.route("**/plugins.json", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.continue();
      });
    await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58597");
    await createWorkspace(page);
    await navigate(page, "Plugins");
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText("Tasks", { exact: true }) });
    await row.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("taskasaur");
    await expect(page.getByRole("dialog")).toContainText("tasks.write");
    await page
      .getByRole("button", { name: "Confirm install", exact: true })
      .click();
    await row.getByRole("button", { name: "Disable", exact: true }).waitFor();
    await navigate(page, "Tasks");
    await addColumnTemplates(page, "Tasks", ["Title"]);
    await page.getByRole("button", { name: "New entry", exact: true }).click();
    await page
      .getByLabel("Title", { exact: true })
      .fill("Downloaded task plugin");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Downloaded task plugin", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Downloaded task plugin", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await context.setOffline(true);
    await navigate(page, "Plugins");
    await row.getByRole("button", { name: "Disable", exact: true }).click();
    await page
      .getByRole("button", { name: "Open plugins menu", exact: true })
      .click();
    await expect(
      page
        .getByRole("navigation", { name: "Workspace", exact: true })
        .getByRole("button", { name: "Tasks Disabled", exact: true }),
    ).toBeVisible();
    await navigate(page, "Plugins");
    await row.getByRole("button", { name: "Enable", exact: true }).click();
    await navigate(page, "Tasks");
    await expect(
      page.getByRole("button", { name: "Downloaded task plugin", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  }
  console.log(
    "Pinned permission review, delayed inventory, offline disable/re-enable and record preservation passed.",
  );
} finally {
  await browser.close();
}
