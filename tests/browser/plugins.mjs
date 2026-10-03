import { navigate } from "./navigation-helpers.mjs";
import { chromium, expect } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  page.setDefaultTimeout(45000);
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58597");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await navigate(page, "Plugins");
  for (const name of [
    "Tasks",
    "Track",
    "Time",
    "Calendar",
    "Reminders",
    "Email Client",
    "Automation Runtime",
    "Automation Editor",
    "Remote Terminal",
    "Office Editor",
    "Sharing",
    "Connector Github",
  ]) {
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await row.waitFor();
    if (
      await row.getByRole("button", { name: "Install", exact: true }).count()
    ) {
      await row.getByRole("button", { name: "Install", exact: true }).click();
      await page
        .getByRole("button", { name: "Confirm install", exact: true })
        .click();
    }
    await row.getByRole("button", { name: "Disable", exact: true }).waitFor();
    await expect(row.getByText(/could not start/)).toHaveCount(0);
    console.log("Installed", name);
  }
  await page
    .getByRole("button", { name: "Open plugins menu", exact: true })
    .click();
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  const labels = await navigation
    .locator("button:not([aria-expanded])")
    .allTextContents();
  for (const name of labels.filter((name) => name !== "Search")) {
    await navigate(page, name);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByText(/This plugin could not render/)).toHaveCount(0);
    expect(failures, `Plugin surface ${name}`).toEqual([]);
    await expect(page.getByPlaceholder(/Search entries/i)).toHaveCount(0);
    await expect(page.locator("select:visible")).toHaveCount(0);
  }
  console.log(
    "All twelve published plugins installed; their shared navigation surfaces opened without page errors.",
  );
} finally {
  await browser.close();
}
