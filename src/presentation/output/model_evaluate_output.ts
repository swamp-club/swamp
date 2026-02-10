import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

export interface ModelEvaluateItemData {
  id: string;
  name: string;
  type: string;
  hadExpressions: boolean;
  outputPath?: string;
  attributes?: Record<string, unknown>;
}

export interface ModelEvaluateData {
  items: ModelEvaluateItemData[];
  total: number;
  evaluated: number;
}

export function renderModelEvaluate(
  data: ModelEvaluateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["model", "evaluate"]);

    logger.info("Evaluated {evaluated} of {total} model definitions", {
      evaluated: data.evaluated,
      total: data.total,
    });

    for (const item of data.items) {
      const status = item.hadExpressions ? "[evaluated]" : "[no expressions]";
      logger.info("  {name} ({type}) {status}", {
        name: item.name,
        type: item.type,
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

export function renderModelEvaluateSingle(
  item: ModelEvaluateItemData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(item, null, 2));
  } else {
    const logger = getSwampLogger(["model", "evaluate"]);

    logger.info("Evaluated model definition: {name} ({type})", {
      name: item.name,
      type: item.type,
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
