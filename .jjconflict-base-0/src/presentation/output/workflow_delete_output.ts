import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

/**
 * Data structure for the workflow delete output.
 */
export interface WorkflowDeleteData {
  id: string;
  name: string;
  workflowPath: string;
  runsDeleted: number;
}

/**
 * JSON output structure for workflow delete.
 */
export interface WorkflowDeleteJsonOutput {
  deleted: {
    id: string;
    name: string;
    workflowPath: string;
  };
  runsDeleted: number;
}

/**
 * Renders the workflow delete output in either log or JSON mode.
 */
export function renderWorkflowDelete(
  data: WorkflowDeleteData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    const output: WorkflowDeleteJsonOutput = {
      deleted: {
        id: data.id,
        name: data.name,
        workflowPath: data.workflowPath,
      },
      runsDeleted: data.runsDeleted,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    const logger = getSwampLogger(["workflow", "delete"]);
    logger.info("Deleted workflow: {name}", { name: data.name });
    if (data.runsDeleted > 0) {
      logger.info("Runs deleted: {runsDeleted}", {
        runsDeleted: data.runsDeleted,
      });
    }
  }
}

/**
 * Renders a cancellation message.
 */
export function renderWorkflowDeleteCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["workflow", "delete"]);
    logger.info("Deletion cancelled.");
  }
}
