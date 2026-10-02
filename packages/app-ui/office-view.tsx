"use client";
import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Sheet,
  Presentation,
  Save,
  ArrowLeft,
  Upload,
  Download,
} from "lucide-react";
import type { AppRuntime } from "./runtime";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { RecordTable } from "./record-table";
import { download } from "./productivity";
import { Button } from "../ui/primitives/button";
export default function OfficeView({ runtime }: { runtime: AppRuntime }) {
  const [document, setDocument] = useState<ResourceRecord | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function create(
    kind: "document" | "spreadsheet" | "presentation",
    file?: File,
  ) {
    setBusy(true);
    setError("");
    try {
      const templates = {
          document: "TextDocument.odt",
          spreadsheet: "Spreadsheet.ods",
          presentation: "Presentation.odp",
        },
        types = {
          document: "application/vnd.oasis.opendocument.text",
          spreadsheet: "application/vnd.oasis.opendocument.spreadsheet",
          presentation: "application/vnd.oasis.opendocument.presentation",
        };
      let bytes: Blob = file!;
      if (!file) {
        const response = await fetch(
          `/office-engine/templates/${templates[kind]}`,
        );
        if (!response.ok)
          throw new Error(
            "Office engine assets are not installed. Run npm run office:prepare on the host.",
          );
        bytes = new Blob([await response.arrayBuffer()], { type: types[kind] });
      }
      const name =
        file?.name ?? `Untitled ${kind}.${templates[kind].split(".").at(-1)}`;
      const resource = await runtime.collection("files").put({
        name,
        media_type: bytes.type || types[kind],
        size: String(bytes.size),
      });
      await runtime.db.saveFile(runtime.principal, resource.id, bytes, null);
      const office = await runtime
        .collection("office")
        .put({ name, kind, file_id: resource.id });
      setDocument(office);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return document ? (
    <OfficeSession
      runtime={runtime}
      document={document}
      onClose={() => setDocument(null)}
    />
  ) : (
    <div className="space-y-5">
      <p className="page-description">
        Documents, spreadsheets, and presentations, edited locally with the
        Collabora/LibreOffice engine. Save and reopen your files without a
        server connection.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => void create("document")}
        >
          <FileText size={16} />
          Document
        </Button>
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => void create("spreadsheet")}
        >
          <Sheet size={16} />
          Spreadsheet
        </Button>
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => void create("presentation")}
        >
          <Presentation size={16} />
          Presentation
        </Button>
        <label className="upload-button">
          <Upload size={14} />
          Import
          <input
            hidden
            type="file"
            accept=".odt,.docx,.ods,.xlsx,.csv,.odp,.pptx"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void create(
                  /\.(ods|xlsx|csv)$/i.test(file.name)
                    ? "spreadsheet"
                    : /\.(odp|pptx)$/i.test(file.name)
                      ? "presentation"
                      : "document",
                  file,
                );
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <RecordTable
        runtime={runtime}
        collection="office"
        hideCreate
        onOpen={setDocument}
      />
    </div>
  );
}
function OfficeSession({
  runtime,
  document: record,
  onClose,
}: {
  runtime: AppRuntime;
  document: ResourceRecord;
  onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null),
    session = useRef(crypto.randomUUID()),
    version = useRef<string | null>(null),
    bytes = useRef<ArrayBuffer | null>(null);
  const [source, setSource] = useState(""),
    [error, setError] = useState(""),
    [state, setState] = useState("Opening document…"),
    [dirty, setDirty] = useState(false);
  const pending = useRef(
    new Map<
      string,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const file = await runtime.db.records.get(String(record.data.file_id));
        if (!file) throw new Error("File metadata is missing");
        const stored = await runtime.fileBytes(file.id);
        if (!stored)
          throw new Error("Download this document before opening it offline");
        version.current = stored.id;
        bytes.current = await stored.blob.arrayBuffer();
        const extension = String(file.data.name)
          .split(".")
          .at(-1)!
          .replace(/[^a-z0-9]/gi, "");
        if (!disposed)
          setSource(
            `/office-engine/cool.html?file_path=${encodeURIComponent("file:///taskasaur/document." + extension)}&taskasaurSession=${session.current}&lang=en-US`,
          );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      disposed = true;
      for (const item of pending.current.values()) {
        clearTimeout(item.timeout);
        item.reject(new Error("Editor closed"));
      }
      pending.current.clear();
    };
  }, [runtime, record]);
  useEffect(() => {
    const listener = async (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== location.origin ||
        event.data?.session !== session.current
      )
        return;
      const message = event.data;
      if (message.type === "taskasaur.office.load" && bytes.current) {
        const copy = bytes.current.slice(0);
        frame.current.contentWindow!.postMessage(
          {
            type: "taskasaur.office.bytes",
            session: session.current,
            bytes: copy,
          },
          location.origin,
          [copy],
        );
      }
      if (message.type === "taskasaur.office.opened") setState("Ready");
      if (message.type === "taskasaur.office.dirty") {
        setDirty(true);
        setState("Unsaved changes");
      }
      if (message.type === "taskasaur.office.error") {
        setError(String(message.message));
        setState("Save unavailable");
      }
      if (message.type === "taskasaur.office.saved") {
        const waiter = pending.current.get(message.requestId);
        if (!waiter) return;
        try {
          const file = await runtime.db.records.get(
            String(record.data.file_id),
          );
          const blob = new Blob([message.bytes], {
            type: String(file?.data.media_type),
          });
          version.current = await runtime.db.saveFile(
            runtime.principal,
            String(record.data.file_id),
            blob,
            version.current,
          );
          bytes.current = message.bytes;
          setDirty(false);
          setState("Saved on this device");
          waiter.resolve();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          waiter.reject(e instanceof Error ? e : new Error(String(e)));
        } finally {
          clearTimeout(waiter.timeout);
          pending.current.delete(message.requestId);
        }
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [runtime, record]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  function save() {
    setError("");
    setState("Saving…");
    const requestId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.current.delete(requestId);
        setError(
          "The engine did not confirm this save. Keep the editor open and try again.",
        );
        setState("Unsaved changes");
        reject(new Error("Save timed out"));
      }, 30000);
      pending.current.set(requestId, { resolve, reject, timeout });
      frame.current?.contentWindow?.postMessage(
        { type: "taskasaur.office.save", session: session.current, requestId },
        location.origin,
      );
    });
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <Button
          variant="ghost"
          onClick={async () => {
            if (dirty)
              try {
                await save();
              } catch {
                return;
              }
            onClose();
          }}
        >
          <ArrowLeft size={14} />
          Office
        </Button>
        <h2 className="font-medium flex-1">{String(record.data.name)}</h2>
        <span className="text-xs text-muted-foreground">{state}</span>
        <Button onClick={() => void save().catch(() => undefined)}>
          <Save size={14} />
          Save
        </Button>
        <Button
          variant="outline"
          onClick={async () => {
            try {
              if (dirty) await save();
              if (bytes.current)
                download(String(record.data.name), new Blob([bytes.current]));
            } catch {}
          }}
        >
          <Download size={14} />
          Export
        </Button>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {source && (
        <iframe
          ref={frame}
          title="Offline office editor"
          src={source}
          className="w-full border rounded-xl bg-white h-[75dvh]"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      )}
    </div>
  );
}
