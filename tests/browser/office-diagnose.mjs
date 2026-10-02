import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => console.log("error", error.message));
  page.on("console", (message) => {
    if (
      /Unable to read|Aborted|ERROR|warn:|error:|Exception/.test(message.text())
    )
      console.log(message.text());
  });
  await page.goto("http://localhost:8080");
  if (await page.getByText("Internal Server Error").count())
    await page.reload();
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
  await page
    .getByRole("button", {
      name: process.env.OFFICE_KIND ?? "Document",
      exact: true,
    })
    .click();
  const editor = page.frameLocator('iframe[title="Offline office editor"]');
  await editor.locator("body").waitFor();
  await page.waitForTimeout(20000);
  const frame = page
    .frames()
    .find((f) => f.url().includes("/office-engine/cool.html"));
  console.log(
    await frame.evaluate(() => ({
      type: window.app?.map?.getDocType(),
      loaded: window.app?.map?._docLoaded,
      once: window.app?.map?._docLoadedOnce,
      module: !!window.Module?.FS,
      body: document.body.innerText.slice(-3000),
    })),
  );
  console.log("OUTER", await page.locator("main").innerText());
  await page.screenshot({ path: "/tmp/taskasaur-office-diagnose.png" });
  await frame.evaluate(() => {
    window.app.map.on("commandresult", (e) =>
      console.log(
        "COMMANDRESULT",
        JSON.stringify({ command: e.commandName, success: e.success }),
      ),
    );
    window.app.map.sendUnoCommand(".uno:InsertText", {
      Text: { type: "string", value: "diagnostic text" },
    });
  });
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(3000);
  console.log("SAVED", await page.locator("main").innerText());
} finally {
  await browser.close();
}
