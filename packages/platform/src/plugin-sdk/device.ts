import type { WorkflowExecution } from "../automation/engine";
import type { Value } from "../field-types";
export type WorkflowSignal = { id: string; name: string; data: Value };
export type Dispatch = {
  run_id: string;
  device_id: string;
  workspace_id: string;
  user_id: string;
  status: string;
  assignment_epoch: string;
  expires_at: string;
  execution: WorkflowExecution;
  engine_run_id: string | null;
  cancel_requested: boolean;
  signals?: WorkflowSignal[];
};
