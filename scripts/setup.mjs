import { randomBytes, createHmac, randomUUID } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { parseEnv } from "node:util";
const mergeExisting = process.argv.includes("--merge");
const filename =
  process.argv.slice(2).find((arg) => arg !== "--merge") ?? ".env";
let existing = {};
try {
  await access(filename);
  if (!mergeExisting)
    throw new Error(
      `${filename} already exists; setup will not overwrite it. Use --merge to add missing settings while retaining existing values.`,
    );
  existing = parseEnv(await readFile(filename, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const secret = existing.JWT_SECRET || randomBytes(32).toString("hex");
function jwt(role) {
  const head = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url"),
    body = Buffer.from(
      JSON.stringify({
        role,
        iss: "supabase",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 5 * 365 * 86400,
      }),
    ).toString("base64url");
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
const values = {
  ...parseEnv(await readFile("deploy/supabase/upstream/.env.example", "utf8")),
  COMPOSE_FILE: "compose.yaml",
  TASKASAUR_IMAGE: "taskasaur/taskasaur:0.2.0",
  APP_PORT: "3000",
  PUBLIC_APP_URL: "http://localhost:3000",
  POSTGRES_HOST: "db",
  POSTGRES_PORT: "5432",
  POSTGRES_DB: "postgres",
  POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
  JWT_SECRET: secret,
  JWT_EXPIRY: "3600",
  ANON_KEY: jwt("anon"),
  SERVICE_ROLE_KEY: jwt("service_role"),
  CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  SERVER_WORKER_ID: randomUUID(),
  POOLER_TENANT_ID: randomUUID(),
  POOLER_DEFAULT_POOL_SIZE: "10",
  POOLER_MAX_CLIENT_CONN: "100",
  POOLER_DB_POOL_SIZE: "5",
  POOLER_PROXY_PORT_TRANSACTION: "6543",
  FUNCTIONS_VERIFY_JWT: "true",
  SECRET_KEY_BASE: randomBytes(64).toString("hex"),
  VAULT_ENC_KEY: randomBytes(16).toString("hex"),
  PG_META_CRYPTO_KEY: randomBytes(16).toString("hex"),
  API_EXTERNAL_URL: "http://localhost:3000",
  SITE_URL: "http://localhost:3000",
  SUPABASE_PUBLIC_URL: "http://api-gw:8000",
  ADDITIONAL_REDIRECT_URLS: "",
  DISABLE_SIGNUP: "false",
  ENABLE_EMAIL_SIGNUP: "true",
  ENABLE_EMAIL_AUTOCONFIRM: "true",
  ENABLE_ANONYMOUS_USERS: "false",
  ENABLE_PHONE_SIGNUP: "false",
  ENABLE_PHONE_AUTOCONFIRM: "false",
  SMTP_ADMIN_EMAIL: "admin@example.com",
  SMTP_HOST: "",
  SMTP_PORT: "587",
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_SENDER_NAME: "Taskasaur",
  MAILER_URLPATHS_INVITE: "/auth/v1/verify",
  MAILER_URLPATHS_CONFIRMATION: "/auth/v1/verify",
  MAILER_URLPATHS_RECOVERY: "/auth/v1/verify",
  MAILER_URLPATHS_EMAIL_CHANGE: "/auth/v1/verify",
  PGRST_DB_SCHEMAS: "public,storage,graphql_public",
  PGRST_DB_MAX_ROWS: "1000",
  PGRST_DB_EXTRA_SEARCH_PATH: "public",
  PGRST_DB_POOL: "10",
  PGRST_DB_POOL_ACQUISITION_TIMEOUT: "10",
  PGRST_DB_PRE_REQUEST: "",
  STORAGE_BACKEND: "file",
  GLOBAL_S3_BUCKET: "taskasaur",
  STORAGE_TENANT_ID: "taskasaur",
  REGION: "local",
  S3_PROTOCOL_ACCESS_KEY_ID: randomBytes(16).toString("hex"),
  S3_PROTOCOL_ACCESS_KEY_SECRET: randomBytes(32).toString("hex"),
  IMGPROXY_AUTO_WEBP: "true",
  DASHBOARD_USERNAME: "admin",
  DASHBOARD_PASSWORD: randomBytes(24).toString("hex"),
  STUDIO_DEFAULT_ORGANIZATION: "Taskasaur",
  STUDIO_DEFAULT_PROJECT: "Workspace",
  OPENAI_API_KEY: "",
  LOGFLARE_PUBLIC_ACCESS_TOKEN: randomBytes(32).toString("hex"),
  LOGFLARE_PRIVATE_ACCESS_TOKEN: randomBytes(32).toString("hex"),
};
const compose = await readFile("compose.yaml", "utf8");
const variables = [...compose.matchAll(/\$\{([A-Z_0-9]+)/g)].map((m) => m[1]);
for (const name of variables) if (!(name in values)) values[name] = "";
for (const [name, value] of Object.entries(existing)) values[name] = value;
await writeFile(
  filename,
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
console.log(
  `${mergeExisting ? "Updated missing settings in" : "Created"} ${filename}; existing secrets are preserved. Keep it with encrypted backups.`,
);
