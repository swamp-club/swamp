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

import { bold, cyan, dim } from "@std/fmt/colors";
import type {
  EventHandlers,
  ModelMethodDescribeEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { formatSchemaAttributes } from "./model_get.ts";

class LogModelMethodDescribeRenderer
  implements Renderer<ModelMethodDescribeEvent> {
  handlers(): EventHandlers<ModelMethodDescribeEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const data = e.data;
        const lines: string[] = [];

        lines.push(`${bold(cyan("Model:"))} ${data.modelName}`);
        lines.push(`${bold(cyan("Type:"))} ${data.modelType}`);
        lines.push(`${bold(cyan("Version:"))} ${data.version}`);
        lines.push("");
        lines.push(
          `${bold(cyan("Method:"))} ${data.method.name} ${
            dim("-")
          } ${data.method.description}`,
        );

        const argAttrs = formatSchemaAttributes(data.method.inputs, "  ");
        if (argAttrs.length > 0) {
          lines.push("");
          lines.push(bold(cyan("Inputs:")));
          lines.push(...argAttrs);
        }

        if (
          data.method.dataOutputSpecs &&
          data.method.dataOutputSpecs.length > 0
        ) {
          lines.push("");
          lines.push(bold(cyan("Data Outputs:")));
          for (const spec of data.method.dataOutputSpecs) {
            const parts = [`${spec.specName} ${dim(`[${spec.kind}]`)}`];
            if (spec.description) {
              parts.push(`${dim("-")} ${spec.description}`);
            }
            const meta = [spec.contentType, spec.lifetime].filter(Boolean);
            if (meta.length > 0) parts.push(dim(`(${meta.join(", ")})`));
            lines.push(`  ${parts.join(" ")}`);
          }
        }

        writeOutput(lines.join("\n"));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonModelMethodDescribeRenderer
  implements Renderer<ModelMethodDescribeEvent> {
  handlers(): EventHandlers<ModelMethodDescribeEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createModelMethodDescribeRenderer(
  mode: OutputMode,
): Renderer<ModelMethodDescribeEvent> {
  switch (mode) {
    case "json":
      return new JsonModelMethodDescribeRenderer();
    case "log":
      return new LogModelMethodDescribeRenderer();
  }
}
