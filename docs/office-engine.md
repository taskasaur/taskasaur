# Local office engine

The editor wraps Collabora/LibreOffice's local WebAssembly engine. Files remain core Files resources; the editor's virtual filesystem is temporary. The bridge verifies parent origin, frame identity and session IDs, waits for serialization, then commits returned bytes in the core Dexie transaction. Failed saves retain the open session and do not acknowledge durability.

`npm run office:prepare` fetches the pinned official COWASM archive and verifies its SHA-256 before extracting runtime assets. A previously downloaded archive can be passed as `npm run office:prepare -- /path/to/archive.tar`. Debug Wasm/DWARF/maps are excluded. The selected archive is `cool-wasm-2026-06-30_18-26.tar`, hash `44d34343109c7771a7b295da4f76bee629422fa5977ad63d286029fdfae48e61`, from [Collabora's official download directory](https://www.collaboraoffice.com/downloads/COOL-Wasm-Nightly/).

The nightly archive omits two interface resources which cause Calc's notebookbar to abort. `public/office-patches` supplies the upstream `sc/uiconfig/scalc/ui/sheetviewbox.ui` and `svx/uiconfig/ui/themeselectorpanel.ui` before engine startup. The sheet-view file is from LibreOffice core commit `fef506cb5c62f16c0d51b9e4c998f159f1b6a6e5`. Preserve upstream MPL-2.0 terms and the engine's bundled third-party notices when distributing these files. [LibreOffice source and license](https://github.com/LibreOffice/core).

The runtime assets are about 339 MB; the upstream download includes large debug files and is about 2.4 GB. The engine requires cross-origin isolation, WebAssembly threads, and appropriate local storage capacity. `OFFICE_ASSET_PATH` selects the extracted `wasm` directory. Electron packaging uses the same pinned assets under `resources/office-engine/wasm`.

Acceptance covers documents, spreadsheets and presentations: actual edits, formulas, slides, durable saves, reopening, export, and cold start with all network requests blocked. The implementation ledger records actual results. Native mobile engines and real-device acceptance are required before advertising all-platform offline office support.

The current nightly contains Writer and Calc but was compiled without Impress. It is a prototype artifact and must not be presented as complete office support. A full source build is configured with `--with-wasm-module=writer calc impress` against Collabora Online commit `48da39e5ab9990bcfcfaba123243198b92929b75`; `deploy/office/Dockerfile` pins the builder base and Emscripten toolchain. Presentation acceptance, native mobile engines and release provisioning remain open.
