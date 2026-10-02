import { readFile, writeFile, mkdir } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import {
  packPlugin,
  verifyPackage,
  installPackage,
  installedPackages,
} from "../server/plugin-packages";
import { database, closeDatabase } from "../server/database";
const [action, ...args] = process.argv.slice(2);
if (action === "keygen") {
  const directory = args[0];
  if (!directory)
    throw new Error("Usage: npm run plugins -- keygen <new-directory>");
  await mkdir(directory, { mode: 0o700 });
  const pair = generateKeyPairSync("ed25519");
  await writeFile(
    path.join(directory, "private.pem"),
    pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(
    path.join(directory, "public.pem"),
    pair.publicKey.export({ format: "pem", type: "spki" }),
    { mode: 0o644, flag: "wx" },
  );
  console.log("Publisher key pair created. Keep private.pem private.");
} else if (action === "pack") {
  const [directory, key, out] = args;
  if (!directory || !key || !out)
    throw new Error(
      "Usage: npm run plugins -- pack <directory> <private.pem> <output.zip>",
    );
  await writeFile(
    out,
    await packPlugin(directory, await readFile(key, "utf8")),
    { flag: "wx" },
  );
  console.log("Signed plugin artifact created.");
} else if (action === "verify" || action === "install") {
  const [artifact, trustFile, ...grants] = args;
  if (!artifact || !trustFile)
    throw new Error(
      "Usage: npm run plugins -- verify|install <artifact.zip> <trust.json> [granted-permissions...]",
    );
  const bytes = await readFile(artifact),
    trust = JSON.parse(await readFile(trustFile, "utf8"));
  if (action === "verify") {
    const result = await verifyPackage(bytes, trust);
    console.log(
      JSON.stringify(
        { manifest: result.manifest, digest: result.digest },
        null,
        2,
      ),
    );
  } else {
    console.log(
      await installPackage(
        bytes,
        trust,
        grants,
        process.env.DATABASE_URL ? database() : undefined,
      ),
    );
    await closeDatabase();
  }
} else if (action === "list")
  console.log(JSON.stringify(await installedPackages(), null, 2));
else throw new Error("Commands: keygen, pack, verify, install, list");
