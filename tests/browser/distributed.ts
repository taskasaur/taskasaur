import { navigate, addColumnTemplates } from "./navigation-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startNativeRuntime } from "../../packages/platform-node/runtime";
const directory = await mkdtemp(
  path.join(os.tmpdir(), "taskasaur-browser-peer-"),
);
const peer = await startNativeRuntime({
  directory,
  name: "Integration peer",
  network: { listen: ["/ip4/127.0.0.1/tcp/0/ws"], relay: true },
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors: string[] = [];
try {
  const a = await browser.newContext(),
    b = await browser.newContext(),
    first = await a.newPage(),
    second = await b.newPage();
  for (const page of [first, second]) {
    page.setDefaultTimeout(30000);
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.log("Page error:", e.message);
    });
  }
  first.on("console", (message) => {
    if (message.type() === "error")
      console.log("Browser error:", message.text().slice(0, 300));
  });
  const url = process.env.TEST_APP_URL ?? "http://127.0.0.1:58597";
  await first.goto(url);
  await first
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  async function install(page: typeof first, name: string) {
    console.log("Installing", name);
    await expect(page.getByRole("navigation", { name: "Current page" }))
      .toBeVisible({ timeout: 30000 })
      .catch(async (e) => {
        console.log((await page.locator("body").innerText()).slice(0, 1600));
        throw e;
      });
    await navigate(page, "Plugins");
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await row
      .getByRole("button", { name: "Install", exact: true })
      .click({ timeout: 30000 });
    await page
      .getByRole("button", { name: "Confirm install", exact: true })
      .click();
    await row
      .getByRole("button", { name: "Disable", exact: true })
      .waitFor({ timeout: 30000 });
  }
  await install(first, "Tasks");
  await navigate(first, "Devices");
  await first
    .getByRole("textbox", { name: "Device request", exact: true })
    .fill(peer.core.pairingRequest());
  await first
    .getByRole("button", { name: "Approve device", exact: true })
    .click();
  await expect(
    first.getByRole("textbox", { name: "Encrypted invitation", exact: true }),
  ).not.toHaveValue("", { timeout: 30000 });
  console.log("Pairing native peer");
  const node = await peer.core.join(
    await first
      .getByRole("textbox", { name: "Encrypted invitation", exact: true })
      .inputValue(),
  );
  await peer.services.attachWorkspace(node.replica.workspaceId);
  await first
    .getByLabel("Peer addresses", { exact: true })
    .fill(peer.addresses()[0]);
  await first
    .getByRole("button", { name: "Save and synchronize", exact: true })
    .click();
  await expect(
    first.getByRole("row").filter({ hasText: "Integration peer" }),
  ).toContainText("Online", { timeout: 30000 });
  await navigate(first, "Tasks");
  await addColumnTemplates(first, "Tasks", ["Title"]);
  await first.getByRole("button", { name: "New entry", exact: true }).click();
  await first
    .getByLabel("Title", { exact: true })
    .fill("Replicated browser task");
  await first.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(
      () =>
        node.records
          .all()
          .some((r) => r.data.title === "Replicated browser task"),
      { timeout: 40000 },
    )
    .toBe(true);
  console.log("Pairing second browser");
  await second.goto(url);
  await second
    .getByRole("button", { name: "Join workspace", exact: true })
    .click();
  const request = await second
    .getByRole("textbox", { name: "Device request", exact: true })
    .inputValue();
  await navigate(first, "Devices");
  await first
    .getByRole("textbox", { name: "Device request", exact: true })
    .fill(request);
  await first
    .getByRole("button", { name: "Approve device", exact: true })
    .click();
  await expect(
    first.getByRole("textbox", { name: "Encrypted invitation", exact: true }),
  ).toHaveValue(new RegExp(JSON.parse(request).identity.id));
  await second
    .getByLabel("Workspace invitation", { exact: true })
    .fill(
      await first
        .getByRole("textbox", { name: "Encrypted invitation", exact: true })
        .inputValue(),
    );
  await second
    .getByRole("button", { name: "Join and save local copy", exact: true })
    .click();
  await install(second, "Tasks");
  await navigate(second, "Tasks");
  await second
    .getByRole("button", { name: "Replicated browser task", exact: true })
    .waitFor({ timeout: 40000 });
  await second.evaluate(() => navigator.serviceWorker.ready.then(() => null));
  await b.setOffline(true);
  await second.reload();
  await second
    .getByRole("button", { name: "Replicated browser task", exact: true })
    .waitFor({ timeout: 30000 });
  await second.getByRole("button", { name: "New entry", exact: true }).click();
  await second.getByLabel("Title", { exact: true }).fill("Written offline");
  await second.getByRole("button", { name: "Save", exact: true }).click();
  await second
    .getByRole("button", { name: "Written offline", exact: true })
    .waitFor()
    .catch(async (e) => {
      console.log((await second.locator("body").innerText()).slice(-2000));
      throw e;
    });
  await second.reload();
  await second
    .getByRole("button", { name: "Written offline", exact: true })
    .waitFor();
  await b.setOffline(false);
  await second
    .getByRole("button", { name: "Open settings menu", exact: true })
    .click();
  await second
    .getByRole("button", { name: "Synchronize workspace", exact: true })
    .click();
  await expect
    .poll(
      () => node.records.all().some((r) => r.data.title === "Written offline"),
      { timeout: 45000 },
    )
    .toBe(true);
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "Two browser replicas paired through a native peer; signed plugin install, encrypted sync, cold offline reload, offline writes, and reconnection passed.",
  );
} finally {
  await browser.close();
  await peer.close();
  await rm(directory, { recursive: true, force: true });
}
