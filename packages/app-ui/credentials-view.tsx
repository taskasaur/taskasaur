"use client";
import { useState } from "react";
import { KeyRound, ShieldOff } from "lucide-react";
import type { AppRuntime } from "./runtime";
import type { ResourceRecord } from "../plugin-sdk";
import { field, type RecordSchema } from "../field-types";
import { RecordTable } from "./record-table";
import { RecordForm } from "../ui/fields";
import { Button } from "../ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
const secret = (id: string, label: string, required = false) =>
  field(id, label, "text", {
    control: "password",
    sensitive: true,
    required,
    nullable: !required,
  });
function secretSchema(kind: string): RecordSchema {
  const fields =
    kind === "oauth2"
      ? [
          secret("access_token", "Access token", true),
          secret("refresh_token", "Refresh token"),
          field(
            "expires_at",
            "Access token expiry",
            "timestamp with time zone",
          ),
          field("client_id", "Client ID"),
          secret("client_secret", "Client secret"),
          field("token_endpoint", "Token endpoint", "text", { control: "url" }),
        ]
      : kind === "api-key"
        ? [secret("api_key", "API key", true)]
        : kind === "ssh-key"
          ? [
              field("username", "Username"),
              field("private_key", "Private key", "text", {
                control: "textarea",
                sensitive: true,
                required: true,
                nullable: false,
              }),
            ]
          : [
              field("username", "Username", "text", {
                required: true,
                nullable: false,
              }),
              secret("password", "Password", true),
            ];
  return {
    id: "credential_secret",
    pluginId: "credentials",
    version: 1,
    name: "Credential",
    fields,
  };
}
export default function CredentialsView({ runtime }: { runtime: AppRuntime }) {
  const [selected, setSelected] = useState<ResourceRecord | null>(null),
    [error, setError] = useState("");
  return (
    <div className="space-y-4">
      <p className="page-description">
        Authorize one credential for the plugins and destinations that need it.
        Secret values are sent directly to the encrypted vault.
      </p>
      {!runtime.profile.connected && (
        <div className="notice">
          Connect to a server to configure secrets. You can prepare credential
          metadata locally.
        </div>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <RecordTable
        runtime={runtime}
        collection="credentials"
        renderActions={(row) => (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Set credential secret"
              disabled={!runtime.profile.connected}
              onClick={() => setSelected(row)}
            >
              <KeyRound size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Revoke credential"
              disabled={
                !runtime.profile.connected || row.data.status === "revoked"
              }
              onClick={async () => {
                try {
                  await runtime.api("credentials/revoke", { id: row.id });
                  await runtime.synchronize();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              <ShieldOff size={14} />
            </Button>
          </>
        )}
      />
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>
              Connect {String(selected?.data.name ?? "credential")}
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <RecordForm
              key={selected.id}
              schema={secretSchema(String(selected.data.auth_kind))}
              onCancel={() => setSelected(null)}
              onSave={async (input) => {
                await runtime.synchronize();
                const secret = Object.fromEntries(
                  Object.entries(input)
                    .filter(([, v]) => v != null && v !== "")
                    .map(([key, value]) => [
                      key.replace(/_([a-z])/g, (_, letter) =>
                        letter.toUpperCase(),
                      ),
                      value,
                    ]),
                );
                await runtime.api("credentials/secret", {
                  id: selected.id,
                  secret,
                });
                setSelected(null);
                await runtime.synchronize();
              }}
            />
          )}
          <p className="text-xs text-muted-foreground">
            For OAuth refresh, also authorize the exact token endpoint in this
            credential’s allowed destinations.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
