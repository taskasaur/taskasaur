import { RefreshCw } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "./button";
import { cn } from "../utils";

type SyncButtonProps = ComponentProps<typeof Button> & {
  syncing?: boolean;
  label?: ReactNode;
};

export function SyncButton({
  syncing = false,
  disabled,
  children,
  label,
  ...props
}: SyncButtonProps) {
  const content = children ?? label;

  return (
    <Button disabled={disabled || syncing} {...props}>
      <RefreshCw className={cn("size-4", syncing && "animate-spin")} />
      {content}
    </Button>
  );
}
