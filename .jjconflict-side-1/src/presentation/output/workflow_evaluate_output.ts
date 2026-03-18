// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";
import type { JobData } from "../../domain/workflows/job.ts";

export interface WorkflowEvaluateItemData {
  id: string;
  name: string;
  hadExpressions: boolean;
  forEachExpanded?: boolean;
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
    } else if (!item.forEachExpanded) {
      logger.info("  No expressions to evaluate");
    }

    if (item.forEachExpanded && item.jobs) {
      logger.info("  forEach steps expanded:");
      for (const job of item.jobs) {
        for (const step of job.steps) {
          logger.info("    - {step}", { step: step.name });
        }
      }
    }

    if (item.outputPath) {
      logger.info("  Output: {outputPath}", { outputPath: item.outputPath });
    }
  }
}
