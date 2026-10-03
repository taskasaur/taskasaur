import { SharedInput } from "../ui/html-controls";
import { useEffect, useRef, useState, type RefObject } from "react";
import ExcelJS from "exceljs";
import { Parser } from "hot-formula-parser";
import { Button } from "../ui/primitives/button";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
export function SpreadsheetEditor({
  initial,
  onChange,
  flush,
}: {
  initial: Blob;
  onChange: (value: Blob) => void;
  flush: RefObject<() => Promise<void>>;
}) {
  const workbook = useRef<ExcelJS.Workbook | undefined>(undefined),
    changed = useRef(onChange),
    queue = useRef(Promise.resolve());
  changed.current = onChange;
  flush.current = () => queue.current;
  const [sheetId, setSheet] = useState(0),
    [revision, setRevision] = useState(0),
    [rows, setRows] = useState(30),
    [cols, setCols] = useState(12),
    [address, setAddress] = useState("A1"),
    [formula, setFormula] = useState(""),
    [error, setError] = useState("");
  const sheet = workbook.current?.getWorksheet(sheetId);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(await initial.arrayBuffer());
      if (!book.worksheets.length) book.addWorksheet("Sheet 1");
      if (disposed) return;
      workbook.current = book;
      setSheet(book.worksheets[0].id);
      setRows(Math.min(500, Math.max(30, book.worksheets[0].rowCount)));
      setCols(Math.min(50, Math.max(12, book.worksheets[0].columnCount)));
    })().catch((e) => setError(String(e)));
    return () => {
      disposed = true;
    };
  }, []);
  function persist() {
    setRevision((r) => r + 1);
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        const bytes = await workbook.current!.xlsx.writeBuffer();
        changed.current(
          new Blob([new Uint8Array(bytes)], { type: initial.type }),
        );
      })
      .catch((e) => setError(String(e)));
  }
  function raw(cell: ExcelJS.Cell) {
    return cell.type === ExcelJS.ValueType.Formula
      ? "=" + cell.formula
      : cell.text;
  }
  function write(value: string) {
    if (!sheet) return;
    const cell = sheet.getCell(address);
    cell.value = value.startsWith("=")
      ? { formula: value.slice(1), result: undefined }
      : value.trim() !== "" && Number.isFinite(Number(value))
        ? Number(value)
        : value;
    setFormula(value);
    persist();
  }
  const cache = new Map<string, string | number | boolean>(),
    visiting = new Set<string>();
  function result(cell: ExcelJS.Cell): string | number | boolean {
    const key = cell.worksheet.id + ":" + cell.address;
    if (cache.has(key)) return cache.get(key)!;
    if (visiting.has(key)) return "#CIRC!";
    if (cell.type !== ExcelJS.ValueType.Formula)
      return typeof cell.value === "number" || typeof cell.value === "boolean"
        ? cell.value
        : cell.text;
    if (visiting.size > 100) return "#LIMIT!";
    visiting.add(key);
    const parser = new Parser();
    parser.on("callCellValue", (ref: any, done: (value: unknown) => void) =>
      done(
        result(cell.worksheet.getCell(ref.row.index + 1, ref.column.index + 1)),
      ),
    );
    parser.on(
      "callRangeValue",
      (start: any, end: any, done: (value: unknown) => void) => {
        const count =
          (end.row.index - start.row.index + 1) *
          (end.column.index - start.column.index + 1);
        if (count > 10000) {
          done("#LIMIT!");
          return;
        }
        const values: unknown[][] = [];
        for (let r = start.row.index; r <= end.row.index; r++) {
          const line: unknown[] = [];
          for (let c = start.column.index; c <= end.column.index; c++)
            line.push(result(cell.worksheet.getCell(r + 1, c + 1)));
          values.push(line);
        }
        done(values);
      },
    );
    const parsed = parser.parse(cell.formula ?? ""),
      value = parsed.error ?? parsed.result ?? "";
    visiting.delete(key);
    cache.set(key, value);
    return value;
  }
  if (!sheet) return <p role="status">{error || "Opening spreadsheet…"}</p>;
  return (
    <div className="space-y-3" data-revision={revision}>
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2 flex-wrap">
        {workbook.current!.worksheets.map((s) => (
          <Button
            key={s.id}
            variant={s.id === sheetId ? "default" : "outline"}
            onClick={() => {
              setSheet(s.id);
              setAddress("A1");
              setFormula(raw(s.getCell("A1")));
            }}
          >
            {s.name}
          </Button>
        ))}
        <Button
          variant="outline"
          onClick={() => {
            const book = workbook.current!;
            let n = book.worksheets.length + 1;
            while (book.getWorksheet("Sheet " + n)) n++;
            const added = book.addWorksheet("Sheet " + n);
            setSheet(added.id);
            persist();
          }}
        >
          Add sheet
        </Button>
        <Button
          variant="outline"
          disabled={workbook.current!.worksheets.length === 1}
          onClick={() => {
            const book = workbook.current!;
            book.removeWorksheet(sheetId);
            setSheet(book.worksheets[0].id);
            persist();
          }}
        >
          Delete sheet
        </Button>
        <label>
          Sheet name{" "}
          <SharedInput
            aria-label="Sheet name"
            className="core-input w-40"
            value={sheet.name}
            onChange={(e) => {
              try {
                sheet.name = e.target.value;
                persist();
              } catch (e) {
                setError(String(e));
              }
            }}
          />
        </label>
      </div>
      <form
        className="flex gap-2 items-center"
        onSubmit={(e) => {
          e.preventDefault();
          write(formula);
        }}
      >
        <label className="text-sm font-mono w-12">{address}</label>
        <SharedInput
          aria-label="Cell value or formula"
          className="core-input flex-1"
          value={formula}
          onChange={(e) => setFormula(e.target.value)}
        />
        <Button type="submit">Apply</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const cell = sheet.getCell(address);
            cell.font = { ...cell.font, bold: !cell.font?.bold };
            persist();
          }}
        >
          Bold
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Select a cell and enter text, a number, or a formula such as
        =SUM(A1:A5). Formulas calculate locally. XLSX formatting and additional
        sheets are retained.
      </p>
      <div className="overflow-auto max-h-[60dvh] border rounded">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-background">#</TableHead>
              {Array.from({ length: cols }, (_, c) => (
                <TableHead key={c}>
                  {sheet.getCell(1, c + 1).address.replace(/\d/g, "")}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: rows }, (_, r) => (
              <TableRow key={r}>
                <TableCell className="sticky left-0 bg-background">
                  {r + 1}
                </TableCell>
                {Array.from({ length: cols }, (_, c) => {
                  const cell = sheet.getCell(r + 1, c + 1);
                  return (
                    <TableCell key={c} className="p-0">
                      <button
                        type="button"
                        aria-label={"Cell " + cell.address}
                        className={
                          "min-w-24 w-full h-9 px-2 text-left border-l overflow-hidden text-ellipsis " +
                          (address === cell.address
                            ? "ring-2 ring-inset ring-primary"
                            : "")
                        }
                        style={{
                          fontWeight: cell.font?.bold ? "bold" : undefined,
                          fontStyle: cell.font?.italic ? "italic" : undefined,
                        }}
                        onClick={() => {
                          setAddress(cell.address);
                          setFormula(raw(cell));
                        }}
                      >
                        {String(result(cell))}
                      </button>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={rows >= 500}
          onClick={() => setRows(Math.min(500, rows + 30))}
        >
          Show more rows
        </Button>
        <Button
          variant="outline"
          disabled={cols >= 50}
          onClick={() => setCols(Math.min(50, cols + 6))}
        >
          Show more columns
        </Button>
      </div>
    </div>
  );
}
