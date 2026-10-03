import { useSyncExternalStore } from "react";
import type { AppRuntime } from "./runtime";
import { currentPolicy } from "../core/identity";
import { Button } from "../ui/primitives/button";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "../ui/primitives/table";
export function PeerSharing({ runtime }: { runtime: AppRuntime }) {
  useSyncExternalStore(
    (listener) => {
      runtime.surfaceListeners.add(listener);
      return () => {
        runtime.surfaceListeners.delete(listener);
      };
    },
    () => runtime.surfacesVersion,
    () => 0,
  );
  const policy = currentPolicy(runtime.node.replica.access);
  return (
    <section className="space-y-4">
      <p className="page-description">
        Sharing is scoped to this encrypted workspace. Approved devices retain a
        complete copy of its records and files. Keep private work in a separate
        workspace. Credential secrets require a separate device grant.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Approved device</TableHead>
            <TableHead>Access</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.values(policy.members).map((member) => (
            <TableRow key={member.identity.id}>
              <TableCell>{member.identity.name}</TableCell>
              <TableCell>{member.role}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Button
        onClick={() => {
          location.hash = "devices";
        }}
      >
        Manage invitations and access
      </Button>
      <p className="text-sm text-muted-foreground">
        Revoking a device rotates future workspace encryption keys. It cannot
        erase copies already saved by that device.
      </p>
    </section>
  );
}
