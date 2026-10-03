import type { Repository } from "./repository";
import { nodeFor } from "./database";
import { projectRecord } from "./projection";
import type { Principal } from "@taskasaur/platform/plugin-sdk";
import { invariant } from "@taskasaur/platform/core/errors";
export class FileService {
  constructor(private repo: Repository) {}
  async upload(
    actor: Principal,
    fileId: string,
    bytes: Buffer,
    mediaType: string,
    parentId: string | null,
    id: string,
  ) {
    await this.repo.authorize(actor, fileId, true);
    const node = nodeFor(this.repo.db, actor.workspaceId),
      file = await this.repo.get(actor, fileId);
    invariant(
      file.collection === "files",
      "INVALID_FILE",
      "Expected a file record",
    );
    const version = await node.protocol.files.save(
      fileId,
      bytes,
      mediaType,
      parentId,
      id,
    );
    const record = await node.records.put(
      "files",
      {
        ...file.data,
        version_id: version.id,
        checksum: version.checksum,
        size: String(version.size),
        media_type: mediaType,
        upload_state: "available",
      },
      fileId,
    );
    await projectRecord(this.repo.db, record);
    return { versionId: version.id, record };
  }
  async download(actor: Principal, fileId: string, versionId?: string) {
    const resource = await this.repo.get(actor, fileId),
      { manifest, bytes } = await nodeFor(
        this.repo.db,
        actor.workspaceId,
      ).protocol.files.read(versionId ?? String(resource.data.version_id));
    invariant(
      manifest.fileId === fileId,
      "PERMISSION_DENIED",
      "File version belongs to another resource",
    );
    return new Blob([new Uint8Array(bytes)], { type: manifest.mediaType });
  }
}
