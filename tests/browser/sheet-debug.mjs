import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => console.log("ERROR", e.stack));
page.on("console", (m) => {
  if (m.type() === "error" || /abort|assert|exception/i.test(m.text()))
    console.log(m.type(), m.text());
});
await page.goto("http://localhost:8080/");
await page
  .getByRole("button", { name: "Create local workspace", exact: true })
  .click();
await page
  .getByRole("row")
  .filter({ has: page.getByText("Office Editor", { exact: true }) })
  .getByRole("button", { name: "Install", exact: true })
  .click();
await page
  .getByRole("navigation")
  .getByRole("button", { name: "Office", exact: true })
  .click();
await page.getByRole("button", { name: "Spreadsheet", exact: true }).click();
await page.getByText("Ready", { exact: true }).waitFor({ timeout: 90000 });
const frame = page
  .frames()
  .find((f) => f.url().includes("/office-engine/cool.html"));
await page.getByRole("button", { name: "Save", exact: true }).click();
await page
  .getByText("Saved on this device", { exact: true })
  .waitFor({ timeout: 35000 });
console.log("Blank spreadsheet save passed");
console.log(
  await frame
    .locator("input,textarea,[contenteditable]")
    .evaluateAll((elements) =>
      elements
        .map((e) => ({
          tag: e.tagName,
          id: e.id,
          role: e.getAttribute("role"),
          class: e.className,
        }))
        .slice(0, 40),
    ),
);
await page.screenshot({ path: "/tmp/taskasaur-sheet-before.png" });
await frame.evaluate(() => window.app.map.focus());
await page.keyboard.type("=SUM(2;3)");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
await page.getByRole("button", { name: "Save", exact: true }).click();
await page
  .getByText("Saved on this device", { exact: true })
  .waitFor({ timeout: 35000 });
const waitDownload = page.waitForEvent("download");
await page.getByRole("button", { name: "Export", exact: true }).click();
const download = await waitDownload;
await download.saveAs("/tmp/taskasaur-sheet-tested.ods");
await page.screenshot({ path: "/tmp/taskasaur-sheet-after.png" });
console.log("Edited spreadsheet save passed");
await browser.close();
