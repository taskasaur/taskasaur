import { useEffect, useRef, useState, type ComponentType } from "react";
import Quill from "quill";
import Delta, { type Op } from "quill-delta";
import "quill/dist/quill.snow.css";
import type { AppRuntime } from "./runtime";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { RecordTable } from "./record-table";
import { Button } from "../ui/primitives/button";
import { download } from "./download";
import {
  officeMedia,
  newSlide,
  exportDocument,
  exportPresentation,
  validateOffice,
  type OfficeKind,
  type OfficeDocument,
  type OfficePresentation,
  type Slide,
} from "./office-model";
import { SpreadsheetEditor } from "./spreadsheet-editor";
export function PortableOffice({
  runtime,
  legacy: Legacy,
}: {
  runtime: AppRuntime;
  legacy?: ComponentType;
}) {
  const [opened, setOpened] = useState<ResourceRecord | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [engine, setEngine] = useState(false),
    [engineAvailable, setEngineAvailable] = useState(false);
  useEffect(() => {
    if (!crossOriginIsolated) return;
    void fetch("/office-engine/cool.html", { method: "HEAD" })
      .then((r) => setEngineAvailable(r.ok))
      .catch(() => {});
  }, []);
  async function create(kind: OfficeKind, file?: File) {
    setBusy(true);
    setError("");
    try {
      if (file && file.size > 20 * 1024 * 1024)
        throw Error("Import files up to 20 MB.");
      if (file) {
        const original = await runtime
          .collection("files")
          .put({
            name: file.name,
            media_type: file.type || "application/octet-stream",
            size: String(file.size),
          });
        await runtime.db.saveFile(runtime.principal, original.id, file, null);
      }
      let blob: Blob,
        name = file?.name ?? `Untitled ${kind}`;
      if (kind === "spreadsheet") {
        const { default: ExcelJS } = await import("exceljs");
        const workbook = new ExcelJS.Workbook();
        if (file && /\.xlsx$/i.test(file.name))
          await workbook.xlsx.load(await file.arrayBuffer());
        else {
          const sheet = workbook.addWorksheet("Sheet 1");
          if (file) {
            const rows = parseCSV(await file.text());
            for (const row of rows) sheet.addRow(row);
          }
        }
        blob = new Blob([new Uint8Array(await workbook.xlsx.writeBuffer())], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      } else if (file && /\.taskasaur-office\.json$/i.test(file.name)) {
        const value = validateOffice(JSON.parse(await file.text()));
        blob = new Blob([JSON.stringify(value)], { type: officeMedia });
        kind = value.kind;
      } else if (kind === "document") {
        let ops: Op[] = [{ insert: "\n" }];
        if (file && /\.docx$/i.test(file.name)) {
          const mammoth = await import("mammoth");
          const { value } = await mammoth.convertToHtml({
            arrayBuffer: await file.arrayBuffer(),
          });
          const holder = document.createElement("div"),
            editor = new Quill(holder);
          ops = editor.clipboard.convert({ html: value }).ops;
          ops.push({ insert: "\n" });
        } else if (file) ops = [{ insert: (await file.text()) + "\n" }];
        blob = new Blob(
          [JSON.stringify({ format: "taskasaur-office-v1", kind, ops })],
          { type: officeMedia },
        );
      } else
        blob = new Blob(
          [
            JSON.stringify({
              format: "taskasaur-office-v1",
              kind,
              slides: [newSlide()],
            }),
          ],
          { type: officeMedia },
        );
      const resource = await runtime
        .collection("files")
        .put({ name, media_type: blob.type, size: String(blob.size) });
      await runtime.db.saveFile(runtime.principal, resource.id, blob, null);
      const record = await runtime
        .collection("office")
        .put({ name, kind, file_id: resource.id });
      setOpened(record);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  if (engine && Legacy)
    return (
      <div className="space-y-3">
        <Button variant="outline" onClick={() => setEngine(false)}>
          Back to portable editors
        </Button>
        <Legacy />
      </div>
    );
  return opened ? (
    <OfficeSession
      key={opened.id}
      runtime={runtime}
      record={opened}
      close={() => setOpened(null)}
    />
  ) : (
    <div className="space-y-5">
      <p className="page-description">
        Documents, spreadsheets, and presentations saved on this device and
        synchronized with your workspace. Editing works offline.
      </p>
      <div className="flex gap-2 flex-wrap">
        {engineAvailable && Legacy && (
          <Button variant="outline" onClick={() => setEngine(true)}>
            Open LibreOffice engine
          </Button>
        )}
        {(["document", "spreadsheet", "presentation"] as const).map((kind) => (
          <Button
            key={kind}
            disabled={busy}
            variant="outline"
            onClick={() => void create(kind)}
          >
            {kind[0].toUpperCase() + kind.slice(1)}
          </Button>
        ))}
        <label className="upload-button">
          Import
          <input
            hidden
            type="file"
            accept=".docx,.txt,.xlsx,.csv,.taskasaur-office.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void create(
                  /\.(xlsx|csv)$/i.test(file.name) ? "spreadsheet" : "document",
                  file,
                );
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Import DOCX, text, XLSX, CSV, or a Taskasaur document. Export DOCX,
        XLSX, and PPTX. Complex imported document layouts may differ; original
        files remain available in Files.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <RecordTable
        runtime={runtime}
        collection="office"
        hideCreate
        onOpen={setOpened}
      />
    </div>
  );
}
function OfficeSession({
  runtime,
  record,
  close,
}: {
  runtime: AppRuntime;
  record: ResourceRecord;
  close: () => void;
}) {
  const [value, setValue] = useState<
      OfficeDocument | OfficePresentation | Blob
    >(),
    [status, setStatus] = useState("Opening…"),
    [error, setError] = useState(""),
    [name, setName] = useState(String(record.data.name));
  const version = useRef<string | null>(null),
    latest = useRef<Blob | undefined>(undefined),
    queue = useRef(Promise.resolve()),
    revision = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    flush = useRef<() => Promise<void>>(async () => {}),
    mounted = useRef(true);
  const serialize = (value: OfficeDocument | OfficePresentation | Blob) =>
    value instanceof Blob
      ? value
      : new Blob([JSON.stringify(value)], { type: officeMedia });
  async function save() {
    await flush.current();
    clearTimeout(timer.current);
    const blob = latest.current;
    if (!blob) return;
    const change = revision.current;
    setStatus("Saving…");
    const task = queue.current
      .catch(() => {})
      .then(async () => {
        version.current = await runtime.db.saveFile(
          runtime.principal,
          String(record.data.file_id),
          blob,
          version.current,
        );
        if (mounted.current && change === revision.current)
          setStatus("Saved on this device");
      });
    queue.current = task;
    try {
      await task;
    } catch (e) {
      if (mounted.current) {
        setStatus("Save failed");
        setError(String(e));
      }
      throw e;
    }
  }
  function update(next: OfficeDocument | OfficePresentation | Blob) {
    setValue(next);
    latest.current = serialize(next);
    revision.current++;
    setStatus("Unsaved changes");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save().catch(() => {}), 600);
  }
  useEffect(() => {
    mounted.current = true;
    void runtime
      .fileBytes(String(record.data.file_id))
      .then(async (file) => {
        version.current = file.id;
        latest.current = file.blob;
        setValue(
          record.data.kind === "spreadsheet"
            ? file.blob
            : validateOffice(JSON.parse(await file.blob.text())),
        );
        setStatus("Saved on this device");
      })
      .catch((e) => setError(String(e)));
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      if (latest.current) void save().catch(() => {});
    };
  }, [record.id]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (status !== "Saved on this device") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [status]);
  async function exportOffice() {
    if (!value) return;
    try {
      await save();
      const blob =
        value instanceof Blob
          ? value
          : value.kind === "document"
            ? await exportDocument(value.ops)
            : await exportPresentation(value.slides);
      download(
        name.replace(/\.(xlsx|docx|pptx|taskasaur-office\.json)$/i, "") +
          (value instanceof Blob
            ? ".xlsx"
            : value.kind === "document"
              ? ".docx"
              : ".pptx"),
        blob,
      );
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="ghost"
          onClick={() =>
            void save()
              .then(close)
              .catch(() => {})
          }
        >
          Office
        </Button>
        <input
          aria-label="Document name"
          className="core-input flex-1 min-w-40"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            void runtime
              .collection("office")
              .put({ ...record.data, name }, record.id)
              .catch((e) => setError(String(e)))
          }
        />
        <span role="status" className="text-xs">
          {status}
        </span>
        <Button onClick={() => void save().catch(() => {})}>Save</Button>
        <Button variant="outline" onClick={() => void exportOffice()}>
          Export
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            if (latest.current)
              download(
                name +
                  (value instanceof Blob ? ".xlsx" : ".taskasaur-office.json"),
                latest.current,
              );
          }}
        >
          Download editable copy
        </Button>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {value instanceof Blob ? (
        <SpreadsheetEditor initial={value} onChange={update} flush={flush} />
      ) : value?.kind === "document" ? (
        <DocumentEditor
          initial={value.ops}
          onChange={(ops) => update({ ...value, ops })}
        />
      ) : value?.kind === "presentation" ? (
        <SlidesEditor value={value} onChange={update} />
      ) : null}
    </div>
  );
}
function DocumentEditor({
  initial,
  onChange,
}: {
  initial: Op[];
  onChange: (ops: Op[]) => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    const container = document.createElement("div");
    element.current!.append(container);
    const editor = new Quill(container, {
      theme: "snow",
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ["bold", "italic", "underline", "strike"],
          [{ list: "ordered" }, { list: "bullet" }],
          [{ align: [] }],
          ["link", "blockquote", "clean"],
        ],
      },
    });
    editor.setContents(new Delta(initial));
    editor.on("text-change", () => changed.current(editor.getContents().ops));
    return () => {
      editor.off("text-change");
      element.current?.replaceChildren();
    };
  }, []);
  return (
    <div
      ref={element}
      className="bg-white text-slate-900 [&_.ql-editor]:min-h-[55dvh] [&_.ql-editor]:text-base"
    />
  );
}
function SlidesEditor({
  value,
  onChange,
}: {
  value: OfficePresentation;
  onChange: (value: OfficePresentation) => void;
}) {
  const [index, setIndex] = useState(0),
    [present, setPresent] = useState(false);
  const slide = value.slides[index] ?? value.slides[0];
  function patch(fields: Partial<Slide>) {
    onChange({
      ...value,
      slides: value.slides.map((s) =>
        s.id === slide.id ? { ...s, ...fields } : s,
      ),
    });
  }
  useEffect(() => {
    if (!present) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPresent(false);
      if (event.key === "ArrowRight")
        setIndex((i) => Math.min(value.slides.length - 1, i + 1));
      if (event.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [present, value.slides.length]);
  if (!slide) return <p role="alert">This presentation has no slides.</p>;
  return (
    <div
      className={
        present
          ? "fixed inset-0 z-50 bg-black flex flex-col items-center justify-center p-4"
          : "space-y-3"
      }
    >
      {!present && (
        <div className="flex gap-2 flex-wrap">
          {value.slides.map((s, i) => (
            <Button
              key={s.id}
              variant={i === index ? "default" : "outline"}
              onClick={() => setIndex(i)}
            >
              Slide {i + 1}
            </Button>
          ))}
          <Button
            variant="outline"
            onClick={() => {
              onChange({ ...value, slides: [...value.slides, newSlide()] });
              setIndex(value.slides.length);
            }}
          >
            Add slide
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              onChange({
                ...value,
                slides: [
                  ...value.slides,
                  { ...slide, id: crypto.randomUUID() },
                ],
              });
              setIndex(value.slides.length);
            }}
          >
            Duplicate
          </Button>
          <Button
            variant="outline"
            disabled={index === 0}
            onClick={() => {
              const slides = [...value.slides];
              [slides[index - 1], slides[index]] = [
                slides[index],
                slides[index - 1],
              ];
              onChange({ ...value, slides });
              setIndex(index - 1);
            }}
          >
            Move left
          </Button>
          <Button
            variant="outline"
            disabled={value.slides.length === 1}
            onClick={() => {
              onChange({
                ...value,
                slides: value.slides.filter((s) => s.id !== slide.id),
              });
              setIndex(Math.max(0, index - 1));
            }}
          >
            Delete slide
          </Button>
          <Button onClick={() => setPresent(true)}>Present</Button>
        </div>
      )}
      <div
        className="aspect-video w-full max-h-[80dvh] p-[5%] rounded border overflow-auto"
        style={{ background: slide.background, color: slide.color }}
      >
        {present ? (
          <>
            <h2 className="text-3xl md:text-5xl mb-6 font-bold">
              {slide.title}
            </h2>
            <div className="flex gap-6">
              <p className="whitespace-pre-wrap text-xl md:text-3xl flex-1">
                {slide.body}
              </p>
              {slide.image && (
                <img
                  alt="Slide image"
                  src={slide.image}
                  className="max-w-[40%] object-contain"
                />
              )}
            </div>
          </>
        ) : (
          <>
            <input
              aria-label="Slide title"
              className="w-full text-3xl font-bold bg-transparent border-b mb-6"
              value={slide.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
            <div className="flex gap-4">
              <textarea
                aria-label="Slide body"
                className="flex-1 w-full min-h-44 text-xl bg-transparent resize-y"
                value={slide.body}
                onChange={(e) => patch({ body: e.target.value })}
              />
              {slide.image && (
                <img
                  alt="Slide image"
                  className="max-w-[40%] object-contain"
                  src={slide.image}
                />
              )}
            </div>
          </>
        )}
      </div>
      {present ? (
        <div className="flex gap-3 mt-3">
          <Button onClick={() => setIndex(Math.max(0, index - 1))}>
            Previous
          </Button>
          <Button onClick={() => setPresent(false)}>Exit presentation</Button>
          <Button
            onClick={() =>
              setIndex(Math.min(value.slides.length - 1, index + 1))
            }
          >
            Next
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-4">
            <label>
              Background{" "}
              <input
                aria-label="Slide background"
                type="color"
                value={slide.background}
                onChange={(e) => patch({ background: e.target.value })}
              />
            </label>
            <label>
              Text{" "}
              <input
                aria-label="Slide text color"
                type="color"
                value={slide.color}
                onChange={(e) => patch({ color: e.target.value })}
              />
            </label>
            <label className="upload-button">
              Add image
              <input
                hidden
                type="file"
                accept="image/png,image/jpeg"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file || file.size > 5 * 1024 * 1024) return;
                  const reader = new FileReader();
                  reader.onload = () => patch({ image: String(reader.result) });
                  reader.readAsDataURL(file);
                }}
              />
            </label>
            {slide.image && (
              <Button
                variant="ghost"
                onClick={() => patch({ image: undefined })}
              >
                Remove image
              </Button>
            )}
          </div>
          <label className="field-row">
            Speaker notes
            <textarea
              aria-label="Speaker notes"
              className="core-input"
              value={slide.notes}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </label>
        </div>
      )}
    </div>
  );
}
function parseCSV(text: string) {
  const rows: string[][] = [[]];
  let value = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n")) {
      rows.at(-1)!.push(value.replace(/\r$/, ""));
      value = "";
      if (c === "\n") rows.push([]);
    } else value += c;
  }
  rows.at(-1)!.push(value);
  return rows;
}
