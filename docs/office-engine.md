# Offline office editing

The Office plugin uses the shared interface on browsers, Electron, iOS and Android. Its portable editors are downloaded with the app and included in the offline shell:

- Documents: Quill 2 (BSD), with Mammoth (BSD) for DOCX text/format import and docx (MIT) for DOCX export. The editable format preserves Quill deltas.
- Spreadsheets: ExcelJS (MIT) retains XLSX workbooks, cells, styles and sheets. The shared table components provide editing; hot-formula-parser (MIT) calculates formulas locally. The grid shows up to 500 rows and 50 columns; additional imported workbook data remains in the XLSX file. Formula evaluation limits recursion and range size.
- Presentations: the shared React components edit slides, text, images, colors and speaker notes and provide presentation mode. PptxGenJS (MIT) exports PPTX. The editable format preserves the complete Taskasaur slide model.

Documents and presentations use `application/vnd.taskasaur.office+json`, format `taskasaur-office-v1`. Spreadsheets retain XLSX. Import supports DOCX, plain text, XLSX, CSV and the editable Taskasaur format. These are lightweight editors, not layout-identical implementations of Microsoft Office: advanced DOCX layout, embedded objects and every Excel formula are not supported. Original imports are retained in Files. Existing ODF/PPTX files remain stored unchanged and can use the optional engine below or an external editor.

Saves commit through core's immutable file versions and encrypted chunks. Every approved device downloads file contents; simultaneous edits retain conflicting versions for review. Editing and exporting require no cloud service. The browser acceptance test creates and exports all three formats and reopens them after a cold offline reload. Native build success does not replace real-device acceptance.

## Optional LibreOffice engine

When compatible assets are installed and the WebView provides cross-origin isolation, Office also exposes the original LibreOffice engine interface. `npm run office:prepare` verifies and extracts the pinned official COWASM archive. `OFFICE_ASSET_PATH` selects the extracted `wasm` directory for a headless peer; desktop packaging copies installed assets into `resources/office-engine/wasm`.

The pinned nightly `cool-wasm-2026-06-30_18-26.tar`, SHA-256 `44d34343109c7771a7b295da4f76bee629422fa5977ad63d286029fdfae48e61`, comes from [Collabora's official directory](https://www.collaboraoffice.com/downloads/COOL-Wasm-Nightly/). It is approximately 339 MB after excluding debug assets and contains Writer and Calc, not Impress. It is not required for the portable editors or their presentation support. `deploy/office/Dockerfile` retains the separate optional source builder with Writer, Calc and Impress enabled.

`public/office-patches` supplies two upstream UI resources missing from this nightly. Preserve their MPL-2.0 terms and the engine's bundled notices. Threaded WASM engine support varies by WebView; unsupported platforms use the portable editors.
