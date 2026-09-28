import "./csdb-browser";
import { validateDocument } from "../../node_modules/@csdb/javascript/dist/catalog.js";
import { Executor } from "../../node_modules/@csdb/javascript/dist/executor.js";
import { parseSQL } from "../../node_modules/@csdb/javascript/dist/sql/parser.js";
import { parseDocument, serializeDocument } from "../../node_modules/@csdb/javascript/dist/storage/document.js";
import { TableQuery } from "../../node_modules/@csdb/javascript/dist/table.js";
import { keyFor } from "../../node_modules/@csdb/javascript/dist/util/identifiers.js";
import type { IndexManager } from "../../node_modules/@csdb/javascript/dist/indexes.js";
import type { ParseOptions, SerializeOptions } from "../../node_modules/@csdb/javascript/dist/storage/document.d.ts";
import type { CSDBDocument, QueryPlan, Row, RowValue, SQLResult, TableSchema } from "../../node_modules/@csdb/javascript/dist/types.d.ts";

export type { CSDBDocument, Row, TableSchema };

export class CSDBDatabase {
  readonly executor: Executor;

  constructor(readonly document: CSDBDocument) {
    // The renderer holds live rows in memory; CSDB's file index manager needs Node APIs.
    const indexes: Pick<IndexManager, "readRows" | "candidateOrdinals" | "findRelationship"> = {
      readRows: (name) => document.tables.get(name)?.rows ?? [],
      candidateOrdinals: () => undefined,
      findRelationship: (table, relationship, row) => {
        const foreignKey = table.schema.foreign_keys.find((key) => key.relationship === relationship || key.name === relationship);
        if (!foreignKey) return { table: relationship };
        const values = foreignKey.columns.map((column) => row[column] ?? null);
        const related = values.some((value) => value === null)
          ? undefined
          : this.findByColumns(foreignKey.references.table, foreignKey.references.columns, values);
        return { table: foreignKey.references.table, ...(related ? { row: related } : {}) };
      }
    };
    // Executor uses only these three lookup methods, with predicates applied to scanned rows.
    this.executor = new Executor(document, indexes as IndexManager);
  }

  static parse(text: string, options: ParseOptions = {}): CSDBDatabase {
    return new CSDBDatabase(parseDocument(text, options));
  }

  table(name: string): TableQuery {
    return new TableQuery(this as never, name);
  }

  byPrimaryKey(tableName: string, values: RowValue[]): Row | undefined {
    const columns = this.document.tables.get(tableName)?.schema.primary_key?.columns;
    return columns ? this.findByColumns(tableName, columns, values) : undefined;
  }

  private findByColumns(tableName: string, columns: string[], values: RowValue[]): Row | undefined {
    return this.document.tables.get(tableName)?.rows.find((row) =>
      keyFor(columns.map((column) => row[column] ?? null)) === keyFor(values)
    );
  }

  sql(statement: string, params: RowValue[] = []): SQLResult {
    return this.execute(parseSQL(statement, params)) as SQLResult;
  }

  execute(plan: QueryPlan): Row[] | { rowsAffected: number } {
    return this.executor.execute(plan);
  }

  createTable(schema: TableSchema): { rowsAffected: number } {
    return this.execute({ kind: "create-table", schema }) as { rowsAffected: number };
  }

  getTableComment(tableName: string, key: string): unknown {
    return this.document.tables.get(tableName)?.schema.comments?.[key];
  }

  setTableComment(tableName: string, key: string, value: unknown): void {
    const table = this.document.tables.get(tableName);
    if (!table) {
      return;
    }
    const comments = { ...(table.schema.comments ?? {}) };
    if (value === undefined) {
      delete comments[key];
    } else {
      comments[key] = value;
    }
    table.schema.comments = comments;
  }

  dropTable(name: string): { rowsAffected: number } {
    return this.execute({ kind: "drop-table", table: name }) as { rowsAffected: number };
  }

  validate(): void {
    validateDocument(this.document);
  }

  toString(options?: SerializeOptions): string {
    return serializeDocument(this.document, options);
  }
}

export function serializeCSDB(db: CSDBDatabase): string {
  return db.toString();
}
