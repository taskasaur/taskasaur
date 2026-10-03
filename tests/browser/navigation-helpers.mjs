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
