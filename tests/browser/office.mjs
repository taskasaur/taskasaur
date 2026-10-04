import { chromium, expect } from "@playwright/test";
import JSZip from "jszip";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorkspace,
  leaveWorkspace,
  navigate,
} from "./navigation-helpers.mjs";
import { reviewInventory } from "./inventory-helpers.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const directory = await mkdtemp(path.join(tmpdir(), "taskasaur-office-"));
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await reviewInventory(context);
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(90000);
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("Page error:", e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.log("Engine:", m.text().slice(0, 600));
  });
  page.on("requestfailed", (r) =>
    console.log("Request failed", r.url(), r.failure()?.errorText),
  );
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4177");
  await createWorkspace(page);
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("Office Editor", { exact: true }) });
  await row.getByRole("button", { name: "Install", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm install", exact: true })
    .click();
  await row
    .getByRole("button", { name: "Disable", exact: true })
    .waitFor({ timeout: 30000 })
    .catch(async (e) => {
      console.log(await page.locator("body").innerText());
      throw e;
    });
  await navigate(page, "Office");
  async function engine() {
    for (const worker of page.workers())
      try {
        if (await worker.evaluate(() => Boolean(globalThis.Module?.zetajs)))
          return worker;
      } catch {}
    throw Error("Upstream LibreOffice UNO worker is unavailable");
  }
  async function inspect(kind, edit) {
    return (await engine()).evaluate(
      async ({ kind, edit }) => {
        const z = await Module.zetajs,
          css = z.uno.com.sun.star;
        const model = css.frame.Desktop.create(
          z.getUnoComponentContext(),
        ).getCurrentComponent();
        if (kind === "document") {
          if (edit) {
            const text = model.getText();
            text.setString("Portable ODT from LibreOffice");
            text.createTextCursor().setPropertyValue("CharWeight", 150);
          }
          return model.getText().getString();
        }
        if (kind === "spreadsheet") {
          const sheet = model.getSheets().getByIndex(0);
          if (edit) {
            sheet.getCellByPosition(0, 0).setValue(21);
            sheet.getCellByPosition(1, 0).setFormula("=A1*2");
          }
          return sheet.getCellByPosition(1, 0).getValue();
        }
        const slide = model.getDrawPages().getByIndex(0);
        if (edit) {
          const shape = model.createInstance("com.sun.star.drawing.TextShape");
          slide.add(shape);
          shape.setPosition(new css.awt.Point({ X: 2000, Y: 2000 }));
          shape.setSize(new css.awt.Size({ Width: 16000, Height: 4000 }));
          shape.setString("Portable ODP from LibreOffice");
        }
        return Array.from({ length: slide.getCount() }, (_, i) => {
          try {
            return slide.getByIndex(i).getString();
          } catch {
            return "";
          }
        }).join(" ");
      },
      { kind, edit },
    );
  }
  const cases = [
    ["Document", "document", "odt", "Portable ODT from LibreOffice"],
    ["Spreadsheet", "spreadsheet", "ods", 42],
    ["Presentation", "presentation", "odp", "Portable ODP from LibreOffice"],
  ];
  for (const [label, kind, extension, expected] of cases) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByText("Ready", { exact: true }))
      .toBeVisible({
        timeout: 60000,
      })
      .catch(async (e) => {
        console.log(
          "Frames:",
          await Promise.all(
            page.frames().map(async (f) => ({
              url: f.url(),
              body: await f
                .locator("body")
                .innerText()
                .catch(() => "unavailable"),
            })),
          ),
        );
        console.log(
          "Caches:",
          await page.evaluate(async () =>
            Promise.all(
              (await caches.keys()).map(async (name) => ({
                name,
                keys: (await (await caches.open(name)).keys()).map(
                  (r) => r.url,
                ),
              })),
            ),
          ),
        );
        throw e;
      });
    const result = await inspect(kind, true);
    expect(String(result)).toContain(String(expected));
    await expect(
      page.getByText("Unsaved changes", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText("Saved on this device", { exact: true }),
    ).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const file = await download,
      target = path.join(directory, "test." + extension);
    await file.saveAs(target);
    const zip = await JSZip.loadAsync(await readFile(target));
    const xml = await zip.file("content.xml").async("string");
    if (extension === "ods") {
      expect(xml).toContain('table:formula="of:=[.A1]*2"');
      expect(xml).toContain('office:value="42"');
    } else expect(xml).toContain(String(expected));
    expect(await zip.file("mimetype").async("string")).toContain(
      "application/vnd.oasis.opendocument.",
    );
    await page.screenshot({
      path: "/tmp/taskasaur-office-" + extension + ".png",
    });
    await page.getByRole("button", { name: "Office", exact: true }).click();
  }
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  for (const [, kind, , expected] of cases) {
    await page
      .getByRole("button", { name: new RegExp("^Untitled " + kind + "\\.") })
      .click();
    await expect(page.getByText("Ready", { exact: true }))
      .toBeVisible({
        timeout: 60000,
      })
      .catch(async (e) => {
        console.log(
          "Frames:",
          await Promise.all(
            page.frames().map(async (f) => ({
              url: f.url(),
              body: await f
                .locator("body")
                .innerText()
                .catch(() => "unavailable"),
            })),
          ),
        );
        console.log(
          "Caches:",
          await page.evaluate(async () =>
            Promise.all(
              (await caches.keys()).map(async (name) => ({
                name,
                keys: (await (await caches.open(name)).keys()).map(
                  (r) => r.url,
                ),
              })),
            ),
          ),
        );
        throw e;
      });
    expect(String(await inspect(kind, false))).toContain(String(expected));
    await page.getByRole("button", { name: "Office", exact: true }).click();
  }
  await context.setOffline(false);
  await leaveWorkspace(page);
  await createWorkspace(page, "Empty office workspace");
  const newOffice = page
    .getByRole("row")
    .filter({ has: page.getByText("Office Editor", { exact: true }) });
  await newOffice.getByRole("button", { name: "Install", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm install", exact: true })
    .click();
  await newOffice
    .getByRole("button", { name: "Disable", exact: true })
    .waitFor();
  await navigate(page, "Office");
  await expect(
    page.getByRole("button", {
      name: /^Untitled (document|spreadsheet|presentation)\./,
    }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Empty office workspace");
  await navigate(page, "Office");
  await expect(
    page.getByRole("button", {
      name: /^Untitled (document|spreadsheet|presentation)\./,
    }),
  ).toHaveCount(0);
  await leaveWorkspace(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByLabel("Open internal workspace", { exact: true }).click();
  await page.getByRole("button", { name: "My workspace", exact: true }).click();
  await navigate(page, "Office");
  await expect(
    page.getByRole("button", {
      name: /^Untitled (document|spreadsheet|presentation)\./,
    }),
  ).toHaveCount(3);
  expect(
    await page.locator(".ql-editor,[data-custom-office-editor]").count(),
  ).toBe(0);
  expect(errors).toEqual([]);
  console.log(
    "Upstream LibreOffice ODT, ODS formula, ODP, durable core saves, exports, cold offline reopen and separate workspace contents passed.",
  );
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
