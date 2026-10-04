import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Verify the actual downloads, not just the unpacked builder output. Launching
// Electron directly does not exercise Gatekeeper or detect a broken resource seal.
assert.equal(process.platform, "darwin", "macOS is required for verification");
const arch = process.argv[2] ?? process.arch;
assert.ok(["arm64", "x64"].includes(arch), "Expected arm64 or x64");
const { version, build } = JSON.parse(await readFile("package.json", "utf8"));
const directory = path.resolve(process.argv[3] ?? "release");
const prefix = path.join(directory, `Taskasaur-${version}-mac-${arch}`);
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "taskasaur-macos-release-"),
);
const extracted = path.join(temporary, "zip");
const mounted = path.join(temporary, "dmg");
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

function verifyApp(app) {
  console.log(`Checking signature and metadata: ${app}`);
  run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app,
  ]);
  const plist = path.join(app, "Contents", "Info.plist");
  const value = (key) =>
    run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], {
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  assert.equal(value("CFBundleIdentifier"), build.appId);
  assert.equal(value("CFBundleShortVersionString"), version);
  const binaryArch = run(
    "/usr/bin/lipo",
    [
      "-archs",
      path.join(app, "Contents", "MacOS", value("CFBundleExecutable")),
    ],
    { stdio: "pipe", encoding: "utf8" },
  ).trim();
  assert.equal(binaryArch, arch === "x64" ? "x86_64" : "arm64");
}

try {
  await mkdir(extracted);
  run("/usr/bin/ditto", ["-x", "-k", `${prefix}.zip`, extracted]);
  const app = path.join(extracted, "Taskasaur.app");
  verifyApp(app);

  await mkdir(mounted);
  run("/usr/bin/hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mounted,
    `${prefix}.dmg`,
  ]);
  try {
    verifyApp(path.join(mounted, "Taskasaur.app"));
  } finally {
    run("/usr/bin/hdiutil", ["detach", mounted]);
  }

  // Exercises native PTY and live/encrypted workspace files in a temporary
  // profile. Never open a developer's real workspace during packaging checks.
  run(process.execPath, ["tests/browser/desktop.mjs"], {
    env: {
      ...process.env,
      TASKASAUR_DESKTOP_EXECUTABLE: path.join(
        app,
        "Contents",
        "MacOS",
        "Taskasaur",
      ),
    },
  });
  console.log(
    `macOS ${arch}: DMG/ZIP signatures, metadata and desktop integration passed.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
