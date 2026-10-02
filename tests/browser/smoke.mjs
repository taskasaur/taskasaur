import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto("http://127.0.0.1:3210/");
await page
  .getByRole("button", { name: "Create local workspace", exact: true })
  .click();
await page
  .getByRole("heading", { name: "Optional features", exact: true })
  .waitFor();
const tasks = page
  .getByRole("row")
  .filter({ has: page.getByText("Tasks", { exact: true }) });
await tasks.getByRole("button", { name: "Install", exact: true }).click();
await page
  .getByRole("navigation")
  .getByRole("button", { name: "Tasks", exact: true })
  .click();
await page.getByRole("button", { name: "New entry", exact: true }).click();
await page.getByLabel("Title", { exact: false }).fill("Persistent task");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page
  .getByRole("button", { name: "Persistent task", exact: true })
  .waitFor();
await page.reload();
await page
  .getByRole("button", { name: "Persistent task", exact: true })
  .waitFor();
await page.screenshot({
  path: "/tmp/taskasaur-browser-smoke.png",
  fullPage: true,
});
await page.getByRole("button", { name: "Plugins", exact: true }).click();
await page
  .getByRole("row")
  .filter({ has: page.getByText("Office Editor", { exact: true }) })
  .getByRole("button", { name: "Install", exact: true })
  .click();
await page
  .getByRole("navigation")
  .getByRole("button", { name: "Office", exact: true })
  .click();
await page.getByRole("button", { name: "Document", exact: true }).click();
await page.locator('iframe[title="Offline office editor"]').waitFor();
await page.waitForTimeout(30000);
await page.screenshot({
  path: "/tmp/taskasaur-office-smoke.png",
  fullPage: true,
});
console.log(
  JSON.stringify(
    {
      errors,
      body: (await page.locator("body").innerText()).slice(-1200),
      frames: page.frames().map((f) => f.url()),
    },
    null,
    2,
  ),
);
await browser.close();
