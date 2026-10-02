"use client";
import { useState } from "react";
import {
  Plus,
  X,
  ArrowUp,
  ArrowDown,
  Filter,
  ArrowDownUp,
  Columns3,
} from "lucide-react";
import type {
  Field,
  Filter as FilterRule,
  Query,
  Sort,
  Value,
} from "../field-types";
import { FieldInput } from "./fields";
import { Button } from "./primitives/button";
import { Input } from "./primitives/input";
import { Switch } from "./primitives/switch";

// Extracted interaction model from the original task-page FilterPanel/SortPanel:
// Where/And/Or, independently enabled rules, ordered sorts, and shared typed inputs.
export function QueryControls({
  fields,
  query,
  onChange,
  columns,
  onColumns,
}: {
  fields: Field[];
  query: Query;
  onChange: (q: Query) => void;
  columns: string[];
  onColumns: (ids: string[]) => void;
}) {
  const [panel, setPanel] = useState<"filter" | "sort" | "columns" | null>(
    null,
  );
  const filters = query.filters ?? [],
    sorts = query.sorts ?? [];
  const updateFilter = (id: string, patch: Partial<FilterRule>) =>
    onChange({
      ...query,
      filters: filters.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    });
  const updateSort = (index: number, patch: Partial<Sort>) =>
    onChange({
      ...query,
      sorts: sorts.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <Input
          className="max-w-72"
          aria-label="Search records"
          placeholder="Search entries…"
          value={query.search ?? ""}
          onChange={(e) => onChange({ ...query, search: e.target.value })}
        />
        <Button
          variant="outline"
          onClick={() => setPanel(panel === "filter" ? null : "filter")}
        >
          <Filter size={14} />
          Filter{filters.length ? ` (${filters.length})` : ""}
        </Button>
        <Button
          variant="outline"
          onClick={() => setPanel(panel === "sort" ? null : "sort")}
        >
          <ArrowDownUp size={14} />
          Sort
        </Button>
        <Button
          variant="outline"
          onClick={() => setPanel(panel === "columns" ? null : "columns")}
        >
          <Columns3 size={14} />
          Columns
        </Button>
        <select
          aria-label="Group records"
          className="core-select w-auto"
          value={query.groupBy ?? ""}
          onChange={(e) =>
            onChange({ ...query, groupBy: e.target.value || undefined })
          }
        >
          <option value="">No grouping</option>
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              Group by {f.label}
            </option>
          ))}
        </select>
      </div>
      {panel === "filter" && (
        <div className="query-panel">
          {filters.map((filter, index) => {
            const f = fields.find((f) => f.id === filter.field) ?? fields[0];
            return (
              <div
                key={filter.id}
                className="flex flex-wrap gap-2 items-center"
              >
                {index === 0 ? (
                  <span className="w-16 text-sm">Where</span>
                ) : (
                  <select
                    className="core-select w-20"
                    aria-label="Filter conjunction"
                    value={filter.link}
                    onChange={(e) =>
                      updateFilter(filter.id, {
                        link: e.target.value as "and" | "or",
                      })
                    }
                  >
                    <option value="and">And</option>
                    <option value="or">Or</option>
                  </select>
                )}
                <select
                  className="core-select w-44"
                  aria-label="Filter field"
                  value={filter.field}
                  onChange={(e) =>
                    updateFilter(filter.id, {
                      field: e.target.value,
                      value: null,
                      operator: "eq",
                    })
                  }
                >
                  {fields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <select
                  className="core-select w-36"
                  aria-label="Filter operator"
                  value={filter.operator}
                  onChange={(e) =>
                    updateFilter(filter.id, {
                      operator: e.target.value as FilterRule["operator"],
                    })
                  }
                >
                  {[
                    "eq",
                    "neq",
                    "contains",
                    "gt",
                    "gte",
                    "lt",
                    "lte",
                    "empty",
                    "not-empty",
                  ].map((op) => (
                    <option key={op} value={op}>
                      {
                        (
                          {
                            eq: "Equals",
                            neq: "Not equal",
                            contains: "Contains",
                            gt: "Greater than",
                            gte: "At least",
                            lt: "Less than",
                            lte: "At most",
                            empty: "Is empty",
                            "not-empty": "Is not empty",
                          } as Record<string, string>
                        )[op]
                      }
                    </option>
                  ))}
                </select>
                {!["empty", "not-empty"].includes(filter.operator) && (
                  <div className="w-52">
                    <FieldInput
                      definition={f}
                      value={filter.value}
                      onChange={(value) => updateFilter(filter.id, { value })}
                    />
                  </div>
                )}
                <Switch
                  aria-label="Enable filter"
                  checked={filter.enabled}
                  onCheckedChange={(enabled) =>
                    updateFilter(filter.id, { enabled })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove filter"
                  onClick={() =>
                    onChange({
                      ...query,
                      filters: filters.filter((item) => item.id !== filter.id),
                    })
                  }
                >
                  <X size={14} />
                </Button>
              </div>
            );
          })}
          <Button
            variant="ghost"
            onClick={() =>
              onChange({
                ...query,
                filters: [
                  ...filters,
                  {
                    id: crypto.randomUUID(),
                    field: fields[0].id,
                    operator: "contains",
                    value: "" as Value,
                    link: "and",
                    enabled: true,
                  },
                ],
              })
            }
          >
            <Plus size={14} />
            Add filter
          </Button>
        </div>
      )}
      {panel === "sort" && (
        <div className="query-panel">
          {sorts.map((sort, index) => (
            <div key={index} className="flex gap-2 items-center">
              <select
                aria-label="Sort field"
                className="core-select w-44"
                value={sort.field}
                onChange={(e) => updateSort(index, { field: e.target.value })}
              >
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                aria-label="Toggle sort direction"
                onClick={() =>
                  updateSort(index, {
                    direction: sort.direction === "asc" ? "desc" : "asc",
                  })
                }
              >
                {sort.direction === "asc" ? (
                  <ArrowUp size={14} />
                ) : (
                  <ArrowDown size={14} />
                )}
              </Button>
              <Switch
                aria-label="Enable sort"
                checked={sort.enabled}
                onCheckedChange={(enabled) => updateSort(index, { enabled })}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove sort"
                onClick={() =>
                  onChange({
                    ...query,
                    sorts: sorts.filter((_, i) => i !== index),
                  })
                }
              >
                <X size={14} />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            onClick={() =>
              onChange({
                ...query,
                sorts: [
                  ...sorts,
                  { field: fields[0].id, direction: "asc", enabled: true },
                ],
              })
            }
          >
            <Plus size={14} />
            Add sort
          </Button>
        </div>
      )}
      {panel === "columns" && (
        <div className="query-panel flex flex-wrap gap-4">
          {fields.map((f) => (
            <label key={f.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={columns.includes(f.id)}
                onChange={(e) =>
                  onColumns(
                    e.target.checked
                      ? [...columns, f.id]
                      : columns.filter((c) => c !== f.id),
                  )
                }
              />
              {f.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
