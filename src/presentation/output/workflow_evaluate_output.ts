import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";
import type { JobData } from "../../domain/workflows/job.ts";

export interface WorkflowEvaluateItemData {
  id: string;
  name: string;
  hadExpressions: boolean;
  outputPath?: string;
  jobs?: JobData[];
}

export interface WorkflowEvaluateData {
  items: WorkflowEvaluateItemData[];
  total: number;
  evaluated: number;
}

export function renderWorkflowEvaluate(
  data: WorkflowEvaluateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["workflow", "evaluate"]);

    logger.info("Evaluated {evaluated} of {total} workflow definitions", {
      evaluated: data.evaluated,
      total: data.total,
    });

    for (const item of data.items) {
      const status = item.hadExpressions ? "[evaluated]" : "[no expressions]";
      logger.info("  {name} {status}", {
        name: item.name,
        status,
      });
      if (item.outputPath) {
        logger.info("    Output: {outputPath}", {
          outputPath: item.outputPath,
        });
      }
    }
  }
}

export function renderWorkflowEvaluateSingle(
  item: WorkflowEvaluateItemData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(item, null, 2));
  } else {
    const logger = getSwampLogger(["workflow", "evaluate"]);

    logger.info("Evaluated workflow definition: {name}", {
      name: item.name,
    });

    if (item.hadExpressions) {
      logger.info("  Expressions evaluated");
    } else {
      logger.info("  No expressions to evaluate");
    }

    if (item.outputPath) {
      logger.info("  Output: {outputPath}", { outputPath: item.outputPath });
    }
  }
}
