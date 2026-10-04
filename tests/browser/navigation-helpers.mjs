/** Navigate through the same responsive menus on desktop and mobile. */
export async function navigate(page, name) {
  const right = [
    "Files",
    "Tables",
    "Variables",
    "Credentials",
    "Devices",
    "Notifications",
    "Jobs",
    "Settings",
  ].includes(name);
  const menu = page.getByRole("navigation", {
    name: right ? "Settings and tools" : "Workspace",
    exact: true,
  });
  if (!(await menu.isVisible()))
    await page
      .getByRole("button", {
        name: right ? "Open settings menu" : "Open plugins menu",
        exact: true,
      })
      .click();
  await menu.getByRole("button", { name, exact: true }).click();
  await menu.waitFor({ state: "hidden" });
}
/** Add optional templates explicitly: new plugin tables contain only required contracts. */
export async function addColumnTemplates(page, plugin, labels) {
  await navigate(page, plugin);
  await page
    .getByRole("button", { name: "Open plugins menu", exact: true })
    .click();
  const menu = page.getByRole("navigation", { name: "Workspace", exact: true });
  await menu
    .getByRole("button", { name: `${plugin} pages`, exact: true })
    .click();
  await menu.getByRole("button", { name: "Columns", exact: true }).click();
  for (const label of labels) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page
      .getByRole("button", { name: `Edit ${label} column`, exact: true })
      .waitFor();
  }
  await navigate(page, plugin);
}

/** Exercise the real welcome flow; every test owns an explicitly named workspace. */
export async function createWorkspace(page, name = "My workspace") {
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Internal workspace name", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Create internal workspace", exact: true })
    .click();
  await page.getByRole("navigation", { name: "Current page" }).waitFor();
}
export async function leaveWorkspace(page) {
  await navigate(page, "Settings");
  await page
    .getByRole("button", { name: "Switch workspace", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).waitFor();
}
