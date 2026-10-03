declare module "@taskasaur/ui/fields" {
  import type { ReactNode } from "react";
  import type {
    Field,
    Value,
    RecordSchema,
  } from "@taskasaur/platform/field-types";
  export function FieldInput(props: {
    definition: Field;
    value: Value | undefined;
    onChange: (value: Value) => void;
    disabled?: boolean;
  }): ReactNode;
  export function RecordForm(props: {
    schema: RecordSchema;
    initial?: Record<string, Value>;
    onSave: (data: Record<string, Value>) => Promise<void>;
    onCancel: () => void;
  }): ReactNode;
  export function displayValue(value: Value | undefined, field?: Field): string;
}
declare module "@taskasaur/ui/record-table" {
  import type { ReactNode } from "react";
  import type { AppRuntime } from "@taskasaur/plugin-host";
  import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
  export function RecordTable(props: {
    runtime: AppRuntime;
    collection: string;
    toolbar?: ReactNode;
    renderActions?: (row: ResourceRecord) => ReactNode;
    onOpen?: (row: ResourceRecord) => void;
    hideCreate?: boolean;
    readOnly?: boolean;
    viewKey?: string;
    schemaOverride?: import("@taskasaur/platform/field-types").RecordSchema;
    storeOverride?: {
      list(): Promise<ResourceRecord[]>;
      put(data: any, id?: string): Promise<ResourceRecord>;
      delete(id: string): Promise<unknown>;
    };
  }): ReactNode;
}
declare module "@taskasaur/ui/download" {
  export function download(name: string, blob: Blob): void;
}
declare module "@taskasaur/ui/primitives/button" {
  import type { ComponentProps, ReactNode } from "react";
  type Props = Omit<ComponentProps<"button">, "onChange"> & {
    variant?:
      "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
    size?: "default" | "sm" | "lg" | "icon";
    asChild?: boolean;
  };
  export function Button(props: Props): ReactNode;
}
declare module "@taskasaur/ui/primitives/input" {
  import type { ComponentProps, ReactNode } from "react";
  type Props = ComponentProps<"input"> & {};
  export function Input(props: Props): ReactNode;
}
declare module "@taskasaur/ui/primitives/badge" {
  import type { ComponentProps, ReactNode } from "react";
  type Props = Omit<ComponentProps<"span">, "onChange"> & {
    variant?: "default" | "secondary" | "destructive" | "outline";
  };
  export function Badge(props: Props): ReactNode;
}
declare module "@taskasaur/ui/primitives/dialog" {
  import type { ComponentProps, ReactNode } from "react";
  type Props = Omit<ComponentProps<"div">, "onChange"> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    asChild?: boolean;
  };
  export function Dialog(props: Props): ReactNode;
  export function DialogTrigger(props: Props): ReactNode;
  export function DialogContent(props: Props): ReactNode;
  export function DialogHeader(props: Props): ReactNode;
  export function DialogFooter(props: Props): ReactNode;
  export function DialogTitle(props: Props): ReactNode;
  export function DialogDescription(props: Props): ReactNode;
  export function DialogClose(props: Props): ReactNode;
}
declare module "@taskasaur/ui/primitives/select" {
  import type { ComponentProps, ReactNode } from "react";
  type Props = Omit<ComponentProps<"div">, "onChange"> & {
    value?: string;
    onValueChange?: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
  };
  export function Select(props: Props): ReactNode;
  export function SelectTrigger(props: Props): ReactNode;
  export function SelectValue(props: Props): ReactNode;
  export function SelectContent(props: Props): ReactNode;
  export function SelectItem(props: Props): ReactNode;
  export function SelectGroup(props: Props): ReactNode;
  export function SelectLabel(props: Props): ReactNode;
  export function SelectSeparator(props: Props): ReactNode;
}
declare module "@taskasaur/ui/primitives/table" {
  import type { ComponentProps, ReactNode } from "react";
  type Props = Omit<ComponentProps<"table">, "onChange"> & {};
  export function Table(props: Props): ReactNode;
  export function TableHeader(props: Props): ReactNode;
  export function TableBody(props: Props): ReactNode;
  export function TableFooter(props: Props): ReactNode;
  export function TableRow(props: Props): ReactNode;
  export function TableHead(props: Props): ReactNode;
  export function TableCell(props: Props): ReactNode;
  export function TableCaption(props: Props): ReactNode;
}
