import { useState } from "react";
import {
  field,
  pgTypes,
  type Field,
  type Value,
} from "@taskasaur/platform/field-types";
import { FieldInput } from "./fields";
import { ChoiceSelect } from "./choice-select";
import { Button } from "./primitives/button";
import { Input } from "./primitives/input";
import { Switch } from "./primitives/switch";
export function ColumnEditor({
  initial,
  standard,
  onSave,
}: {
  initial?: Field;
  standard: boolean;
  onSave: (field: Field) => Promise<void>;
}) {
  const [id, setId] = useState(initial?.id ?? ""),
    [label, setLabel] = useState(initial?.label ?? ""),
    [type, setType] = useState(initial?.pgType ?? "text"),
    [mode, setMode] = useState<NonNullable<Field["inputMode"]>>(
      initial?.inputMode ??
        (initial?.array ? "list" : initial?.choices ? "select" : "single"),
    ),
    [options, setOptions] = useState(
      JSON.stringify(initial?.options ?? initial?.choices ?? [], null, 2),
    ),
    [required, setRequired] = useState(initial?.required ?? false),
    [visibility, setVisibility] = useState(initial?.visibility ?? "editable"),
    [minItems, setMinItems] = useState(initial?.minItems?.toString() ?? ""),
    [maxItems, setMaxItems] = useState(initial?.maxItems?.toString() ?? ""),
    [hasDefault, setHasDefault] = useState(initial?.default !== undefined),
    [defaultValue, setDefaultValue] = useState<Value>(
      (initial?.default as Value) ?? null,
    ),
    [error, setError] = useState("");
  const descriptor = () =>
    field(
      id,
      label,
      type,
      standard
        ? { ...initial, label }
        : {
            ...initial,
            label,
            pgType: type,
            control: initial?.pgType === type ? initial.control : undefined,
            reference: initial?.pgType === type ? initial.reference : undefined,
            min: initial?.pgType === type ? initial.min : undefined,
            max: initial?.pgType === type ? initial.max : undefined,
            length: initial?.pgType === type ? initial.length : undefined,
            precision: initial?.pgType === type ? initial.precision : undefined,
            scale: initial?.pgType === type ? initial.scale : undefined,
            array: ["list", "multiselect"].includes(mode),
            inputMode: mode,
            required,
            nullable: !required,
            visibility,
            storage: "custom",
            generated: undefined,
            choices: undefined,
            options: ["select", "multiselect"].includes(mode)
              ? JSON.parse(options)
              : undefined,
            minItems:
              ["list", "multiselect"].includes(mode) && minItems
                ? Number(minItems)
                : undefined,
            maxItems:
              ["list", "multiselect"].includes(mode) && maxItems
                ? Number(maxItems)
                : undefined,
            default: hasDefault ? defaultValue : undefined,
          },
    );
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await onSave(descriptor());
        } catch (e) {
          setError(String(e));
        }
      }}
    >
      <label className="field-row">
        Column ID
        <Input
          value={id}
          disabled={Boolean(initial)}
          required
          pattern="[a-z][a-z0-9_]*"
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <label className="field-row">
        Label
        <Input
          value={label}
          required
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label className="field-row">
        Base type
        <ChoiceSelect
          aria-label="Base type"
          disabled={standard}
          value={type}
          options={pgTypes.map((value) => ({ value, label: value }))}
          onValueChange={(value) => setType(value as typeof type)}
        />
      </label>
      <label className="field-row">
        Input mode
        <ChoiceSelect
          aria-label="Input mode"
          value={mode}
          disabled={standard}
          options={[
            { value: "single", label: "One value" },
            { value: "select", label: "One selection" },
            { value: "multiselect", label: "Multiple selections" },
            { value: "list", label: "Multiple values" },
          ]}
          onValueChange={(value) => setMode(value as typeof mode)}
        />
      </label>
      {["select", "multiselect"].includes(mode) && (
        <label className="field-row">
          Options (JSON array of typed values)
          <Input
            aria-label="Column options"
            disabled={standard}
            value={options}
            onChange={(e) => setOptions(e.target.value)}
          />
        </label>
      )}
      {["list", "multiselect"].includes(mode) && (
        <div className="grid grid-cols-2 gap-3">
          <label className="field-row">
            Minimum inputs
            <Input
              aria-label="Minimum inputs"
              type="number"
              min={0}
              disabled={standard}
              value={minItems}
              onChange={(e) => setMinItems(e.target.value)}
            />
          </label>
          <label className="field-row">
            Maximum inputs
            <Input
              aria-label="Maximum inputs"
              type="number"
              min={1}
              disabled={standard}
              value={maxItems}
              onChange={(e) => setMaxItems(e.target.value)}
            />
          </label>
        </div>
      )}
      <label className="flex items-center gap-3">
        <Switch
          disabled={standard}
          checked={required}
          onCheckedChange={setRequired}
        />
        Required
      </label>
      <label className="field-row">
        Visibility
        <ChoiceSelect
          aria-label="Column visibility"
          disabled={standard}
          value={visibility}
          options={[
            { value: "editable", label: "Editable" },
            { value: "viewable", label: "Read only" },
            { value: "hidden", label: "Hidden" },
            { value: "addable", label: "Add when needed" },
          ]}
          onValueChange={(value) => setVisibility(value as typeof visibility)}
        />
      </label>
      <label className="flex items-center gap-3">
        <Switch
          disabled={standard}
          checked={hasDefault}
          onCheckedChange={setHasDefault}
        />
        Default value
      </label>
      {hasDefault && (
        <FieldInput
          definition={field("column_default", "Default value", type, {
            array: ["list", "multiselect"].includes(mode),
          })}
          value={defaultValue}
          onChange={setDefaultValue}
          disabled={standard}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit">Save column</Button>
    </form>
  );
}
