import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/primitives/dialog";
import { Input } from "../ui/primitives/input";
import { Button } from "../ui/primitives/button";
export function useWorkspacePassword() {
  const [open, setOpen] = useState(false),
    [password, setPassword] = useState("");
  const pending = useRef<
    { resolve(value: string): void; reject(error: Error): void } | undefined
  >(undefined);
  useEffect(
    () => () => {
      pending.current?.reject(Error("Workspace opening canceled"));
      pending.current = undefined;
    },
    [],
  );
  const requestPassword = () =>
    new Promise<string>((resolve, reject) => {
      pending.current?.reject(Error("Password request replaced"));
      pending.current = { resolve, reject };
      setPassword("");
      setOpen(true);
    });
  const cancel = () => {
    pending.current?.reject(Error("Workspace opening canceled"));
    pending.current = undefined;
    setPassword("");
    setOpen(false);
  };
  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) cancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlock workspace</DialogTitle>
          <DialogDescription>
            Enter this workspace file’s password.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            pending.current?.resolve(password);
            pending.current = undefined;
            setPassword("");
            setOpen(false);
          }}
        >
          <Input
            aria-label="Workspace password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!password}>
              Unlock
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
  return { requestPassword, dialog };
}
export function passwordRequired(error: unknown) {
  return (
    ["PASSWORD_REQUIRED", "INCORRECT_PASSWORD"].includes(
      (error as { kind?: string })?.kind ?? "",
    ) ||
    /Enter the workspace password|Incorrect workspace password/.test(
      String(error),
    )
  );
}
