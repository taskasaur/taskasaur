import { spawn } from "node:child_process";
process.loadEnvFile(".env");
const port = process.env.DEV_APP_PORT ?? "3210";
const env = {
  ...process.env,
  DATABASE_URL: `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@127.0.0.1:58532/postgres`,
  SUPABASE_URL: "http://127.0.0.1:58521",
  SUPABASE_ANON_KEY: process.env.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SERVICE_ROLE_KEY,
  PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
  ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
  PUBLIC_GATEWAY_URL: "ws://localhost:3000/device-stream",
};
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--webpack",
    "--hostname",
    "127.0.0.1",
    "--port",
    port,
  ],
  { env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
