// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import {
  type EventHandlers,
  isModelEvaluateAllData,
  type ModelEvaluateAllData,
  type ModelEvaluateEvent,
  type ModelEvaluateItemData,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogModelEvaluateRenderer implements Renderer<ModelEvaluateEvent> {
  handlers(): EventHandlers<ModelEvaluateEvent> {
    return {
      evaluating: () => {},
      completed: (e) => {
        if (isModelEvaluateAllData(e.data)) {
          this.renderAll(e.data);
        } else {
          this.renderSingle(e.data);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  private renderSingle(item: ModelEvaluateItemData): void {
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

  private renderAll(data: ModelEvaluateAllData): void {
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

class JsonModelEvaluateRenderer implements Renderer<ModelEvaluateEvent> {
  handlers(): EventHandlers<ModelEvaluateEvent> {
    return {
      evaluating: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createModelEvaluateRenderer(
  mode: OutputMode,
): Renderer<ModelEvaluateEvent> {
  switch (mode) {
    case "json":
      return new JsonModelEvaluateRenderer();
    case "log":
      return new LogModelEvaluateRenderer();
  }
}
