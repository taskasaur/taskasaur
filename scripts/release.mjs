import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { releaseVersion, nextNativeBuild } from "./release-version.mjs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
let release;
try {
  release = releaseVersion(process.argv[2]?.trim(), packageJson.version);
} catch (error) {
  console.error("Usage: make release version=dev (or version=1.1.1)");
  console.error(error.message);
  process.exit(1);
}
const { version, tag, nativeVersion } = release;

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  }).trim();
}

// These local planning documents are deliberately outside release source control.
const changes = git("status", "--porcelain", "--untracked-files=all")
  .split("\n")
  .filter(
    (line) =>
      line &&
      !/^\?\? docs\/(rebuild-plan|implementation-status)\.md$/.test(line),
  );
if (changes.length) {
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

if (
  git("tag", "--list", tag) ||
  git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)
) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

execFileSync("npm", ["test"], { stdio: "inherit" });
execFileSync("npm", ["run", "build"], { stdio: "inherit" });

packageJson.version = version;
writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
packageLock.version = version;
if (packageLock.packages?.[""]) {
  packageLock.packages[""].version = version;
}
writeFileSync("package-lock.json", `${JSON.stringify(packageLock, null, 2)}\n`);

const androidPath = "android/app/build.gradle";
const iosPath = "ios/App/App.xcodeproj/project.pbxproj";
const buildNumber = nextNativeBuild(
  readFileSync(androidPath, "utf8"),
  readFileSync(iosPath, "utf8"),
);
const androidBuild = readFileSync(androidPath, "utf8")
  .replace(/versionCode\s+\d+/, `versionCode ${buildNumber}`)
  .replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);
writeFileSync(androidPath, androidBuild);

const iosProject = readFileSync(iosPath, "utf8")
  .replace(
    /CURRENT_PROJECT_VERSION = \d+;/g,
    `CURRENT_PROJECT_VERSION = ${buildNumber};`,
  )
  .replace(
    /MARKETING_VERSION = [^;]+;/g,
    `MARKETING_VERSION = ${nativeVersion};`,
  );
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
  `Pushed ${tag}. GitHub Actions will build and publish the ${release.prerelease ? "prerelease" : "release"}. Track it with gh run list --workflow release.yml.`,
);
