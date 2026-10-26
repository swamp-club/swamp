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

import type { EventHandlers } from "../../libswamp/stream.ts";
import {
  isModelEvaluateAllData,
  type ModelEvaluateAllData,
  type ModelEvaluateEvent,
  type ModelEvaluateItemData,
} from "../../libswamp/models/evaluate.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { carryModelWording } from "../../domain/behavior_wording.ts";
import {
  type CommandSurface,
  DEFAULT_COMMAND_SURFACE,
  surfaceNoun,
} from "../command_surface.ts";

class LogModelEvaluateRenderer implements Renderer<ModelEvaluateEvent> {
  constructor(private readonly surface: CommandSurface) {}

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
        throw carryModelWording(e.error, new UserError(e.error.message));
      },
    };
  }

  private renderSingle(item: ModelEvaluateItemData): void {
    const logger = getSwampLogger(["model", "evaluate"]);

    const noun = surfaceNoun(this.surface);
    logger.info(`Evaluated ${noun} definition: {name} ({type})`, {
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
    if (item.saved === false) {
      logger.info(`  Not saved: saving needs run on the ${noun}`);
    }
  }

  private renderAll(data: ModelEvaluateAllData): void {
    const logger = getSwampLogger(["model", "evaluate"]);

    const noun = surfaceNoun(this.surface);
    logger.info(`Evaluated {evaluated} of {total} ${noun} definitions`, {
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
      if (item.saved === false) {
        logger.info(`    Not saved: saving needs run on the ${noun}`);
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
        throw carryModelWording(e.error, new UserError(e.error.message));
      },
    };
  }
}

export function createModelEvaluateRenderer(
  mode: OutputMode,
  surface: CommandSurface = DEFAULT_COMMAND_SURFACE,
): Renderer<ModelEvaluateEvent> {
  switch (mode) {
    case "json":
      return new JsonModelEvaluateRenderer();
    case "log":
      return new LogModelEvaluateRenderer(surface);
  }
}
