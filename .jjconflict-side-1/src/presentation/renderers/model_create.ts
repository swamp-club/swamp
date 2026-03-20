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
import type { EventHandlers, ModelCreateEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { formatMethodLines, formatSchemaAttributes } from "./model_get.ts";

class LogModelCreateRenderer implements Renderer<ModelCreateEvent> {
  handlers(): EventHandlers<ModelCreateEvent> {
    return {
      creating: () => {},
      completed: (e) => {
        const data = e.data;
        const lines = [
          `${bold(cyan("Created:"))} ${bold(data.name)} ${
            dim(`(${data.type})`)
          }`,
          `${bold(cyan("Path:"))} ${data.path}`,
        ];

        if (data.version) {
          lines.push(`${bold(cyan("Version:"))} ${data.version}`);
        }

        if (data.globalArguments) {
          const schemaAttrs = formatSchemaAttributes(
            data.globalArguments,
            "  ",
          );
          if (schemaAttrs.length > 0) {
            lines.push("");
            lines.push(bold(cyan("Global Arguments:")));
            lines.push(...schemaAttrs);
          }
        }

        if (data.methods && data.methods.length > 0) {
          lines.push("");
          lines.push(bold(cyan("Methods:")));
          lines.push(...formatMethodLines(data.methods));
        }

        writeOutput(lines.join("\n"));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonModelCreateRenderer implements Renderer<ModelCreateEvent> {
  handlers(): EventHandlers<ModelCreateEvent> {
    return {
      creating: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createModelCreateRenderer(
  mode: OutputMode,
): Renderer<ModelCreateEvent> {
  switch (mode) {
    case "json":
      return new JsonModelCreateRenderer();
    case "log":
      return new LogModelCreateRenderer();
  }
}
