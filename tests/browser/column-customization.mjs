import { chromium, expect } from "@playwright/test";
import {
  createWorkspace,
  navigate,
  addColumnTemplates,
} from "./navigation-helpers.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const click = (name) =>
    page
      .getByRole("button", { name, exact: true })
      .click()
      .catch(async (e) => {
        console.error(await page.locator("body").innerText());
        throw e;
      });
  const choose = async (label, value) => {
    await page.getByLabel(label, { exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  };
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4177");
  await createWorkspace(page);
  await navigate(page, "Tables");
  await click("New table");
  await page.getByLabel("Name", { exact: true }).fill("Typed selections");
  await click("Create table");
  await expect(page.locator("th[data-field]")).toHaveCount(0);
  const column = async () => {
    await click("Add column");
    await page.getByLabel("Column ID", { exact: true }).fill("scores");
    await page.getByLabel("Label", { exact: true }).fill("Scores");
    await choose("Base type", "integer");
    await choose("Input mode", "Multiple selections");
    await page.getByLabel("Column options", { exact: true }).fill("[1,2,3]");
    await page.getByLabel("Minimum inputs", { exact: true }).fill("1");
    await page.getByLabel("Maximum inputs", { exact: true }).fill("2");
    await click("Save column");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  await column();
  await click("New row");
  const scores = page.getByRole("group", { name: "Scores", exact: true });
  await scores.getByRole("checkbox", { name: "1", exact: true }).click();
  await scores.getByRole("checkbox", { name: "3", exact: true }).click();
  await expect(
    scores.getByRole("checkbox", { name: "2", exact: true }),
  ).toBeDisabled();
  await click("Save");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator('td[data-field="scores"]')).toContainText("1");
  await click("Edit columns");
  await click("Remove Scores column");
  await expect(page.locator('td[data-field="scores"]')).toHaveCount(0);
  // Updating an entry with a removed column must retain its stored value.
  await page
    .locator("[data-record-id]")
    .getByRole("button", { name: /^Entry / })
    .click();
  await click("Save");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await column();
  await expect(page.locator('td[data-field="scores"]')).toContainText("3");
  await click("Edit Scores column");
  await choose("Column visibility", "Read only");
  await click("Save column");
  await click("Edit entry");
  await expect(
    page
      .getByRole("group", { name: "Scores", exact: true })
      .getByRole("checkbox", { name: "1", exact: true }),
  ).toBeDisabled();
  await click("Cancel");
  await navigate(page, "Plugins");
  const plugin = page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) });
  await plugin.getByRole("button", { name: "Install", exact: true }).click();
  await click("Confirm install");
  await plugin.getByRole("button", { name: "Disable", exact: true }).waitFor();
  await addColumnTemplates(page, "Tasks", ["Title", "Status"]);
  await click("Open plugins menu");
  await click("Tasks pages");
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("button", { name: "Columns", exact: true })
    .click();
  await click("Edit Status column");
  await choose("Base type", "integer");
  await choose("Input mode", "One value");
  await page
    .getByRole("switch", { name: "Default value", exact: true })
    .click();
  await click("Save column");
  await navigate(page, "Tasks");
  await click("New entry");
  await page.getByLabel("Title", { exact: true }).fill("Independent template");
  await page.getByLabel("Status", { exact: true }).fill("7");
  await click("Save");
  const completion = page.getByRole("button", {
    name: "Toggle task completion",
    exact: true,
  });
  await completion.click();
  await expect(completion).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('td[data-field="status"]')).toHaveText("7");
  await completion.click();
  await expect(completion).toHaveAttribute("aria-pressed", "false");
  expect(errors).toEqual([]);
  console.log(
    "Shared column editor, typed multiple inputs, count limits, removed-value preservation and read-only controls passed.",
  );
} finally {
  await browser.close();
}
