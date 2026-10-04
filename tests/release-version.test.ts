import { expect, it } from "vitest";
import {
  releaseVersion,
  nextNativeBuild,
} from "../scripts/release-version.mjs";

it("resolves dev to an immutable standard prerelease without nesting suffixes", () => {
  expect(
    releaseVersion("dev", "0.3.0-dev.1", new Date("2026-10-04T19:21:30Z")),
  ).toEqual({
    version: "0.3.0-dev.20261004192130",
    tag: "v0.3.0-dev.20261004192130",
    nativeVersion: "0.3.0",
    prerelease: true,
  });
  expect(releaseVersion("1.2.3", "0.3.0").prerelease).toBe(false);
  expect(releaseVersion("1.2.3-rc.1", "0.3.0").nativeVersion).toBe("1.2.3");
});
it("rejects unsafe or invalid release names", () => {
  for (const value of [
    undefined,
    "",
    "main",
    "01.2.3",
    "1.2",
    "1.2.3-dev.01",
    "1.2.3;echo x",
    "1.2.3-",
    "../dev",
  ])
    expect(() => releaseVersion(value, "0.3.0")).toThrow();
});
it("increments native builds across dev and stable versions", () => {
  expect(
    nextNativeBuild("versionCode 8", "CURRENT_PROJECT_VERSION = 10;"),
  ).toBe(11);
  expect(() => nextNativeBuild("versionCode 1", "")).toThrow();
  expect(() =>
    nextNativeBuild("versionCode 2100000000", "CURRENT_PROJECT_VERSION = 1;"),
  ).toThrow();
});
