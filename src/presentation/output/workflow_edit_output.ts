import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

/**
 * Data structure for workflow edit output.
 */
export interface WorkflowEditData {
  path: string;
  editor?: string;
  status: "opened" | "updated";
  name: string;
  id: string;
}

/**
 * Renders workflow edit output in either log or JSON mode.
 */
export function renderWorkflowEdit(
  data: WorkflowEditData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["workflow", "edit"]);
    if (data.status === "opened") {
      logger.info(
        "Opening workflow file in {editor}: {name} at {path}",
        { editor: data.editor, name: data.name, path: data.path },
      );
    } else {
      logger.info(
        "Updated workflow from stdin: {name} at {path}",
        { name: data.name, path: data.path },
      );
    }
  }
}
