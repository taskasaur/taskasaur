import { chromium } from "@playwright/test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
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
const results = [];
for (const kind of ["Document", "Spreadsheet", "Presentation"]) {
  await page.getByRole("button", { name: kind, exact: true }).click();
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 90000 });
  const frame = page
    .frames()
    .find((f) => f.url().includes("/office-engine/cool.html"));
  const before = await frame.evaluate(() => ({
    type: window.app.map.getDocType(),
    files: window.Module.FS.readdir("/taskasaur"),
  }));
  await frame.evaluate((kind) => {
    if (kind === "Document")
      window.app.map.sendUnoCommand(".uno:InsertText", {
        Text: { type: "string", value: "Taskasaur offline save fixture" },
      });
    else if (kind === "Spreadsheet")
      window.app.map.sendUnoCommand(".uno:EnterString", {
        StringName: { type: "string", value: "=SUM(2;3)" },
      });
  }, kind);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await page
      .getByText("Saved on this device", { exact: true })
      .waitFor({ timeout: 35000 });
  } catch {
    results.push({
      kind,
      before,
      error: await page.locator("body").innerText(),
    });
    break;
  }
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const file = await downloadPromise;
  const data = await readFile(await file.path()),
    zip = await JSZip.loadAsync(data),
    xml = await zip.file("content.xml").async("string");
  results.push({
    kind,
    before,
    size: data.length,
    hasTypedText: xml.includes("Taskasaur offline save fixture"),
    hasFormula: xml.includes("SUM"),
  });
  await page
    .getByRole("button", { name: "Office", exact: true })
    .last()
    .click();
}
console.log(JSON.stringify({ results, errors }, null, 2));
await page.screenshot({
  path: "/tmp/taskasaur-office-tested.png",
  fullPage: true,
});
await browser.close();
