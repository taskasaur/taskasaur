import { Buffer } from "buffer/";

// CSDB's UTF-8 section parser uses Buffer in both browsers and Electron renderers.
globalThis.Buffer ??= Buffer as typeof globalThis.Buffer;

// CSDB uses this only to compare parsed row values when reusing serialized records.
export { dequal as isDeepStrictEqual } from "dequal";
