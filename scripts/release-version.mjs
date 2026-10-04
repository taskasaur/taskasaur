/** Stable and development releases use ordinary, immutable SemVer tags. */
export function releaseVersion(requested, current, now = new Date()) {
  const version =
    requested === "dev"
      ? `${current.split("-")[0]}-dev.${now.toISOString().replace(/\D/g, "").slice(0, 14)}`
      : requested;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version ?? "",
    );
  if (
    !match ||
    match[4]
      ?.split(".")
      .some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")
  )
    throw Error(
      "Use dev, major.minor.patch, or a SemVer prerelease such as 0.3.0-dev.1.",
    );
  return {
    version,
    tag: `v${version}`,
    nativeVersion: match.slice(1, 4).join("."),
    prerelease: Boolean(match[4]),
  };
}

export function nextNativeBuild(android, ios) {
  const versions = [
    ...android.matchAll(/versionCode\s+(\d+)/g),
    ...ios.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g),
  ].map((match) => Number(match[1]));
  if (versions.length < 2) throw Error("Native version fields are missing.");
  const next = Math.max(...versions) + 1;
  if (!Number.isSafeInteger(next) || next > 2_100_000_000)
    throw Error("Native build number is out of range.");
  return next;
}
