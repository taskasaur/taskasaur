import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseEnv } from "node:util";

it("merges setup defaults without rewriting existing quoting or credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "taskasaur-setup-"));
  const filename = path.join(directory, "deployment.env");
  const original =
    "# Preserve operator configuration\nJWT_SECRET='fixture-stable-key'\nSMTP_PASS='fixture$literal#with spaces'\nPUBLIC_APP_URL=\"https://fixture.example/path\"";
  try {
    await writeFile(filename, original, { mode: 0o644 });
    execFileSync(process.execPath, ["scripts/setup.mjs", filename, "--merge"], {
      stdio: "pipe",
    });
    const merged = await readFile(filename, "utf8");
    expect(merged.startsWith(original + "\n")).toBe(true);
    const values = parseEnv(merged);
    expect(values.SMTP_PASS).toBe("fixture$literal#with spaces");
    expect(values.JWT_SECRET).toBe("fixture-stable-key");
    expect(values.CREDENTIAL_ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== "win32")
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
    execFileSync(process.execPath, ["scripts/setup.mjs", filename, "--merge"], {
      stdio: "pipe",
    });
    expect(await readFile(filename, "utf8")).toBe(merged);
    const empty = path.join(directory, "empty.env");
    await writeFile(empty, "");
    execFileSync(process.execPath, ["scripts/setup.mjs", empty, "--merge"], {
      stdio: "pipe",
    });
    expect(parseEnv(await readFile(empty, "utf8")).JWT_SECRET).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(() =>
      execFileSync(process.execPath, ["scripts/setup.mjs", filename], {
        stdio: "pipe",
      }),
    ).toThrow();
    expect(await readFile(filename, "utf8")).toBe(merged);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
