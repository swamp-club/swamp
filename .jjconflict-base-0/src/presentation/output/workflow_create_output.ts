import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

export interface WorkflowCreateData {
  id: string;
  name: string;
  path: string;
}

export function renderWorkflowCreate(
  data: WorkflowCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["workflow", "create"]);
    logger.info("Created workflow: {name} at {path}", {
      name: data.name,
      path: data.path,
    });
  }
}
