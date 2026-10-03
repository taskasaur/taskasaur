import * as execution from "../plugin-sdk/execution";
import * as fields from "../field-types";
import * as errors from "./errors";
import * as workflows from "./workflows";
import * as calendar from "./calendar-values";
/** Shared runtime imports for portable plugin bundles. Native/UI APIs require separate services. */
export const coreModules: Record<string, unknown> = {
  "@taskasaur/platform/plugin-sdk/execution": execution,
  "@taskasaur/platform/field-types": fields,
  "@taskasaur/platform/core/errors": errors,
  "@taskasaur/platform/core/workflows": workflows,
  "@taskasaur/platform/core/calendar-values": calendar,
};
