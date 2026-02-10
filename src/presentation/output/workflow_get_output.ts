import type { OutputMode } from "./output.ts";

export interface WorkflowGetData {
  id: string;
  name: string;
  description?: string;
  version: number;
  jobs: {
    name: string;
    description?: string;
    steps: {
      name: string;
      description?: string;
      task: {
        type: string;
        [key: string]: unknown;
      };
    }[];
  }[];
  path: string;
}

export function renderWorkflowGet(
  data: WorkflowGetData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
