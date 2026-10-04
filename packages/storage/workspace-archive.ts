import JSZip from "jszip";
import { digest } from "../core/crypto";
import { invariant } from "@taskasaur/platform/core/errors";
import { parseWorkspaceManifest, type WorkspaceFiles } from "./workspace";
import {
  encryptWorkspace,
  decryptWorkspace,
  encryptedWorkspace,
} from "../core/workspace-encryption";

export const WORKSPACE_ARCHIVE_LIMIT = 1024 * 1024 * 1024;
const changed =
  "The workspace file changed outside this session. Close and reopen it before writing.";

/** Platform adapters supply atomic replacement and a writer lease, never private device state. */
export interface WorkspaceArchiveIO {
  read(): Promise<Uint8Array | undefined>;
  replace(bytes: Uint8Array, expectedHash: string | undefined): Promise<void>;
  lock?(packageId: string): Promise<void>;
  close?(): Promise<void>;
}
export async function assertArchiveUnchanged(
  bytes: Uint8Array | undefined,
  expectedHash: string | undefined,
) {
  invariant(
    (bytes ? await digest(bytes) : undefined) === expectedHash,
    "WORKSPACE_CHANGED",
    changed,
  );
}
export async function decodeWorkspaceArchive(
  bytes: Uint8Array,
  password?: string,
) {
  invariant(
    bytes.length <= WORKSPACE_ARCHIVE_LIMIT,
    "PAYLOAD_TOO_LARGE",
    "Workspace files are limited to 1 GB",
  );
  const zip = await JSZip.loadAsync(await decryptWorkspace(bytes, password));
  const expanded = (name: string) =>
    Number(
      (zip.files[name] as unknown as { _data?: { uncompressedSize?: number } })
        ?._data?.uncompressedSize ?? 0,
    );
  const metadata = zip.file("workspace.json");
  invariant(metadata, "INVALID_WORKSPACE", "Workspace manifest is missing");
  invariant(
    expanded("workspace.json") <= 64 * 1024 * 1024,
    "PAYLOAD_TOO_LARGE",
    "Workspace manifest is too large",
  );
  const manifestBytes = await metadata.async("uint8array");
  const manifest = parseWorkspaceManifest(manifestBytes);
  const values = new Map<string, Uint8Array>([
    ["workspace.json", manifestBytes],
  ]);
  let total = manifestBytes.length;
  for (const entry of Object.values(manifest.entries)) {
    const name = `data/${entry.hash}.bin`;
    if (values.has(name)) {
      invariant(
        values.get(name)!.length === entry.size,
        "INVALID_WORKSPACE",
        "Inconsistent workspace entry size",
      );
      continue;
    }
    const file = zip.file(name);
    total += entry.size;
    invariant(
      file && expanded(name) === entry.size && total <= WORKSPACE_ARCHIVE_LIMIT,
      "INVALID_WORKSPACE",
      "Workspace data is missing or exceeds archive limits",
    );
    const content = await file.async("uint8array");
    invariant(
      content.length === entry.size && (await digest(content)) === entry.hash,
      "INTEGRITY_FAILED",
      "Workspace content is missing or corrupt",
    );
    values.set(name, content);
  }
  return values;
}
export async function encodeWorkspaceArchive(
  values: Map<string, Uint8Array>,
  password?: string,
) {
  invariant(
    [...values.values()].reduce((size, bytes) => size + bytes.length, 0) <=
      WORKSPACE_ARCHIVE_LIMIT,
    "PAYLOAD_TOO_LARGE",
    "Workspace files are limited to 1 GB",
  );
  const zip = new JSZip();
  for (const [name, bytes] of values) zip.file(name, bytes);
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "STORE",
  });
  invariant(
    bytes.length <= WORKSPACE_ARCHIVE_LIMIT,
    "PAYLOAD_TOO_LARGE",
    "Workspace files are limited to 1 GB",
  );
  const output = password ? await encryptWorkspace(bytes, password) : bytes;
  invariant(
    output.length <= WORKSPACE_ARCHIVE_LIMIT,
    "PAYLOAD_TOO_LARGE",
    "Workspace files are limited to 1 GB",
  );
  return output;
}

/** Existing exported ZIPs become live containers, with one atomic replacement per durable commit. */
export class ArchiveWorkspaceFiles implements WorkspaceFiles {
  private values = new Map<string, Uint8Array>();
  private expectedHash?: string;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly io: WorkspaceArchiveIO,
    private password?: string,
  ) {}
  static async open(io: WorkspaceArchiveIO, create = false, password?: string) {
    const files = new ArchiveWorkspaceFiles(io, create ? password : undefined);
    try {
      const bytes = await io.read();
      files.expectedHash = bytes ? await digest(bytes) : undefined;
      if (bytes?.length) {
        invariant(
          !create,
          "WORKSPACE_EXISTS",
          "Choose a new file; use Open workspace file to edit an existing workspace",
        );
        files.values = await decodeWorkspaceArchive(bytes, password);
        if (encryptedWorkspace(bytes)) files.password = password;
        await io.lock?.(
          parseWorkspaceManifest(files.values.get("workspace.json")!).packageId,
        );
        await assertArchiveUnchanged(await io.read(), files.expectedHash);
      } else
        invariant(
          create,
          "INVALID_WORKSPACE",
          "The selected workspace file is empty or missing",
        );
      return files;
    } catch (error) {
      await io.close?.();
      throw error;
    }
  }
  private assertOpen() {
    invariant(!this.closed, "WORKSPACE_CLOSED", "The workspace file is closed");
  }
  async read(name: string) {
    this.assertOpen();
    return this.values.get(name)?.slice();
  }
  async refresh() {
    this.assertOpen();
    // A mounted writer never adopts external changes into its in-memory replica.
    await assertArchiveUnchanged(await this.io.read(), this.expectedHash);
  }
  commit(metadata: Uint8Array, additions: Record<string, Uint8Array>) {
    metadata = metadata.slice();
    additions = Object.fromEntries(
      Object.entries(additions).map(([name, bytes]) => [name, bytes.slice()]),
    );
    const next = this.queue.then(() => this.commitNow(metadata, additions));
    this.queue = next.catch(() => {});
    return next;
  }
  private async commitNow(
    metadata: Uint8Array,
    additions: Record<string, Uint8Array>,
  ) {
    this.assertOpen();
    const manifest = parseWorkspaceManifest(metadata);
    const current = this.values.get("workspace.json");
    if (current) {
      const previous = parseWorkspaceManifest(current);
      invariant(
        previous.packageId === manifest.packageId &&
          previous.workspace.id === manifest.workspace.id,
        "WORKSPACE_MISMATCH",
        "Cannot replace an open workspace with a different package",
      );
      invariant(
        manifest.revision === previous.revision + 1,
        "WORKSPACE_CHANGED",
        changed,
      );
    } else
      invariant(
        manifest.revision === 0,
        "INVALID_WORKSPACE",
        "Invalid initial workspace revision",
      );
    const next = new Map<string, Uint8Array>([
      ["workspace.json", metadata.slice()],
    ]);
    for (const entry of Object.values(manifest.entries)) {
      const name = `data/${entry.hash}.bin`;
      const bytes = additions[name] ?? this.values.get(name);
      invariant(
        bytes && bytes.length === entry.size,
        "INTEGRITY_FAILED",
        "Workspace content is missing or corrupt",
      );
      if (additions[name])
        invariant(
          (await digest(bytes)) === entry.hash,
          "INTEGRITY_FAILED",
          "Workspace content is missing or corrupt",
        );
      next.set(name, additions[name] ? bytes.slice() : bytes);
    }
    await this.io.lock?.(manifest.packageId);
    const encoded = await encodeWorkspaceArchive(next, this.password);
    const hash = await digest(encoded);
    await this.io.replace(encoded, this.expectedHash);
    this.values = next;
    this.expectedHash = hash;
  }
  async write() {
    throw Error("Single-file workspaces require an atomic package commit");
  }
  async remove(name: string) {
    this.assertOpen();
    invariant(
      /^data\/[a-f0-9]{64}\.bin$/.test(name) && !this.values.has(name),
      "INVALID_WORKSPACE",
      "Remove content through a workspace transaction",
    );
    // Unreferenced bytes were already removed by the manifest commit.
  }
  async close() {
    await this.queue;
    if (this.closed) return;
    this.closed = true;
    this.password = undefined;
    this.values.clear();
    await this.io.close?.();
  }
}
