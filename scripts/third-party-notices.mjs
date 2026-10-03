import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
const lock = JSON.parse(await readFile("package-lock.json", "utf8")),
  notices = [
    "Taskasaur third-party notices\nRuntime dependencies; some packages are used only on particular platforms.\n",
  ];
for (const [directory, entry] of Object.entries(lock.packages).sort(
  ([a], [b]) => a.localeCompare(b),
)) {
  if (!directory.startsWith("node_modules/") || entry.dev || entry.link)
    continue;
  try {
    const pkg = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      ),
      texts = [];
    for (const name of (await readdir(directory)).filter((name) =>
      /^(license|licence|copying|notice)(\.|$)/i.test(name),
    ))
      try {
        texts.push(await readFile(path.join(directory, name), "utf8"));
      } catch {}
    notices.push(
      `${pkg.name}@${pkg.version}\nLicense: ${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? "See package source")}\n${texts.join("\n")}\n`,
    );
  } catch {}
}
await writeFile(
  "public/THIRD_PARTY_NOTICES.txt",
  notices.join("\n----------------------------------------\n\n"),
);
