import { chromium, expect } from "@playwright/test";
import {
  createWorkspace,
  navigate,
  addColumnTemplates,
} from "./navigation-helpers.mjs";
import { reviewInventory } from "./inventory-helpers.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext();
  await reviewInventory(context);
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4177");
  await createWorkspace(page);
  for (const name of ["Dashboard", "Tasks"]) {
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await row.getByRole("button", { name: "Install", exact: true }).click();
    await page
      .getByRole("button", { name: "Confirm install", exact: true })
      .click();
    await row.getByRole("button", { name: "Disable", exact: true }).waitFor();
  }
  await addColumnTemplates(page, "Tasks", ["Title"]);
  await page.getByRole("button", { name: "New entry", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Dashboard searchable task");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await navigate(page, "Notifications");
  await page.getByRole("button", { name: "New entry", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Active notification");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await navigate(page, "Dashboard");
  await expect(
    page.getByRole("region", { name: "Active work", exact: true }),
  ).toContainText("Active notification");
  const search = page.getByRole("combobox", {
    name: "Search content and commands",
    exact: true,
  });
  await search.fill("Dashboard searchable");
  await page.getByRole("option", { name: /Dashboard searchable task/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Edit tasks entry");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await navigate(page, "Dashboard");
  await search.fill("Open Files");
  await page.getByRole("option", { name: "Open Files", exact: true }).click();
  await expect(page.locator('[data-record-collection="files"]')).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "Signed Dashboard plugin, active work, shared content search and commands passed.",
  );
} finally {
  await browser.close();
}
