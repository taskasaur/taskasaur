import { chromium, expect } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 950 },
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const click = (name) => page.getByRole("button", { name, exact: true }).click();
const menu = async (side = "plugins") => {
  await page
    .getByRole("button", { name: `Open ${side} menu`, exact: true })
    .click();
};
const navigate = async (name, side = "plugins") => {
  await menu(side);
  await page
    .getByRole("navigation", {
      name: side === "plugins" ? "Workspace" : "Settings and tools",
      exact: true,
    })
    .getByRole("button", { name, exact: true })
    .click();
};
const choose = async (label, value) => {
  await page.getByLabel(label, { exact: true }).click();
  await page
    .locator("[data-slot=select-content][data-open]")
    .getByRole("option", { name: value, exact: true })
    .click();
};
const columns = async () => {
  await menu();
  await click("Tasks pages");
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("button", { name: "Columns", exact: true })
    .click();
};
const newTask = async (title, extra) => {
  await click("New entry");
  await page.getByLabel("Title", { exact: true }).fill(title);
  if (extra) await page.getByLabel("Budget", { exact: true }).fill(extra);
  await click("Save");
  await expect(page.getByRole("dialog")).toHaveCount(0);
};
try {
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:5173");
  await click("Create workspace");
  await expect(
    page.locator(".page-header,.workspace-label,.eyebrow"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("My workspace");
  for (const name of ["Tasks", "Email Client", "Office Editor"]) {
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await row.getByRole("button", { name: "Install", exact: true }).click();
    await click("Confirm install");
    await row.getByRole("button", { name: "Disable", exact: true }).waitFor();
  }
  await menu();
  const left = page.getByRole("navigation", { name: "Workspace", exact: true });
  await expect(
    left.getByRole("button", { name: "Devices", exact: true }),
  ).toHaveCount(0);
  await expect(
    left.getByRole("button", { name: "Files", exact: true }),
  ).toHaveCount(0);
  await left.getByRole("button", { name: "Tasks", exact: true }).click();
  await columns();
  await expect(
    page.getByRole("button", { name: "Remove Title column", exact: true }),
  ).toHaveCount(0);
  await click("Title");
  await navigate("Tasks");
  await newTask("Personal searchable task");
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await click("New table");
  await page.getByLabel("Table name", { exact: true }).fill("Work tasks");
  await click("Create table");
  await expect(page.locator("[data-record-id]")).toHaveCount(0);
  await columns();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Columns");
  await expect(
    page.getByRole("button", { name: "Remove UID column", exact: true }),
  ).toBeDisabled();
  for (const preset of ["Title", "Status", "Description"]) {
    await click(preset);
    await page
      .getByRole("button", { name: `Edit ${preset} column`, exact: true })
      .waitFor();
  }
  await click("Remove Description column");
  await click("Description");
  await click("Custom column");
  await page.getByLabel("Column ID", { exact: true }).fill("budget");
  await page.getByLabel("Label", { exact: true }).fill("Budget");
  await choose("Base type", "numeric");
  await click("Save column");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await navigate("Tasks");
  await newTask("Work searchable task", "123.45");
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await choose("Data table", "Tasks");
  await expect(page.locator("[data-record-id]")).toContainText(
    "Personal searchable task",
  );
  await menu();
  await click("Search");
  await page
    .getByRole("combobox", { name: "Search content and commands" })
    .fill("Work searchable");
  await page.getByRole("option", { name: /Work searchable task/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Edit tasks entry");
  await page.getByLabel("Title", { exact: true }).fill("Work renamed");
  await click("Save");
  await expect(page.locator("[data-record-id]")).toContainText("Work renamed");
  await menu("settings");
  const right = page.getByRole("navigation", {
    name: "Settings and tools",
    exact: true,
  });
  for (const name of [
    "Files",
    "Tables",
    "Variables",
    "Credentials",
    "Devices",
    "Notifications",
    "Jobs",
    "Settings",
  ])
    await expect(
      right.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await click("Choose saved tab 1");
  await page.getByRole("option", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open saved Tasks", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Open saved Tasks", exact: true }),
  ).toBeVisible();
  await navigate("Tables", "settings");
  const managed = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "Work tasks", exact: true }),
  });
  await expect(managed).toContainText("Managed by tasks");
  await expect(
    managed.getByRole("button", { name: "Edit entry", exact: true }),
  ).toHaveCount(0);
  await managed
    .getByRole("button", { name: "Work tasks", exact: true })
    .click();
  await expect(
    page.getByText(
      "Managed by tasks. Open that plugin to edit its columns and entries.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit entry", exact: true }),
  ).toHaveCount(0);
  await navigate("Mail");
  await expect(
    page.getByRole("button", { name: "Accounts", exact: true }),
  ).toHaveCount(0);
  await menu();
  await click("Mail pages");
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("button", { name: "Accounts", exact: true })
    .click();
  await expect(
    page.locator("[data-record-collection=mail_accounts]"),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Accounts");
  await navigate("Settings", "settings");
  await choose("Color theme", "Dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("button", { name: "Toggle theme", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    timeout: 60000,
    animations: "disabled",
    path: join(tmpdir(), "taskasaur-navigation-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = page.getByRole("navigation", {
    name: "Mobile navigation",
    exact: true,
  });
  await expect(mobile).toBeVisible();
  await mobile
    .getByRole("button", { name: "Open saved Tasks", exact: true })
    .click();
  await expect(page.locator("[data-record-collection=tasks]")).toBeVisible();
  await menu();
  await click("Search");
  await page
    .getByRole("combobox", { name: "Search content and commands" })
    .fill("Open Mail");
  await page.getByRole("option", { name: "Open Mail", exact: true }).click();
  await expect(page.locator("[data-record-collection=mail]")).toBeVisible();
  await page.screenshot({
    timeout: 60000,
    animations: "disabled",
    path: join(tmpdir(), "taskasaur-navigation-mobile.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  console.log(
    "Two menus, breadcrumbs, shortcuts, theme, unified search, Mail pages, table isolation, custom columns and managed storage passed.",
  );
} catch (error) {
  console.error(await page.locator("body").innerText());
  await page.screenshot({
    path: join(tmpdir(), "taskasaur-navigation-failure.png"),
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
