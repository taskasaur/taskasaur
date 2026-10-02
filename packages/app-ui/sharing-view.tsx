"use client";
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { AppRuntime } from "./runtime";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { field, type RecordSchema } from "@taskasaur/platform/field-types";
import { RecordForm } from "../ui/fields";
import { Button } from "../ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
type Member = { user_id: string; email: string; role: string };
type Grant = { subject_id: string; role: string; expires_at: string | null };
const memberSchema: RecordSchema = {
  id: "member_input",
  pluginId: "access-control",
  version: 1,
  name: "Member",
  fields: [
    field("email", "Email", "text", {
      control: "email",
      required: true,
      nullable: false,
    }),
    field("role", "Workspace role", "text", {
      required: true,
      nullable: false,
      choices: ["editor", "viewer"],
      default: "editor",
    }),
  ],
};
export function SharingView({ runtime }: { runtime: AppRuntime }) {
  const [members, setMembers] = useState<Member[]>([]),
    [error, setError] = useState(""),
    [adding, setAdding] = useState(false),
    [selected, setSelected] = useState<ResourceRecord | null>(null);
  const resources =
    useLiveQuery(
      () =>
        runtime.db.records
          .filter(
            (r) =>
              !r.deletedAt &&
              r.ownerId === runtime.principal.userId &&
              !["credentials", "devices", "jobs", "workflow_runs"].includes(
                r.collection,
              ),
          )
          .toArray(),
      [runtime],
    ) ?? [];
  const refresh = () =>
    runtime
      .api<Member[]>("access/members")
      .then(setMembers)
      .catch((e) => setError(e.message));
  useEffect(() => {
    if (runtime.profile.connected) void refresh();
  }, [runtime]);
  if (!runtime.profile.connected)
    return (
      <div className="empty-state">
        <h3>Connect a workspace to share</h3>
        <p>Sharing uses your server account and workspace permissions.</p>
      </div>
    );
  const owner = members.some(
    (m) => m.user_id === runtime.principal.userId && m.role === "owner",
  );
  return (
    <div className="space-y-6">
      <p className="page-description">
        Workspace membership lets people connect. Share individual entries to
        give them access to their content.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="section-heading">
        <h2>People</h2>
        {owner && <Button onClick={() => setAdding(true)}>Add person</Button>}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Workspace role</TableHead>
            <TableHead>Manage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <TableRow key={member.user_id}>
              <TableCell>{member.email}</TableCell>
              <TableCell>{member.role}</TableCell>
              <TableCell>
                {owner && member.role !== "owner" && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await runtime.api(
                          "access/members",
                          { userId: member.user_id },
                          "DELETE",
                        );
                        await refresh();
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    Remove access
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <label className="field-row">
        Share an entry
        <select
          className="core-select"
          value={selected?.id ?? ""}
          onChange={(e) =>
            setSelected(resources.find((r) => r.id === e.target.value) ?? null)
          }
        >
          <option value="">Choose an entry…</option>
          {resources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.collection} ·{" "}
              {String(r.data.title ?? r.data.name ?? r.data.summary ?? r.id)}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <ResourceSharing
          runtime={runtime}
          record={selected}
          members={members}
        />
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a workspace member</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The person must already have an account on this server.
          </p>
          <RecordForm
            schema={memberSchema}
            onCancel={() => setAdding(false)}
            onSave={async (data) => {
              await runtime.api("access/members", data);
              setAdding(false);
              await refresh();
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function ResourceSharing({
  runtime,
  record,
  members,
}: {
  runtime: AppRuntime;
  record: ResourceRecord;
  members: Member[];
}) {
  const [grants, setGrants] = useState<Grant[]>([]),
    [error, setError] = useState(""),
    [subject, setSubject] = useState(""),
    [role, setRole] = useState("viewer"),
    [expires, setExpires] = useState("");
  const refresh = () =>
    runtime
      .api<Grant[]>(`access/grants?resourceId=${record.id}`)
      .then(setGrants)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, [record.id]);
  async function grant(subjectId: string, value: string | null) {
    try {
      await runtime.api("access/grants", {
        resourceId: record.id,
        subjectId,
        role: value,
        expiresAt: expires ? new Date(expires).toISOString() : null,
      });
      await refresh();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <section className="settings-card space-y-4">
      <h2>Entry access</h2>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Manage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grants.map((g) => (
            <TableRow key={g.subject_id}>
              <TableCell>
                {members.find((m) => m.user_id === g.subject_id)?.email ??
                  g.subject_id}
              </TableCell>
              <TableCell>{g.role}</TableCell>
              <TableCell>
                {g.expires_at
                  ? new Date(g.expires_at).toLocaleString()
                  : "No expiry"}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  onClick={() => void grant(g.subject_id, null)}
                >
                  Revoke
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-wrap gap-3">
        <label className="field-row">
          Person
          <select
            className="core-select"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          >
            <option value="">Choose…</option>
            {members
              .filter((m) => m.user_id !== runtime.principal.userId)
              .map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.email}
                </option>
              ))}
          </select>
        </label>
        <label className="field-row">
          Role
          <select
            className="core-select"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {["viewer", "commenter", "editor"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="field-row">
          Expiry (optional)
          <input
            className="core-input"
            type="datetime-local"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </label>
        <Button disabled={!subject} onClick={() => void grant(subject, role)}>
          Share
        </Button>
      </div>
    </section>
  );
}
