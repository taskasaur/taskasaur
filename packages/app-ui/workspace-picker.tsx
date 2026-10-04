import { useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import { Button } from "../ui/primitives/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/primitives/popover";
import { deleteSavedWorkspace, type WorkspaceProfile } from "./runtime";
import { DeleteWorkspaceDialog } from "./delete-workspace-dialog";

export function WorkspacePicker({
  profiles,
  disabled,
  onOpen,
  onDeleted,
}: {
  profiles: WorkspaceProfile[];
  disabled: boolean;
  onOpen(profile: WorkspaceProfile): void;
  onDeleted(profile: WorkspaceProfile): void;
}) {
  const [open, setOpen] = useState(false),
    [deleting, setDeleting] = useState<WorkspaceProfile>();
  return (
    <div className="field-row">
      <span id="internal-workspaces-label">Open internal workspace</span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!deleting) setOpen(next);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              className="w-full justify-between font-normal"
            />
          }
          aria-labelledby="internal-workspaces-label"
          disabled={disabled}
        >
          {profiles.length ? "Choose a workspace" : "No internal workspaces"}
          <ChevronDown />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="Internal workspaces"
          className="w-[var(--anchor-width)] max-h-80 overflow-y-auto"
        >
          {profiles.map((profile) => (
            <div key={profile.id} className="flex items-center gap-1">
              <Button
                variant="ghost"
                className="min-w-0 flex-1 justify-start font-normal"
                disabled={disabled}
                onClick={() => {
                  setOpen(false);
                  onOpen(profile);
                }}
              >
                <span className="truncate">{profile.name}</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive"
                disabled={disabled}
                aria-label={`Delete ${profile.name}`}
                title={`Delete ${profile.name}`}
                onClick={() => setDeleting(profile)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {!profiles.length && (
            <p className="p-2 text-muted-foreground">No internal workspaces</p>
          )}
        </PopoverContent>
        {deleting && (
          <DeleteWorkspaceDialog
            key={deleting.id}
            profile={deleting}
            onClose={() => setDeleting(undefined)}
            onDelete={async () => {
              await deleteSavedWorkspace(deleting);
              onDeleted(deleting);
            }}
          />
        )}
      </Popover>
    </div>
  );
}
