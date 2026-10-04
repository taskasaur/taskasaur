import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { releaseVersion } from "./release-version.mjs";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const { tag, prerelease } = releaseVersion(version, version);
if (tag !== process.env.RELEASE_TAG) throw Error("Version/tag mismatch");
const directory = process.argv[2];
const names = (await readdir(directory))
  .filter(
    (name) =>
      name.startsWith(`Taskasaur-${version}-`) &&
      /\.(dmg|zip|exe|AppImage|deb|apk|yaml)$/.test(name),
  )
  .sort();
// Do not publish an apparently complete release with a missing platform.
for (const suffix of [
  "-mac-arm64.dmg",
  "-mac-x64.dmg",
  "-mac-arm64.zip",
  "-mac-x64.zip",
  "-win-x64.exe",
  "-linux-x64.AppImage",
  "-linux-arm64.AppImage",
  "-linux-x64.deb",
  "-linux-arm64.deb",
  "-ios-unsigned.zip",
  "-ios-simulator-arm64.zip",
  "-web.zip",
  "-server.compose.yaml",
  version.includes("-dev.") ? "-android.apk" : "-android-unsigned.apk",
])
  if (!names.some((name) => name.endsWith(suffix)))
    throw Error(`Missing release asset: ${suffix}`);
const checksums = [];
for (const name of names) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path.join(directory, name)))
    hash.update(chunk);
  checksums.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(
  path.join(directory, "SHA256SUMS.txt"),
  checksums.join("\n") + "\n",
);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const notes = `${prerelease ? "Development / prerelease build for testing." : "Taskasaur release."}\n\nSource: ${revision}\n\n- Independent devices, peer sync and offline internal workspaces.\n- Portable .taskasaur workspace files, optional encryption and internal imports.\n- Shared tables, filters, groups, search, commands and installable plugins.\n\nDownloads: macOS Apple Silicon/Intel, Windows x64, Linux x64/arm64, Android, iOS, web, and a pinned Docker Compose server configuration.\n\nmacOS app bundles are ad-hoc signed and their ZIP/DMG signatures are verified, but they are not Apple-notarized or publisher-signed. If macOS blocks an unidentified developer, use System Settings → Privacy & Security → Open Anyway for a build you trust (https://support.apple.com/en-us/102445). Windows builds are not publisher-signed. ${version.includes("-dev.") ? "Android uses a persistent development signing key for sideloading and updates." : "The Android APK needs your own signing before installation."} The unsigned iOS device app needs Apple signing/provisioning; the arm64 simulator app runs in Xcode Simulator on Apple Silicon. There is no App Store/TestFlight release. Web Office support requires cross-origin isolation; see the included README.\n\nContainer: ghcr.io/taskasaur/taskasaur:${version} (amd64 and arm64).\n\nVerify downloads with SHA256SUMS.txt. Back up workspaces before trying a prerelease.\n`;
const notesFile = path.join(
  process.env.RUNNER_TEMP ?? directory,
  "release-notes.md",
);
await writeFile(notesFile, notes);
const gh = (...args) => execFileSync("gh", args, { stdio: "inherit" });
const exists =
  spawnSync("gh", ["release", "view", tag], { stdio: "ignore" }).status === 0;
if (!exists)
  gh(
    "release",
    "create",
    tag,
    "--verify-tag",
    "--draft",
    "--title",
    `Taskasaur ${version}`,
    "--notes-file",
    notesFile,
    ...(prerelease ? ["--prerelease", "--latest=false"] : []),
  );
gh(
  "release",
  "upload",
  tag,
  ...[...names, "SHA256SUMS.txt"].map((name) => path.join(directory, name)),
  "--clobber",
);
gh(
  "release",
  "edit",
  tag,
  "--draft=false",
  `--prerelease=${prerelease}`,
  "--notes-file",
  notesFile,
  `--latest=${!prerelease}`,
);
