import { Fragment, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Folder,
} from "lucide-react";
import type {
  Field,
  RecordSchema,
  Value,
} from "@taskasaur/platform/field-types";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "./primitives/table";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./primitives/breadcrumb";
import { Button } from "./primitives/button";
import { Card, CardContent, CardFooter } from "./primitives/card";
import { displayValue } from "./fields";
import { cn } from "./utils";
import {
  activeGroups,
  groupRecords,
  resolveGroupPath,
  type CollectionViewState,
  type GroupNode,
  type GroupSegment,
} from "./collection-view-model";

export interface CellContext {
  row: ResourceRecord;
  field: Field;
  value: Value | undefined;
  defaultContent: ReactNode;
  writable: boolean;
  update: (patch: Record<string, Value>) => Promise<void>;
}
export interface ColumnOptions {
  header?: ReactNode;
  className?: string;
  width?: number | string;
}
export interface CollectionViewProps {
  schema: RecordSchema;
  rows: ResourceRecord[];
  state: CollectionViewState;
  onChange: (patch: Partial<CollectionViewState>) => void;
  onOpen?: (row: ResourceRecord) => void;
  renderActions?: (row: ResourceRecord) => ReactNode;
  renderCell?: (context: CellContext) => ReactNode;
  renderCard?: (row: ResourceRecord, defaultContent: ReactNode) => ReactNode;
  columnOptions?: Record<string, ColumnOptions>;
  writable?: (row: ResourceRecord) => boolean;
  onUpdate?: (
    row: ResourceRecord,
    patch: Record<string, Value>,
  ) => Promise<void>;
}
/** Pure shared presentation. Storage/permissions/editing stay in the host adapter. */
export function CollectionView({
  schema,
  rows,
  state,
  onChange,
  onOpen,
  renderActions,
  renderCell,
  renderCard,
  columnOptions,
  writable,
  onUpdate,
}: CollectionViewProps) {
  const groupFields = activeGroups(state.groups, schema.fields);
  const tree = groupRecords(rows, groupFields);
  const { ancestors, children } = resolveGroupPath(tree, state.path);
  const current = ancestors.at(-1);
  const entries = current?.rows ?? rows;
  const fields = state.columns.flatMap(
    (id) => schema.fields.find((f) => f.id === id) ?? [],
  );
  const collapsed = new Set(state.collapsed);
  const folder = state.mode.endsWith("-folder"),
    board = state.mode.startsWith("board"),
    short = state.mode.startsWith("short");
  const go = (path: GroupSegment[]) =>
    onChange({
      path,
      collapsed: state.collapsed.filter(
        (id) =>
          !path.some((_, i) => id === JSON.stringify(path.slice(0, i + 1))),
      ),
    });
  const toggle = (id: string) =>
    onChange({
      collapsed: collapsed.has(id)
        ? state.collapsed.filter((key) => key !== id)
        : [...state.collapsed, id],
    });
  const title = (node: GroupNode) =>
    node.value == null ? "Not set" : displayValue(node.value, node.field);
  const groupLabel = (node: GroupNode) => node.field.label + ": " + title(node);
  const heading = (node: GroupNode, pinned = false) => (
    <div
      className="flex items-center gap-2"
      style={{
        paddingInlineStart:
          (pinned
            ? ancestors.indexOf(node)
            : node.path.length - ancestors.length - 1) * 16,
      }}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={
          (collapsed.has(node.id) ? "Expand " : "Collapse ") + groupLabel(node)
        }
        aria-expanded={!collapsed.has(node.id)}
        onClick={() => toggle(node.id)}
      >
        {collapsed.has(node.id) ? <ChevronRight /> : <ChevronDown />}
      </Button>
      <span className="text-muted-foreground">{node.field.label}</span>
      <span
        className={cn(
          "min-w-0 font-medium",
          short || board || folder
            ? "whitespace-normal [overflow-wrap:anywhere]"
            : "whitespace-nowrap",
        )}
      >
        {title(node)}
      </span>
      <span className="text-xs text-muted-foreground">{node.rows.length}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={"Open group " + groupLabel(node)}
        onClick={() => go(node.path)}
      >
        <ArrowRight />
      </Button>
    </div>
  );
  const cell = (row: ResourceRecord, field: Field) => {
    const value = row.data[field.id],
      text = displayValue(value, field);
    const content =
      ["title", "name", "summary", "subject"].includes(field.id) && onOpen ? (
        <button
          type="button"
          className="text-left font-medium hover:underline [overflow-wrap:anywhere]"
          onClick={() => onOpen(row)}
        >
          {value == null || value === "" ? "Untitled" : text}
        </button>
      ) : (
        text
      );
    return renderCell
      ? renderCell({
          row,
          field,
          value,
          defaultContent: content,
          writable: writable?.(row) ?? false,
          update: (patch) =>
            onUpdate
              ? onUpdate(row, patch)
              : Promise.reject(Error("This view is read-only")),
        })
      : content;
  };
  const recordRow = (row: ResourceRecord) => (
    <TableRow
      key={row.id}
      data-record-id={row.id}
      onDoubleClick={() => onOpen?.(row)}
    >
      {fields.map((field) => (
        <TableCell
          key={field.id}
          data-field={field.id}
          style={{ width: columnOptions?.[field.id]?.width }}
          className={cn(
            short
              ? "whitespace-normal align-top [overflow-wrap:anywhere]"
              : "whitespace-nowrap",
            columnOptions?.[field.id]?.className,
          )}
        >
          {cell(row, field)}
        </TableCell>
      ))}
      <TableCell className="w-24 align-top">
        <div className="flex justify-end gap-1">{renderActions?.(row)}</div>
      </TableCell>
    </TableRow>
  );
  const groupRows = (nodes: GroupNode[]): ReactNode =>
    nodes.map((node) => (
      <Fragment key={node.id}>
        <TableRow data-group-heading={node.field.id} className="bg-muted/50">
          <TableCell colSpan={fields.length + 1}>{heading(node)}</TableCell>
        </TableRow>
        {!collapsed.has(node.id) &&
          (node.children.length
            ? groupRows(node.children)
            : node.rows.map(recordRow))}
      </Fragment>
    ));
  const renderTable = () => (
    <div
      className="rounded-lg border overflow-hidden"
      data-collection-display={short ? "short-table" : "long-table"}
    >
      <Table className={short ? "w-full table-fixed" : "w-max min-w-full"}>
        <TableHeader>
          <TableRow>
            {fields.map((field) => {
              const sort = state.query.sorts?.find(
                (s) => s.enabled && s.field === field.id,
              );
              return (
                <TableHead
                  key={field.id}
                  style={{ width: columnOptions?.[field.id]?.width }}
                  className={short ? "whitespace-normal" : "whitespace-nowrap"}
                  aria-sort={
                    sort
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className="flex items-center gap-1 text-left"
                    onClick={() =>
                      onChange({
                        query: {
                          ...state.query,
                          sorts: [
                            {
                              field: field.id,
                              direction:
                                sort?.direction === "asc" ? "desc" : "asc",
                              enabled: true,
                            },
                            ...(state.query.sorts ?? []).filter(
                              (s) => s.field !== field.id,
                            ),
                          ],
                        },
                      })
                    }
                  >
                    {columnOptions?.[field.id]?.header ?? field.label}
                    {sort &&
                      (sort.direction === "asc" ? (
                        <ArrowUp size={12} />
                      ) : (
                        <ArrowDown size={12} />
                      ))}
                  </button>
                </TableHead>
              );
            })}
            <TableHead className="w-24 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ancestors.map((node) => (
            <TableRow key={node.id} data-pinned-group className="bg-muted/50">
              <TableCell colSpan={fields.length + 1}>
                {heading(node, true)}
              </TableCell>
            </TableRow>
          ))}
          {!ancestors.some((node) => collapsed.has(node.id)) &&
            (children.length ? groupRows(children) : entries.map(recordRow))}
        </TableBody>
      </Table>
    </div>
  );
  const cards = (items: ResourceRecord[]) => (
    <div className="w-72 shrink-0 space-y-3 p-3">
      {items.map((row) => {
        const content = (
          <>
            <CardContent className="space-y-2">
              {fields.map((field) => (
                <div
                  key={field.id}
                  className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"
                >
                  {!["title", "name", "summary", "subject"].includes(
                    field.id,
                  ) && (
                    <div className="text-xs text-muted-foreground">
                      {field.label}
                    </div>
                  )}
                  {cell(row, field)}
                </div>
              ))}
            </CardContent>
            <CardFooter className="justify-end gap-1">
              {renderActions?.(row)}
            </CardFooter>
          </>
        );
        return (
          <Card
            key={row.id}
            data-record-id={row.id}
            onDoubleClick={() => onOpen?.(row)}
          >
            {renderCard ? renderCard(row, content) : content}
          </Card>
        );
      })}
    </div>
  );
  const boardGroups = (nodes: GroupNode[]): ReactNode =>
    nodes.map((node) => (
      <section
        key={node.id}
        data-board-group={node.field.id}
        className="min-w-72 shrink-0 border-r last:border-r-0"
      >
        <div className="border-b bg-muted/50 py-2">
          <div className="sticky left-0 w-fit max-w-[calc(100vw-3rem)] px-2">
            {heading(node)}
          </div>
        </div>
        {!collapsed.has(node.id) &&
          (node.children.length ? (
            <div className="flex items-start">{boardGroups(node.children)}</div>
          ) : (
            cards(node.rows)
          ))}
      </section>
    ));
  const renderBoard = () => (
    <div
      className="overflow-x-auto rounded-lg border"
      data-collection-display="board"
    >
      <div className="min-w-full w-max">
        {ancestors.map((node) => (
          <div
            key={node.id}
            data-pinned-group
            className="border-b bg-muted/50 py-2"
          >
            <div className="sticky left-0 w-fit px-2">
              {heading(node, true)}
            </div>
          </div>
        ))}
        {!ancestors.some((node) => collapsed.has(node.id)) &&
          (children.length ? (
            <div className="flex items-start">{boardGroups(children)}</div>
          ) : (
            cards(entries)
          ))}
      </div>
    </div>
  );
  return (
    <div className="min-w-0 space-y-3" data-collection-view={state.mode}>
      <Breadcrumb aria-label={schema.name + " groups"}>
        <BreadcrumbList>
          <BreadcrumbItem>
            {ancestors.length ? (
              <BreadcrumbLink
                render={<button type="button" onClick={() => go([])} />}
              >
                {schema.name}
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage>{schema.name}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {ancestors.map((node, index) => (
            <Fragment key={node.id}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {index === ancestors.length - 1 ? (
                  <BreadcrumbPage>{groupLabel(node)}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    render={
                      <button type="button" onClick={() => go(node.path)} />
                    }
                  >
                    {groupLabel(node)}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {folder && children.length ? (
        <div data-collection-display="folders" className="space-y-3">
          {ancestors.map((node) => (
            <div
              key={node.id}
              data-pinned-group
              className="rounded-lg border bg-muted/50 p-2"
            >
              {heading(node, true)}
            </div>
          ))}
          {!ancestors.some((node) => collapsed.has(node.id)) && (
            <>
              <p className="text-sm text-muted-foreground">
                {children[0].field.label}
              </p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
                {children.map((node) => (
                  <Button
                    key={node.id}
                    variant="outline"
                    className="h-auto min-h-32 flex-col whitespace-normal p-4 text-center"
                    aria-label={"Open folder " + groupLabel(node)}
                    onClick={() => go(node.path)}
                  >
                    <Folder className="size-10" />
                    <span className="[overflow-wrap:anywhere]">
                      {title(node)}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {node.rows.length} entries
                    </span>
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : board ? (
        renderBoard()
      ) : (
        renderTable()
      )}
      {!entries.length && (
        <p className="text-sm text-muted-foreground">No matching entries.</p>
      )}
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {entries.length} {entries.length === 1 ? "entry" : "entries"}
        {ancestors.length ? " in this group" : ""}
      </p>
    </div>
  );
}
