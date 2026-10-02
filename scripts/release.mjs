import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.trim();
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const match = version?.match(semverPattern);

if (!match) {
  console.error("Usage: make release version=1.1.1");
  console.error("The version must use major.minor.patch format.");
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  }).trim();
}

if (git("status", "--porcelain")) {
  console.error("The working tree must be clean before creating a release.");
  console.error("Commit or stash your changes, then run the command again.");
  process.exit(1);
}

const branch = git("branch", "--show-current");
if (!branch) {
  console.error("Create releases from a branch, not a detached HEAD.");
  process.exit(1);
}

execFileSync("git", ["fetch", "origin", branch], { stdio: "inherit" });
const upstream = git(
  "rev-parse",
  "--abbrev-ref",
  "--symbolic-full-name",
  "@{u}",
);
const localHead = git("rev-parse", "HEAD");
const upstreamHead = git("rev-parse", upstream);
if (localHead !== upstreamHead) {
  console.error(
    `The local branch must exactly match ${upstream} before releasing.`,
  );
  process.exit(1);
}

const tag = `v${version}`;
if (
  git("tag", "--list", tag) ||
  git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)
) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

execFileSync("npm", ["test"], { stdio: "inherit" });
execFileSync("npm", ["run", "build:web"], { stdio: "inherit" });

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
packageJson.version = version;
writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
packageLock.version = version;
if (packageLock.packages?.[""]) {
  packageLock.packages[""].version = version;
}
writeFileSync("package-lock.json", `${JSON.stringify(packageLock, null, 2)}\n`);

const [major, minor, patch] = match.slice(1).map(Number);
const buildNumber = major * 1_000_000 + minor * 1_000 + patch;

const androidPath = "android/app/build.gradle";
const androidBuild = readFileSync(androidPath, "utf8")
  .replace(/versionCode\s+\d+/, `versionCode ${buildNumber}`)
  .replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);
writeFileSync(androidPath, androidBuild);

const iosPath = "ios/App/App.xcodeproj/project.pbxproj";
const iosProject = readFileSync(iosPath, "utf8")
  .replace(
    /CURRENT_PROJECT_VERSION = \d+;/g,
    `CURRENT_PROJECT_VERSION = ${buildNumber};`,
  )
  .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
writeFileSync(iosPath, iosProject);

execFileSync(
  "git",
  ["add", "package.json", "package-lock.json", androidPath, iosPath],
  { stdio: "inherit" },
);
execFileSync("git", ["commit", "-m", `release: ${tag}`], { stdio: "inherit" });
execFileSync("git", ["tag", "-a", tag, "-m", `Taskasaur ${version}`], {
  stdio: "inherit",
});
execFileSync("git", ["push", "--atomic", "origin", branch, tag], {
  stdio: "inherit",
});

console.log(
  `Pushed ${tag}. GitHub Actions will build and publish the release.`,
);
