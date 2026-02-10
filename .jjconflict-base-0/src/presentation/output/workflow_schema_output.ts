import type { OutputMode } from "./output.ts";

/**
 * Data structure for the workflow schema output.
 */
export interface WorkflowSchemaData {
  workflow: object;
  job: object;
  jobDependency: object;
  step: object;
  stepDependency: object;
  stepTask: object;
  triggerCondition: object;
}

/**
 * Renders the workflow schema in either log or JSON mode.
 */
export function renderWorkflowSchema(
  data: WorkflowSchemaData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
