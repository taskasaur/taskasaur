import { navigate } from "./navigation-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
async function checkExport(download, entry, content) {
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  expect(await zip.file(entry)?.async("string")).toContain(content);
  console.log("Verified", download.suggestedFilename());
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ acceptDownloads: true }),
    page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => console.log("Page error:", error.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58597");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await navigate(page, "Plugins");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("Office Editor", { exact: true }) });
  await row.getByRole("button", { name: "Install", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm install", exact: true })
    .click();
  await row.getByRole("button", { name: "Disable", exact: true }).waitFor();
  await navigate(page, "Office");
  await page.getByRole("button", { name: "Document", exact: true }).click();
  await page.locator(".ql-editor").fill("Offline document content");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  let downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await checkExport(
    await downloading,
    "word/document.xml",
    "Offline document content",
  );
  await page
    .getByRole("button", { name: "Office", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Spreadsheet", exact: true }).click();
  await page.getByRole("button", { name: "Cell A1", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Cell value or formula" })
    .fill("=6*7");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Cell A1", exact: true }),
  ).toHaveText("42");
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await checkExport(await downloading, "xl/worksheets/sheet1.xml", "6*7");
  await page
    .getByRole("button", { name: "Office", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Presentation", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Slide title", exact: true })
    .fill("Offline slides");
  await page
    .getByRole("textbox", { name: "Slide body", exact: true })
    .fill("Local files synchronize with peers");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved on this device");
  downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await checkExport(
    await downloading,
    "ppt/slides/slide1.xml",
    "Offline slides",
  );
  await page
    .getByRole("button", { name: "Office", exact: true })
    .last()
    .click();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => null));
  await context.setOffline(true);
  await page.reload();
  await page
    .getByRole("button", { name: "Untitled presentation", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Slide title", exact: true }),
  ).toHaveValue("Offline slides");
  await page
    .getByRole("button", { name: "Office", exact: true })
    .last()
    .click();
  await page
    .getByRole("button", { name: "Untitled spreadsheet", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Cell A1", exact: true }),
  ).toHaveText("42");
  await page
    .getByRole("button", { name: "Office", exact: true })
    .last()
    .click();
  await page
    .getByRole("button", { name: "Untitled document", exact: true })
    .click();
  await expect(page.locator(".ql-editor")).toContainText(
    "Offline document content",
  );
  console.log(
    "Documents, spreadsheet formulas, presentations, exports and offline cold reopen passed.",
  );
} finally {
  await browser.close();
}
