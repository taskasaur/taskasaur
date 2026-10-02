# Taskasaur client

This is the Vite/React web, Electron and Capacitor frontend. Backend API, PostgreSQL, Supabase, workers and authoritative SDK sources live in the sibling `taskasaur-server` repository. Do not import server source files or load server credentials in the client. Shared contracts come from the pinned `@taskasaur/platform` archive under `vendor/`. Run `npm run sdk:verify`, `npm run typecheck`, `npm test` and the relevant web/native build after changes. Preserve uncommitted planning documents.
