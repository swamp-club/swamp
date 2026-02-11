import { bold, cyan, dim } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

export interface WorkflowStepData {
  name: string;
  description: string;
  taskType: string;
}

export interface WorkflowJobData {
  name: string;
  description: string;
  steps: WorkflowStepData[];
}

export interface WorkflowCreateData {
  id: string;
  name: string;
  path: string;
  jobs?: WorkflowJobData[];
}

export function renderWorkflowCreate(
  data: WorkflowCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const lines = [
      `${bold(cyan("Created:"))} ${bold(data.name)}`,
      `${bold(cyan("Path:"))} ${data.path}`,
    ];

    if (data.jobs && data.jobs.length > 0) {
      lines.push("");
      lines.push(bold(cyan("Jobs:")));
      for (const job of data.jobs) {
        lines.push(
          `  ${bold(cyan(job.name))} ${dim("-")} ${job.description}`,
        );
        if (job.steps.length > 0) {
          lines.push(`    ${cyan("Steps:")}`);
          for (const step of job.steps) {
            lines.push(
              `      ${step.name} ${dim(`(${step.taskType})`)} ${
                dim("-")
              } ${step.description}`,
            );
          }
        }
      }
    }

    writeOutput(lines.join("\n"));
  }
}
