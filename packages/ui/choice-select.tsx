import * as React from "react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./primitives/select";
import { cn } from "./utils";

export interface Choice {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  group?: string;
}
/** Application composition of the unmodified official shadcn Select. */
export function ChoiceSelect({
  options,
  value,
  onValueChange,
  placeholder = "Choose…",
  className,
  ...props
}: {
  options: Choice[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
} & Omit<React.ComponentProps<typeof SelectTrigger>, "value" | "onChange">) {
  return (
    <Select
      value={value ?? ""}
      onValueChange={(v) => onValueChange(v ?? "")}
      items={options}
      disabled={props.disabled}
    >
      <SelectTrigger className={cn("w-full", className)} {...props}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** v1 HTML-select compatibility; new plugins use ChoiceSelect/Select directly. */
export function LegacySelect({
  children,
  value,
  defaultValue,
  onChange,
  multiple,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const [local, setLocal] = React.useState(
    defaultValue ?? (multiple ? [] : ""),
  );
  const options: Choice[] = [];
  function collect(nodes: React.ReactNode, group?: string) {
    React.Children.forEach(nodes, (child) => {
      if (
        !React.isValidElement<{
          value?: string | number;
          children?: React.ReactNode;
          disabled?: boolean;
          label?: string;
        }>(child)
      )
        return;
      if (child.type === "option")
        options.push({
          value: String(child.props.value ?? child.props.children ?? ""),
          label: child.props.children,
          disabled: child.props.disabled,
          group,
        });
      else
        collect(
          child.props.children,
          child.type === "optgroup" ? child.props.label : group,
        );
    });
  }
  collect(children);
  const raw = value ?? local;
  const selected = Array.isArray(raw) ? raw.map(String) : String(raw);
  const update = (next: string | string[] | null) => {
    const result = next ?? "";
    setLocal(result);
    const target = {
      value: Array.isArray(result) ? (result[0] ?? "") : result,
      name: props.name ?? "",
      id: props.id ?? "",
      selectedOptions: options
        .filter((o) =>
          (Array.isArray(result) ? result : [result]).includes(o.value),
        )
        .map((o) => ({ value: o.value })),
    };
    onChange?.({
      target,
      currentTarget: target,
      type: "change",
      preventDefault() {},
      stopPropagation() {},
      persist() {},
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
      nativeEvent: new Event("change"),
    } as unknown as React.ChangeEvent<HTMLSelectElement>);
  };
  const { id, name, disabled, required, title, style, onBlur, onFocus } = props;
  return (
    <Select
      multiple={multiple}
      value={selected}
      onValueChange={update}
      items={options}
      name={name}
      disabled={disabled}
      required={required}
    >
      <SelectTrigger
        id={id}
        title={title}
        style={style}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-describedby={props["aria-describedby"]}
        className={cn("w-full", className?.replace(/\bcore-select\b/g, ""))}
        onBlur={onBlur as never}
        onFocus={onFocus as never}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
