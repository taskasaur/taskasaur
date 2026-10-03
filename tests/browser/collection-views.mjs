import { navigate } from "./navigation-helpers.mjs";
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const click = (name) => page.getByRole("button", { name, exact: true }).click();
const expectToggleAfterArrows = async (kind) => {
  const arrows = await page
    .getByLabel(`Move ${kind} 1 down`, { exact: true })
    .boundingBox();
  const toggle = await page
    .getByRole("switch", { name: `Enable ${kind} 1`, exact: true })
    .boundingBox();
  const field = await page
    .getByLabel(`${kind === "sort" ? "Sort" : "Group"} field 1`, {
      exact: true,
    })
    .boundingBox();
  expect(toggle.x).toBeGreaterThan(arrows.x + arrows.width);
  expect(toggle.x + toggle.width).toBeLessThan(field.x);
};
const choose = async (label, value) => {
  await page.getByLabel(label, { exact: true }).click();
  await page
    .locator("[data-slot=select-content][data-open]")
    .getByRole("option", { name: value, exact: true })
    .click();
  await expect(
    page.locator("[data-slot=select-content][data-open]"),
  ).toHaveCount(0);
};
const view = async (name) => {
  await click("View");
  await page
    .locator("[data-slot=dropdown-menu-content][data-open]")
    .getByRole("menuitemradio", { name, exact: true })
    .click();
  await expect(
    page.locator("[data-slot=dropdown-menu-content][data-open]"),
  ).toHaveCount(0);
};
const records = () => page.locator("[data-record-id]");
try {
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:5173");
  await click("Create workspace");
  await navigate(page, "Plugins");
  const install = page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) });
  await install.getByRole("button", { name: "Install", exact: true }).click();
  await click("Confirm install");
  await install.getByRole("button", { name: "Disable", exact: true }).waitFor();
  await navigate(page, "Tasks");
  const longTitle =
    "Alpha " +
    "A long task title with words and averylongunbrokenword".repeat(10);
  for (const [title, status, description] of [
    [longTitle, "open", "A"],
    ["Bravo", "open", "B"],
    ["Charlie", "done", "A"],
    ["Delta", "done", "B"],
  ]) {
    await click("New entry");
    await click("Add optional fields");
    await page.getByLabel("Title", { exact: true }).fill(title);
    await choose("Status", status);
    await page.getByLabel("Description", { exact: true }).fill(description);
    await click("Save");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await expect(records()).toHaveCount(4);
  await expect(page.getByPlaceholder(/Search entries/i)).toHaveCount(0);
  await expect(page.locator("select:visible")).toHaveCount(0);
  const delta = records().filter({
    has: page.getByRole("button", { name: "Delta", exact: true }),
  });
  const completion = delta.getByLabel("Toggle task completion");
  await expect(completion).toHaveAttribute("aria-pressed", "true");
  await completion.click();
  await expect(completion).toHaveAttribute("aria-pressed", "false");
  await completion.click();
  await expect(completion).toHaveAttribute("aria-pressed", "true");
  console.log("CRUD, task actions and custom shadcn selects passed");
  for (const name of [
    "Filter",
    "Sort",
    "Columns",
    "Group",
    "View",
    "Filter",
    "View",
    "Columns",
    "View",
    "Sort",
    "View",
    "Group",
  ]) {
    await click(name);
    await expect(
      page.locator(
        '[data-slot="popover-content"][data-open], [data-slot="combobox-content"][data-open], [data-slot="dropdown-menu-content"][data-open]',
      ),
    ).toHaveCount(1);
  }
  await click("Filter");
  await click("Add filter");
  await page.getByLabel("Filter value 1", { exact: true }).fill("Alpha");
  await expect(records()).toHaveCount(1);
  await click("Add filter");
  await choose("Filter field 2", "Status");
  await choose("Filter value 2", "done");
  await expect(records()).toHaveCount(0);
  const where = await page.locator("[data-filter-conjunction]").boundingBox(),
    and = await page.getByLabel("Filter conjunction 2").boundingBox();
  expect(where.width).toBe(and.width);
  const arrows = await page.getByLabel("Move filter 1 up").boundingBox(),
    toggle = await page
      .getByLabel("Enable filter 1", { exact: true })
      .boundingBox();
  expect(toggle.x).toBeGreaterThan(arrows.x);
  await choose("Filter conjunction 2", "Or");
  await expect(records()).toHaveCount(3);
  await click("Move filter 2 up");
  await expect(
    page.getByLabel("Filter field 1", { exact: true }),
  ).toContainText("Status");
  await page.getByLabel("Enable filter 1", { exact: true }).click();
  await expect(records()).toHaveCount(1);
  await click("Remove filter 2");
  await click("Remove filter 1");
  await expect(records()).toHaveCount(4);
  await click("Sort");
  await expect(
    page.getByRole("dialog", { name: "Filter", exact: true }),
  ).toHaveCount(0);
  await click("Add sort");
  await choose("Sort field 1", "Title");
  await expectToggleAfterArrows("sort");
  await click("Sort 1 ascending");
  await expect(records().first()).toContainText("Delta");
  await click("Columns");
  await expect(
    page.getByRole("dialog", { name: "Sort", exact: true }),
  ).toHaveCount(0);
  const visibleFields = () =>
    page
      .locator("[data-record-id]")
      .first()
      .locator("td[data-field]")
      .evaluateAll((cells) => cells.map((cell) => cell.dataset.field));
  const initialFields = await visibleFields();
  const reorderedFields = [
    "description",
    ...initialFields.filter((id) => id !== "description"),
  ];
  await page
    .getByRole("switch", { name: "Show column Description", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Columns", exact: true }),
  ).toHaveText("Columns");
  await expect(page.locator('[data-column-row="title"]')).toBeVisible();
  await expect(page.locator('td[data-field="description"]')).toHaveCount(0);
  // Hidden columns retain their positions while reordered and across reloads.
  const description = page.locator('[data-column-row="description"]');
  for (let i = 0; i < initialFields.indexOf("description"); i++)
    await description.getByRole("button", { name: /up$/ }).click();
  await page
    .getByRole("switch", { name: "Show column Description", exact: true })
    .click();
  await expect.poll(visibleFields).toEqual(reorderedFields);
  const columnArrows = await description
      .getByRole("button", { name: /down$/ })
      .boundingBox(),
    columnToggle = await description.getByRole("switch").boundingBox();
  expect(columnToggle.x).toBeGreaterThan(columnArrows.x + columnArrows.width);
  await page
    .getByRole("switch", { name: "Show column Description", exact: true })
    .click();
  await page.reload();
  await expect(records()).toHaveCount(4);
  await click("Columns");
  await expect(page.locator("[data-column-row]").first()).toHaveAttribute(
    "data-column-row",
    "description",
  );
  await expect(
    page.getByRole("switch", { name: "Show column Description", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("switch", { name: "Show column Description", exact: true })
    .click();
  await expect.poll(visibleFields).toEqual(reorderedFields);
  for (let i = 0; i < initialFields.indexOf("description"); i++)
    await description.getByRole("button", { name: /down$/ }).click();
  await expect.poll(visibleFields).toEqual(initialFields);
  await page.screenshot({ path: "/private/tmp/taskasaur-columns.png" });
  await click("Group");
  await expect(page.locator("[data-column-row]")).toHaveCount(0);
  await click("Add group");
  await choose("Group field 1", "Status");
  await expectToggleAfterArrows("group");
  await click("Add group");
  await choose("Group field 2", "Description");
  await click("Move group 2 up");
  await expect(page.getByLabel("Group field 1", { exact: true })).toContainText(
    "Description",
  );
  await click("Move group 1 down");
  await page.getByLabel("Enable group 2", { exact: true }).click();
  await expect(page.locator('[data-group-heading="description"]')).toHaveCount(
    0,
  );
  await page.getByLabel("Enable group 2", { exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-group-heading="status"]')).toHaveCount(2);
  await expect(page.locator('[data-group-heading="description"]')).toHaveCount(
    4,
  );
  await click("Collapse Status: open");
  await expect(records()).toHaveCount(2);
  await click("Expand Status: open");
  await expect(records()).toHaveCount(4);
  await click("Open group Status: open");
  await expect(records()).toHaveCount(2);
  await expect(page.locator("[data-pinned-group]")).toHaveCount(1);
  await click("Open group Description: A");
  await expect(records()).toHaveCount(1);
  await expect(page.locator("[data-pinned-group]")).toHaveCount(2);
  await expect(
    page.getByRole("navigation", { name: "Tasks groups" }),
  ).toContainText("Status: open");
  const cell = page.locator('td[data-field="title"]');
  expect(await cell.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe(
    "normal",
  );
  await view("Long table");
  expect(await cell.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe(
    "nowrap",
  );
  expect(
    await page
      .locator('[data-slot="table-container"]')
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  await view("Board");
  await expect(page.locator('[data-collection-display="board"]')).toBeVisible();
  await expect(page.locator("[data-pinned-group]")).toHaveCount(2);
  await expect(records()).toHaveCount(1);
  await page
    .getByRole("navigation", { name: "Tasks groups" })
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await expect(page.locator('[data-board-group="status"]')).toHaveCount(2);
  await expect(page.locator('[data-board-group="description"]')).toHaveCount(4);
  await page.screenshot({
    path: "/private/tmp/taskasaur-board.png",
    animations: "disabled",
  });
  for (const [mode, display] of [
    ["Short table folder", "short-table"],
    ["Long table folder", "long-table"],
    ["Board folder", "board"],
  ]) {
    await view(mode);
    await expect(
      page.locator('[data-collection-display="folders"]'),
    ).toBeVisible();
    await click("Open folder Status: open");
    await click("Open folder Description: A");
    await expect(
      page.locator(`[data-collection-display="${display}"]`),
    ).toBeVisible();
    await expect(records()).toHaveCount(1);
    await expect(page.locator("[data-pinned-group]")).toHaveCount(2);
    if (display === "board") {
      await page.reload();
      await expect(
        page.locator('[data-collection-view="board-folder"]'),
      ).toBeVisible();
      await expect(records()).toHaveCount(1);
    }
    await page
      .getByRole("navigation", { name: "Tasks groups" })
      .getByRole("button", { name: "Tasks", exact: true })
      .click();
  }
  await view("Short table");
  await click("Filter");
  await click("Add filter");
  await click("Add filter");
  await page.screenshot({
    path: "/private/tmp/taskasaur-filter.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await click("Group");
  const popup = await page
    .getByRole("dialog", { name: "Group", exact: true })
    .boundingBox();
  expect(popup.x).toBeGreaterThanOrEqual(0);
  expect(popup.x + popup.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await view("Board");
  const board = page.locator('[data-collection-display="board"]');
  const sticky = page
    .locator('[data-board-group="status"]')
    .first()
    .locator(".sticky")
    .first();
  const initialX = (await sticky.boundingBox()).x;
  await board.evaluate((el) => {
    el.scrollLeft = 120;
  });
  await expect
    .poll(async () => Math.abs((await sticky.boundingBox()).x - initialX))
    .toBeLessThanOrEqual(1);
  await view("Short table");
  await click("Filter");
  const filterPopup = await page
    .getByRole("dialog", { name: "Filter", exact: true })
    .boundingBox();
  expect(filterPopup.x + filterPopup.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "/private/tmp/taskasaur-mobile.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await navigate(page, "Settings");
  await choose("Color theme", "Dark");
  await navigate(page, "Tasks");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await click("Columns");
  await page.getByRole("textbox", { name: "Find columns" }).fill("Status");
  await expect(
    page.getByRole("switch", { name: "Show column Status", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Show column Title", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Columns", exact: true }),
  ).toBeFocused();
  expect(errors).toEqual([]);
  console.log(
    "Filtering, ordering, exclusive popovers, ordered columns and visibility switches, recursive grouping, six views, breadcrumbs, persisted state and mobile controls passed",
  );
} catch (error) {
  console.error(await page.locator("body").innerText());
  await page.screenshot({
    path: "/private/tmp/taskasaur-collection-failure.png",
  });
  throw error;
} finally {
  await browser.close();
}
