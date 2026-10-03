import type { Database } from "./database";
import { verifyCoreRelease } from "@taskasaur/platform/core/release";
import { createHash } from "node:crypto";
import { invariant } from "@taskasaur/platform/core/errors";
import { migrateTypedValues } from "./typed-values";
import { schemas, requiredCoreIds } from "@taskasaur/platform/core/catalog";
import {
  sqlIdentifier,
  sqlType,
  type Field,
  type RecordSchema,
} from "@taskasaur/platform/field-types";

export const baseMigration = `
CREATE SCHEMA IF NOT EXISTS taskasaur;
CREATE TABLE IF NOT EXISTS taskasaur.schema_version (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS taskasaur.workspaces (id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, revision bigint NOT NULL DEFAULT 0, access_epoch bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS taskasaur.memberships (workspace_id uuid NOT NULL REFERENCES taskasaur.workspaces(id),user_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('owner','editor','viewer')),PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS taskasaur.resources (id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES taskasaur.workspaces(id),owner_id uuid NOT NULL,plugin_id text NOT NULL,collection text NOT NULL,revision bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
CREATE INDEX IF NOT EXISTS resources_scope ON taskasaur.resources(workspace_id,collection,updated_at);
CREATE TABLE IF NOT EXISTS taskasaur.grants (resource_id uuid NOT NULL REFERENCES taskasaur.resources(id),subject_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('viewer','commenter','editor')),expires_at timestamptz,PRIMARY KEY(resource_id,subject_id));
CREATE TABLE IF NOT EXISTS taskasaur.mutations (workspace_id uuid NOT NULL,user_id uuid NOT NULL,id uuid NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(workspace_id,user_id,id));
CREATE TABLE IF NOT EXISTS taskasaur.changes (workspace_id uuid NOT NULL,sequence bigint NOT NULL,resource_id uuid NOT NULL REFERENCES taskasaur.resources(id),event jsonb NOT NULL,PRIMARY KEY(workspace_id,sequence));
CREATE TABLE IF NOT EXISTS taskasaur.plugins (workspace_id uuid NOT NULL REFERENCES taskasaur.workspaces(id),id text NOT NULL,version text NOT NULL,installed boolean NOT NULL,enabled boolean NOT NULL,features jsonb NOT NULL DEFAULT '[]',PRIMARY KEY(workspace_id,id));
CREATE TABLE IF NOT EXISTS taskasaur.secrets (resource_id uuid PRIMARY KEY REFERENCES taskasaur.resources(id),ciphertext text NOT NULL,version integer NOT NULL DEFAULT 1,revoked_at timestamptz);
CREATE TABLE IF NOT EXISTS taskasaur.file_versions (id uuid PRIMARY KEY,file_id uuid NOT NULL REFERENCES taskasaur.resources(id),parent_id uuid,object_path text NOT NULL,sha256 text NOT NULL,size bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS taskasaur.device_keys (device_id uuid PRIMARY KEY REFERENCES taskasaur.resources(id),public_key text NOT NULL,token_hash text NOT NULL,revoked_at timestamptz,lease_epoch integer NOT NULL DEFAULT 0,last_seen timestamptz);
CREATE TABLE IF NOT EXISTS taskasaur.job_leases (job_id uuid PRIMARY KEY REFERENCES taskasaur.resources(id),owner text,epoch bigint NOT NULL DEFAULT 0,expires_at timestamptz);
CREATE TABLE IF NOT EXISTS taskasaur.audit (id uuid PRIMARY KEY,workspace_id uuid NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,resource_id uuid,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS taskasaur.enrollments(code_hash text PRIMARY KEY,workspace_id uuid NOT NULL,user_id uuid NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS taskasaur.stream_tickets(id uuid PRIMARY KEY,token_hash text NOT NULL UNIQUE,device_id uuid NOT NULL,workspace_id uuid NOT NULL,user_id uuid NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS taskasaur.workflow_versions(workflow_id uuid NOT NULL,version integer NOT NULL,graph jsonb NOT NULL,target_device_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workflow_id,version));
ALTER TABLE taskasaur.workflow_versions ADD COLUMN IF NOT EXISTS trusted_code boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS taskasaur.dispatches(run_id uuid PRIMARY KEY,device_id uuid NOT NULL,workspace_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL DEFAULT 'queued',assignment_epoch bigint NOT NULL DEFAULT 1,expires_at timestamptz,execution jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE taskasaur.dispatches ADD COLUMN IF NOT EXISTS engine_run_id text;
ALTER TABLE taskasaur.dispatches ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS taskasaur.plugin_events(id text PRIMARY KEY,workspace_id uuid NOT NULL,actor_id uuid NOT NULL,event jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE taskasaur.plugin_events ADD COLUMN IF NOT EXISTS sequence bigserial;
CREATE INDEX IF NOT EXISTS plugin_events_scope ON taskasaur.plugin_events(workspace_id,sequence);
CREATE TABLE IF NOT EXISTS taskasaur.event_receipts(event_id text NOT NULL,plugin_id text NOT NULL,attempt integer NOT NULL DEFAULT 0,delivered_at timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(event_id,plugin_id));
CREATE TABLE IF NOT EXISTS taskasaur.scheduler_cursors(resource_id uuid PRIMARY KEY REFERENCES taskasaur.resources(id),through timestamptz,error text);
CREATE TABLE IF NOT EXISTS taskasaur.workflow_triggers(workflow_id uuid PRIMARY KEY REFERENCES taskasaur.resources(id),configuration text,slot bigint NOT NULL DEFAULT -1,event_cursor bigint NOT NULL DEFAULT 0,error text);
CREATE TABLE IF NOT EXISTS taskasaur.workflow_hooks(workflow_id uuid PRIMARY KEY REFERENCES taskasaur.resources(id),token_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS taskasaur.workflow_signals(id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES taskasaur.resources(id),name text NOT NULL,data jsonb NOT NULL,delivered_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
`;
function checks(f: Field) {
  const column = sqlIdentifier(f.id),
    result: string[] = [];
  if (f.choices) {
    const choices = f.choices
      .map((v) => `'${v.replaceAll("'", "''")}'`)
      .join(",");
    result.push(
      f.array
        ? `${column} <@ ARRAY[${choices}]::${sqlType(f)}`
        : `${column} IN (${choices})`,
    );
  }
  if (f.min !== undefined)
    result.push(
      f.array
        ? `${Number(f.min)} <= ALL(${column})`
        : `${column} >= ${Number(f.min)}`,
    );
  if (f.max !== undefined)
    result.push(
      f.array
        ? `${Number(f.max)} >= ALL(${column})`
        : `${column} <= ${Number(f.max)}`,
    );
  return result;
}
export function recordTable(schema: RecordSchema) {
  const columns = schema.fields.map((f) => {
    const id = sqlIdentifier(f.id);
    let sql = `${id} ${sqlType(f)}`;
    if (!f.nullable) sql += " NOT NULL";
    for (const check of checks(f)) sql += ` CHECK (${check})`;
    return sql;
  });
  return `CREATE TABLE IF NOT EXISTS taskasaur.${sqlIdentifier("p_" + schema.id)} (id uuid PRIMARY KEY REFERENCES taskasaur.resources(id),${columns.join(",")});`;
}
export async function migrate(db: Database) {
  verifyCoreRelease();
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(748192401)");
    await tx.query(baseMigration);
    for (const schema of schemas) await migrateRecordSchema(tx, schema);
    await migrateTypedValues(tx);
    const workspaces = await tx.query<{ id: string }>(
      "SELECT id FROM taskasaur.workspaces",
    );
    for (const workspace of workspaces.rows)
      await seedCorePlugins(tx, workspace.id);
    // Never expose application tables via PostgREST/browser roles.
    await tx.query("REVOKE ALL ON SCHEMA taskasaur FROM PUBLIC");
    await tx.query(
      "DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON SCHEMA taskasaur FROM anon; END IF; IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON SCHEMA taskasaur FROM authenticated; END IF; END $$",
    );
    await tx.query(
      "INSERT INTO taskasaur.schema_version(version) VALUES(1) ON CONFLICT DO NOTHING",
    );
  });
}
export async function seedCorePlugins(db: Database, workspaceId: string) {
  for (const id of requiredCoreIds)
    await db.query(
      "INSERT INTO taskasaur.plugins(workspace_id,id,version,installed,enabled) VALUES($1,$2,$3,true,true) ON CONFLICT(workspace_id,id) DO UPDATE SET version=EXCLUDED.version,installed=true,enabled=true",
      [workspaceId, id, "1.0.0"],
    );
}

export async function migrateRecordSchema(tx: Database, schema: RecordSchema) {
  await tx.query(recordTable(schema));
  const columns = await tx.query<{
    column_name: string;
    native_type: string;
    required: boolean;
  }>(
    "SELECT a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS native_type,a.attnotnull AS required FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='taskasaur' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped",
    ["p_" + schema.id],
  );
  const known = new Set(columns.rows.map((c) => c.column_name));
  for (const field of schema.fields) {
    const deployed = columns.rows.find((c) => c.column_name === field.id);
    invariant(
      !deployed ||
        (deployed.native_type === sqlType(field) &&
          deployed.required === !field.nullable),
      "SCHEMA_DRIFT",
      `Deployed ${schema.id}.${field.id} differs from the release contract; a reviewed migration is required`,
    );
    if (!known.has(field.id)) {
      if (!field.nullable && field.default === undefined)
        throw new Error(
          `Migration needs a backfill for ${schema.id}.${field.id}`,
        );
      const table = `taskasaur.${sqlIdentifier("p_" + schema.id)}`,
        column = sqlIdentifier(field.id);
      await tx.query(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType(field)}`,
      );
      if (field.default !== undefined)
        await tx.query(`UPDATE ${table} SET ${column}=$1`, [
          field.pgType === "jsonb"
            ? JSON.stringify(field.default)
            : field.default,
        ]);
      if (!field.nullable)
        await tx.query(
          `ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`,
        );
    }
    for (const check of checks(field)) {
      const name =
        "ck_" +
        createHash("sha256")
          .update(schema.id + ":" + check)
          .digest("hex")
          .slice(0, 32);
      const present = await tx.query(
        "SELECT oid FROM pg_constraint WHERE conname=$1",
        [name],
      );
      if (!present.rows.length)
        await tx.query(
          `ALTER TABLE taskasaur.${sqlIdentifier("p_" + schema.id)} ADD CONSTRAINT ${sqlIdentifier(name)} CHECK (${check})`,
        );
    }
  }
}
