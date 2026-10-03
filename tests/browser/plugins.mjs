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
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
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
  const navigation = page.getByRole("navigation");
  const labels = await navigation.getByRole("button").allTextContents();
  for (const name of labels) {
    await navigation.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByText(/This plugin could not render/)).toHaveCount(0);
    expect(failures, `Plugin surface ${name}`).toEqual([]);
  }
  console.log(
    "All twelve published plugins installed; their shared navigation surfaces opened without page errors.",
  );
} finally {
  await browser.close();
}
