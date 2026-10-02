import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { Repository } from "./repository";
import type { Principal } from "../packages/plugin-sdk";
import { invariant } from "../packages/core/errors";
function storage() {
  invariant(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
    "CONFIGURATION_REQUIRED",
    "File storage is not configured",
  );
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  ).storage;
}
export class FileService {
  constructor(private repo: Repository) {}
  async upload(
    principal: Principal,
    fileId: string,
    bytes: Buffer,
    mediaType: string,
    parentId: string | null,
    id: string,
  ) {
    const record = await this.repo.get(principal, fileId);
    await this.repo.authorize(principal, fileId, true);
    invariant(
      record.collection === "files",
      "VALIDATION_FAILED",
      "Expected a file resource",
    );
    invariant(
      bytes.length <= 50 * 1024 * 1024,
      "PAYLOAD_TOO_LARGE",
      "File exceeds the 50 MB upload limit",
    );
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const prior = await this.repo.db.query<{
      sha256: string;
      parent_id: string | null;
    }>(
      "SELECT sha256,parent_id FROM taskasaur.file_versions WHERE id=$1 AND file_id=$2",
      [id, fileId],
    );
    if (prior.rows[0]) {
      invariant(
        prior.rows[0].sha256 === checksum &&
          prior.rows[0].parent_id === parentId,
        "IDEMPOTENCY_CONFLICT",
        "File version ID was used for different bytes",
      );
      return { versionId: id, record: await this.repo.get(principal, fileId) };
    }
    // Separate object identity prevents a retried upload from deleting a committed object.
    const objectPath = `${principal.workspaceId}/${fileId}/${randomUUID()}`;
    await storage().createBucket("taskasaur-files", {
      public: false,
      fileSizeLimit: 50 * 1024 * 1024,
    });
    const { error } = await storage()
      .from("taskasaur-files")
      .upload(objectPath, bytes, { contentType: mediaType, upsert: false });
    invariant(!error, "STORAGE_UNAVAILABLE", "Could not store file bytes");
    try {
      await this.repo.db.transaction(async (tx) => {
        await tx.query(
          "SELECT id FROM taskasaur.workspaces WHERE id=$1 FOR UPDATE",
          [principal.workspaceId],
        );
        const repository = new Repository(tx);
        await repository.authorize(principal, fileId, true);
        const metadata = await tx.query<{ version_id: string | null }>(
          "SELECT version_id FROM taskasaur.p_files WHERE id=$1 FOR UPDATE",
          [fileId],
        );
        invariant(
          metadata.rows[0].version_id === parentId,
          "REVISION_CONFLICT",
          "A newer file version exists; the local version is retained",
        );
        await tx.query(
          "INSERT INTO taskasaur.file_versions(id,file_id,parent_id,object_path,sha256,size) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            fileId,
            parentId,
            objectPath,
            createHash("sha256").update(bytes).digest("hex"),
            String(bytes.length),
          ],
        );
        const current = await repository.get(principal, fileId);
        await repository.mutate(principal, {
          id,
          resourceId: fileId,
          pluginId: "files",
          collection: "files",
          operation: "put",
          baseRevision: current.revision,
          createdAt: new Date().toISOString(),
          data: {
            ...current.data,
            version_id: id,
            size: String(bytes.length),
            media_type: mediaType,
            checksum,
            upload_state: "available",
          },
        });
      });
    } catch (error) {
      await storage().from("taskasaur-files").remove([objectPath]);
      throw error;
    }
    return { versionId: id, record: await this.repo.get(principal, fileId) };
  }
  async download(principal: Principal, fileId: string, versionId?: string) {
    const resource = await this.repo.get(principal, fileId);
    invariant(
      resource.collection === "files",
      "VALIDATION_FAILED",
      "Expected a file",
    );
    const version = (
      await this.repo.db.query<{ object_path: string }>(
        "SELECT object_path FROM taskasaur.file_versions WHERE file_id=$1 AND id=$2",
        [fileId, versionId ?? resource.data.version_id],
      )
    ).rows[0];
    invariant(version, "NOT_FOUND", "File version was not found");
    const { data, error } = await storage()
      .from("taskasaur-files")
      .download(version.object_path);
    invariant(!error && data, "STORAGE_UNAVAILABLE", "File download failed");
    return data;
  }
}
