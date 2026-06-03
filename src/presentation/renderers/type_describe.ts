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

import { bold, cyan, dim } from "@std/fmt/colors";
import type {
  EventHandlers,
  TypeDescribeData,
  TypeDescribeEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { formatMethodLines, formatSchemaAttributes } from "./model_get.ts";

class LogTypeDescribeRenderer implements Renderer<TypeDescribeEvent> {
  handlers(): EventHandlers<TypeDescribeEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const data = e.data;
        const lines: string[] = [];

        const typeName = data.type.raw !== data.type.normalized
          ? `${data.type.normalized} ${dim(`(${data.type.raw})`)}`
          : data.type.normalized;

        lines.push(`${bold(cyan("Type:"))} ${typeName}`);
        lines.push(`${bold(cyan("Version:"))} ${data.version}`);

        if (data.globalArguments) {
          const attrs = formatSchemaAttributes(data.globalArguments, "  ");
          if (attrs.length > 0) {
            lines.push("");
            lines.push(bold(cyan("Global Arguments:")));
            lines.push(...attrs);
          }
        }

        if (data.methods.length > 0) {
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

class JsonTypeDescribeRenderer implements Renderer<TypeDescribeEvent> {
  handlers(): EventHandlers<TypeDescribeEvent> {
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

export function createTypeDescribeRenderer(
  mode: OutputMode,
): Renderer<TypeDescribeEvent> {
  switch (mode) {
    case "json":
      return new JsonTypeDescribeRenderer();
    case "log":
      return new LogTypeDescribeRenderer();
  }
}

/** Standalone render function for use by un-migrated search commands. */
export function renderTypeDescribe(
  data: TypeDescribeData,
  mode: OutputMode,
): void {
  const renderer = createTypeDescribeRenderer(mode);
  const handlers = renderer.handlers();
  handlers.completed({ kind: "completed", data });
}
