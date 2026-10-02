import { database, closeDatabase } from "./database";
import { migrate } from "./schema";
import { loadPackageCatalog } from "./plugin-packages";
await loadPackageCatalog();
await migrate(database());
await closeDatabase();
console.log("Taskasaur database schema is ready.");
