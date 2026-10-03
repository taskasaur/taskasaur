import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as JsxDevRuntime from "react/jsx-dev-runtime";
import { LegacySelect } from "./choice-select";
import { Input } from "./primitives/input";
import { Textarea } from "./primitives/textarea";
import { Checkbox } from "./primitives/checkbox";

/** Compatibility for signed v1 plugins. Values/events stay at their existing boundary. */
export function SharedInput({
  type,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  if (type !== "checkbox") return <Input type={type} {...props} />;
  const {
    onChange,
    onBlur,
    onFocus,
    checked,
    defaultChecked,
    className,
    id,
    name,
    disabled,
    required,
    value,
    ...rest
  } = props;
  return (
    <Checkbox
      id={id}
      name={name}
      disabled={disabled}
      required={required}
      checked={checked}
      defaultChecked={defaultChecked}
      className={className}
      aria-label={rest["aria-label"]}
      aria-labelledby={rest["aria-labelledby"]}
      aria-describedby={rest["aria-describedby"]}
      onBlur={onBlur as never}
      onFocus={onFocus as never}
      onCheckedChange={(checked) => {
        const target = {
          checked,
          value: value ?? "on",
          name: name ?? "",
          id: id ?? "",
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
        } as unknown as React.ChangeEvent<HTMLInputElement>);
      }}
    />
  );
}
export function SharedTextarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Textarea
      className={className?.replace(/\bcore-textarea\b/g, "")}
      {...props}
    />
  );
}
const control = (type: unknown) =>
  type === "select"
    ? LegacySelect
    : type === "input"
      ? SharedInput
      : type === "textarea"
        ? SharedTextarea
        : type;
export const sharedReact = {
  ...React,
  createElement: ((type: unknown, ...args: unknown[]) =>
    React.createElement(
      control(type) as React.ElementType,
      ...args,
    )) as typeof React.createElement,
};
export const sharedJsxRuntime = {
  ...JsxRuntime,
  jsx: ((type: unknown, props: unknown, key?: string) =>
    JsxRuntime.jsx(
      control(type) as React.ElementType,
      props,
      key,
    )) as typeof JsxRuntime.jsx,
  jsxs: ((type: unknown, props: unknown, key?: string) =>
    JsxRuntime.jsxs(
      control(type) as React.ElementType,
      props,
      key,
    )) as typeof JsxRuntime.jsxs,
};

export const sharedJsxDevRuntime = {
  ...JsxDevRuntime,
  jsxDEV: ((type: unknown, ...args: unknown[]) =>
    (JsxDevRuntime.jsxDEV as Function)(
      control(type),
      ...args,
    )) as typeof JsxDevRuntime.jsxDEV,
};
