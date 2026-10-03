import type { ResourceRecord } from "./index";

/** UI commands run only after an explicit user selection. IDs are plugin-local. */
export interface PluginCommand {
  id: string;
  title: string;
  description?: string;
  keywords?: string[];
  page?: string;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}
export interface SearchCollectionOptions {
  collection: string;
  /** Core indexes safe textual fields by default. This can narrow that set. */
  fields?: string[];
  titleField?: string;
  page?: string;
  enabled?: boolean;
}
export interface NavigationService {
  registerCommand(command: PluginCommand): () => void;
  configureSearch(options: SearchCollectionOptions): () => void;
  navigate(page?: string, recordId?: string): void | Promise<void>;
}
export interface SearchDocument {
  id: string;
  pluginId: string;
  collection: string;
  title: string;
  text: string;
  tokens: string[];
  revision: string;
}
export interface ManagedResourceStore {
  list(): Promise<ResourceRecord[]>;
  put(
    data: Record<string, import("../field-types").Value>,
    id?: string,
  ): Promise<ResourceRecord>;
  delete(id: string): Promise<void>;
}
