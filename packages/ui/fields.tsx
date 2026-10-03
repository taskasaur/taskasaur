"use client";

import { SharedTextarea } from "./html-controls";
import { LegacySelect } from "./choice-select";
import { useState, createContext, useContext } from "react";
import {
  field,
  decodeField,
  type Field,
  type Value,
  type RecordSchema,
} from "@taskasaur/platform/field-types";
import { Input } from "./primitives/input";
import { Button } from "./primitives/button";
import { Label } from "./primitives/label";
import { Switch } from "./primitives/switch";
export const ReferenceOptionsContext = createContext<
  Record<string, Array<{ id: string; label: string }>>
>({});
export function FieldInput({
  definition: f,
  value,
  onChange,
  disabled = false,
}: {
  definition: Field;
  value: Value | undefined;
  onChange: (value: Value) => void;
  disabled?: boolean;
}) {
  const references = useContext(ReferenceOptionsContext);
  const common = { id: f.id, disabled, "aria-label": f.label };
  const text =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);
  if (f.array) {
    const values = Array.isArray(value) ? value : [];
    return (
      <div className="space-y-2">
        {values.map((item, index) => (
          <div key={index} className="flex gap-2 items-start">
            <div className="flex-1">
              <FieldInput
                definition={{
                  ...f,
                  array: false,
                  id: `${f.id}_${index}`,
                  label: `${f.label} ${index + 1}`,
                  nullable: false,
                }}
                value={item}
                disabled={disabled}
                onChange={(next) =>
                  onChange(values.map((v, i) => (i === index ? next : v)))
                }
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              aria-label={`Remove ${f.label} ${index + 1}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...values,
              f.pgType === "boolean"
                ? false
                : ["smallint", "integer", "double precision"].includes(f.pgType)
                  ? 0
                  : f.pgType === "jsonb"
                    ? {}
                    : "",
            ])
          }
        >
          Add {f.label.toLowerCase()}
        </Button>
      </div>
    );
  }
  if (f.reference)
    return (
      <LegacySelect
        {...common}
        className="core-select"
        value={text}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Choose…</option>
        {text &&
          !(references[f.reference] ?? []).some((item) => item.id === text) && (
            <option value={text}>Unavailable reference ({text})</option>
          )}
        {(references[f.reference] ?? []).map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </LegacySelect>
    );
  if (f.pgType === "boolean" && f.nullable)
    return (
      <LegacySelect
        {...common}
        className="core-select"
        value={value == null ? "" : String(value)}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : e.target.value === "true")
        }
      >
        <option value="">Not set</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </LegacySelect>
    );
  if (f.pgType === "boolean")
    return (
      <Switch
        id={f.id}
        aria-label={f.label}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    );
  if (f.choices && !f.array)
    return (
      <LegacySelect
        {...common}
        className="core-select"
        value={text}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Choose…</option>
        {f.choices.map((choice) => (
          <option key={choice}>{choice}</option>
        ))}
      </LegacySelect>
    );
  if (f.pgType === "jsonb")
    return (
      <JsonInput
        value={value ?? null}
        onChange={onChange}
        label={f.label}
        disabled={disabled}
      />
    );
  if (f.control === "textarea")
    return (
      <SharedTextarea
        {...common}
        className="core-textarea"
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  const numeric = ["integer", "smallint", "double precision"].includes(
    f.pgType,
  );
  const inputType =
    f.pgType === "date"
      ? "date"
      : f.pgType === "time without time zone"
        ? "time"
        : f.pgType.startsWith("timestamp")
          ? "datetime-local"
          : numeric
            ? "number"
            : f.control === "password"
              ? "password"
              : f.control === "email"
                ? "email"
                : f.control === "url"
                  ? "url"
                  : "text";
  let display = text;
  if (
    inputType === "datetime-local" &&
    text &&
    f.pgType === "timestamp with time zone"
  ) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime()))
      display = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 19);
  }
  return (
    <Input
      {...common}
      type={inputType}
      value={display}
      min={f.min}
      max={f.max}
      step={
        inputType === "datetime-local" || inputType === "time"
          ? 1
          : numeric
            ? "any"
            : undefined
      }
      onChange={(event) => {
        const next = event.target.value;
        if (!next) {
          onChange(f.nullable ? null : "");
          return;
        }
        if (numeric) onChange(Number(next));
        else if (inputType === "datetime-local")
          onChange(
            f.pgType === "timestamp with time zone"
              ? new Date(next).toISOString()
              : next.length === 16
                ? next + ":00"
                : next,
          );
        else if (inputType === "time")
          onChange(next.length === 5 ? next + ":00" : next);
        else onChange(next);
      }}
    />
  );
}
function JsonInput({
  value,
  onChange,
  label,
  disabled,
}: {
  value: Value;
  onChange: (v: Value) => void;
  label: string;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(JSON.stringify(value, null, 2)),
    [error, setError] = useState("");
  return (
    <>
      <SharedTextarea
        className="core-textarea font-mono"
        aria-label={label}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value);
          try {
            onChange(JSON.parse(event.target.value));
            setError("");
            event.target.setCustomValidity("");
          } catch {
            event.target.setCustomValidity("Enter valid JSON");
            setError("Enter valid JSON before saving.");
          }
        }}
      />
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </>
  );
}
export function displayValue(value: Value | undefined, f?: Field): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value))
    return value
      .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
      .join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  if (f?.pgType === "timestamp with time zone")
    return new Date(String(value)).toLocaleString();
  return String(value);
}
export function RecordForm({
  schema,
  initial,
  onSave,
  onCancel,
}: {
  schema: RecordSchema;
  initial?: Record<string, Value>;
  onSave: (data: Record<string, Value>) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, Value>>(() => {
    const data: Record<string, Value> = {};
    for (const f of schema.fields)
      if (f.default !== undefined) data[f.id] = f.default as Value;
    if (schema.id === "calendar")
      Object.assign(data, {
        uid: crypto.randomUUID(),
        dtstamp: new Date().toISOString(),
        dtstart: new Date().toISOString().slice(0, 10),
      });
    if (schema.id === "track" || schema.id === "time")
      data.started_at = new Date().toISOString();
    return { ...data, ...initial };
  });
  const [optional, setOptional] = useState(Boolean(initial)),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const conditional = (f: Field) =>
    schema.id === "reminders" &&
    ((f.id === "description" &&
      ["DISPLAY", "EMAIL"].includes(String(values.action))) ||
      (["summary", "attendees"].includes(f.id) && values.action === "EMAIL") ||
      (f.id === "parent_id" && /^-?P/.test(String(values.trigger))) ||
      (f.id === "duration" && values.repeat != null) ||
      (f.id === "repeat" && values.duration != null));
  const generated = schema.id === "calendar" ? ["uid", "dtstamp"] : [];
  const requiredFields = schema.fields.filter(
    (f) => (f.required || conditional(f)) && !generated.includes(f.id),
  );
  const optionalFields = schema.fields.filter(
    (f) => !f.required && !conditional(f) && !generated.includes(f.id),
  );
  const render = (f: Field) => (
    <div key={f.id} className="field-row">
      <Label htmlFor={f.id}>
        {f.label}
        {(f.required || conditional(f)) && (
          <span className="text-muted-foreground ml-1">*</span>
        )}
      </Label>
      <FieldInput
        definition={f}
        value={values[f.id]}
        onChange={(value) =>
          setValues((current) => ({ ...current, [f.id]: value }))
        }
      />
      {f.description && <small>{f.description}</small>}
    </div>
  );
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          for (const f of schema.fields)
            if (values[f.id] !== undefined) decodeField(f, values[f.id]);
          await onSave(values);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setSaving(false);
        }
      }}
      className="space-y-4"
    >
      {requiredFields.map(render)}
      {optionalFields.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOptional(!optional)}
        >
          {optional ? "Hide optional fields" : "Add optional fields"}
        </Button>
      )}
      {optional && optionalFields.map(render)}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
