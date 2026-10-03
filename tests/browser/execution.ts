import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startNativeRuntime } from "../../packages/platform-node/runtime";
const directory = await mkdtemp(
  path.join(os.tmpdir(), "taskasaur-execution-ui-"),
);
const peer = await startNativeRuntime({
  directory,
  name: "Execution test computer",
  automation: true,
  trustedCode: true,
  plugins: true,
  network: { listen: ["/ip4/127.0.0.1/tcp/0/ws"], relay: true },
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors: string[] = [];
page.setDefaultTimeout(45000);
page.on("pageerror", (e) => errors.push(e.message));
const button = (name: string) =>
  page.getByRole("button", { name, exact: true });
const nav = (name: string) =>
  page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name, exact: true });
async function install(name: string) {
  await button("Plugins").click();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText(name, { exact: true }) });
  await row.waitFor();
  const install = row.getByRole("button", { name: "Install", exact: true });
  if (await install.count()) {
    await install.click();
    await button("Confirm install").click();
  }
  await row.getByRole("button", { name: "Disable", exact: true }).waitFor();
}
async function selectComputer(name: RegExp) {
  await page
    .getByRole("combobox", { name: "Execution computer", exact: true })
    .click();
  await page
    .locator("[data-slot=select-content][data-open]")
    .getByRole("option", { name })
    .click();
}
try {
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58597");
  await button("Create workspace").click();
  await install("Automation Runtime");
  await install("Automation Editor");
  await nav("Devices").click();
  await expect(
    page.getByText("Native plugin services", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Device request", exact: true })
    .fill(peer.core.pairingRequest());
  await button("Approve device").click();
  const invitation = page.getByRole("textbox", {
    name: "Encrypted invitation",
    exact: true,
  });
  await expect(invitation).not.toHaveValue("");
  const node = await peer.core.join(await invitation.inputValue());
  await peer.services.attachWorkspace(node.replica.workspaceId);
  await page
    .getByLabel("Peer addresses", { exact: true })
    .fill(peer.addresses()[0]);
  await button("Save and synchronize").click();
  await expect(
    page.getByRole("row").filter({ hasText: "Execution test computer" }),
  ).toContainText("Online");
  await nav("Automations").click();
  await button("New entry").click();
  await page
    .getByLabel("Name", { exact: true })
    .fill("Runs on another computer");
  await button("Save").click();
  await expect(page.getByRole("dialog")).toContainText("Execution settings");
  await selectComputer(/Execution test computer/);
  await expect(page.getByRole("dialog")).toContainText(
    "automation-runtime: missing",
  );
  await button("Review plugin installation").click();
  await expect(page.getByRole("dialog").last()).toContainText(
    "automation-runtime.read",
  );
  await button("Install and enable reviewed plugins").click();
  await expect(
    page.getByText("This computer has the required plugins and capabilities.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 90000 });
  await page.getByRole("switch", { name: /Enable item execution/ }).click();
  await button("Save execution settings").click();
  await expect(page.getByText(/Execution settings saved/)).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await button("Runs on another computer").click();
  await button("input").click();
  await button("Publish and run").click();
  await expect(
    page.getByText("Run queued on the selected device.", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        node.records
          .all()
          .some(
            (r) =>
              r.collection === "workflow_runs" && r.data.status === "completed",
          ),
      { timeout: 30000 },
    )
    .toBe(true);
  console.log(
    "Real remote install, plugin status, explicit assignment and native execution passed",
  );
  // A second item stays unassigned; switching off the first leaves its history and the second intact.
  await button("Workflows").click();
  await button("New entry").click();
  await page.getByLabel("Name", { exact: true }).fill("Independent draft");
  await button("Save").click();
  await expect(
    page.getByText(
      "No execution computer assigned. Choose one and save before running this item.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: /Enable item execution/ }),
  ).not.toBeChecked();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await button("Runs on another computer").click();
  await page.getByRole("switch", { name: /Enable item execution/ }).click();
  await button("Save execution settings").click();
  await expect(button("Publish and run")).toBeDisabled();
  await expect(
    page.getByText("Execution is off for this item.", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page.screenshot({
    path: "/tmp/taskasaur-execution.png",
    fullPage: true,
  });
  await install("Tasks");
  await nav("Tasks").click();
  await button("New entry").click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Content has no execution target");
  await button("Save").click();
  await expect(button("Execution settings")).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    "Per-item pause, independent drafts and target-free content passed",
  );
} catch (error) {
  console.log((await page.locator("body").innerText()).slice(-6000));
  await page.screenshot({
    path: "/tmp/taskasaur-execution-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
  await peer.close();
  await rm(directory, { recursive: true, force: true });
}
