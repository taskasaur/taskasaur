import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
/** Referencing a user-owned credential/file does not transfer its ownership. */
export function resourceManagers(records: ResourceRecord[]) {
  const owners = new Map<string, string>();
  for (const record of records) {
    if (record.managedBy) owners.set(record.id, record.managedBy);
  }
  return owners;
}
