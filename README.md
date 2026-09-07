# Taskasaur

Taskasaur brings time tracking, tasks, and focus sessions into one CSDB-backed workspace. It runs as an Electron desktop app.

## Features

- Track live and manual sessions, including interval metadata and breaks.
- Review sessions in list, week, and month views with persisted filters and sorting.
- Manage multiple internal or path-based CSDB databases and start from built-in templates.
- Store database content in user-selected `.csdb` files. Database references and application preferences live in `databases.csdb`; UI settings use one JSON object per settings-table row.
- Define custom metadata fields, selection options, attribute references, and task-source filters.
- Sync tasks from internal, Markdown, GitHub, and mail sources.
- Turn synced mail into actionable tasks alongside the rest of your work.
- Organize Tasks with table or Kanban views, grouping, configurable fields, filters, and multi-column sorting.
- Run configurable Focus or Break timers with sound and vibration alerts.
- Restore UI preferences from the registry `settings` table.
- Use desktop tray controls for timers, entries, tasks, and settings.
- Follow the guided onboarding flow or restart it from Settings → Information.

## Development

Requirements: Node.js and npm. Local CSDB packages referenced by `package.json` must be available beside this repository.

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm run electron:dev  # Desktop development
npm run build:web     # Type-check and build the web app
npm run package:dir   # Build an unpacked desktop application
npm run cap:sync      # Sync web assets into Capacitor
npm test              # Run the Vitest suite
```

### Releases

Create a release from a clean, fully pushed branch:

```bash
make release version=1.1.1
```

The command runs tests and the web build, updates the desktop, Android, and iOS version metadata, commits the version, creates a `v1.1.1` tag, and atomically pushes the commit and tag. The release workflow then builds macOS, Windows, Linux, iOS, and Android artifacts on native GitHub runners and publishes them in a generated GitHub release. GitHub automatically includes source ZIP and tarball downloads.

The mobile artifacts are currently unsigned development distributions. Store or broadly distributed builds require Apple and Android signing credentials.

## Project Structure

- `src/pages`: Track, Tasks, Focus, Settings, Files, and onboarding screens.
- `src/features`: Reusable feature sections and dialogs.
- `src/store`: Zustand application state and actions.
- `src/lib`: CSDB access, registry settings, task synchronization, and domain utilities.
- `electron`: Desktop main process and preload bridge.
- `templates`: Starter CSDB databases.

## Verification

```bash
npm test
npm run build:web
```
