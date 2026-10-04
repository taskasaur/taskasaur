import { useState } from "react";
import { Input } from "../ui/primitives/input";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "../ui/primitives/alert-dialog";
import type { WorkspaceProfile } from "./runtime";

/** Both workspace entry points use the same explicit, exact-name confirmation. */
export function DeleteWorkspaceDialog({
  profile,
  onClose,
  onDelete,
}: {
  profile: WorkspaceProfile;
  onClose(): void;
  onDelete(): Promise<void>;
}) {
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function remove() {
    if (busy || name !== profile.name) return;
    setBusy(true);
    setError("");
    try {
      await onDelete();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            Permanently delete this workspace’s records, files, credentials, and
            cached data from this device. Copies on other devices and exported
            or linked .taskasaur files will remain.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void remove();
          }}
        >
          <div className="field-row">
            <p>
              Type{" "}
              <strong className="select-all break-all">{profile.name}</strong>{" "}
              to confirm.
            </p>
            <Input
              aria-label="Workspace name to confirm deletion"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="submit"
              variant="destructive"
              disabled={busy || name !== profile.name}
            >
              {busy ? "Deleting…" : "Delete workspace"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
