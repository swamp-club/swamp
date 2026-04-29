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
  TypeDescribeData,
  TypeDescribeEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { formatMethodLines, formatSchemaAttributes } from "./model_get.ts";

/** Maximum width to which method names are padded in `--methods` output.
 * Avoids unbounded right-shift if one model has a very long method name. */
const METHODS_MAX_PAD = 32;

export interface TypeDescribeRenderOpts {
  /** When true, render only the method list — skip globalArgs, schemas,
   * and resource specs. Saves the agent from grep/jq-piping `--json`
   * output just to learn the method surface. */
  methodsOnly?: boolean;
}

function renderMethodsOnlyLog(data: TypeDescribeData): void {
  const lines: string[] = [];
  const padWidth = Math.min(
    METHODS_MAX_PAD,
    data.methods.reduce((max, m) => Math.max(max, m.name.length), 0),
  );
  for (const method of data.methods) {
    const name = method.name.padEnd(padWidth);
    const desc = method.description ?? "";
    lines.push(desc ? `${name}  — ${desc}` : name);
  }
  writeOutput(lines.join("\n"));
}

class LogTypeDescribeRenderer implements Renderer<TypeDescribeEvent> {
  constructor(private opts: TypeDescribeRenderOpts) {}

  handlers(): EventHandlers<TypeDescribeEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const data = e.data;

        if (this.opts.methodsOnly) {
          renderMethodsOnlyLog(data);
          return;
        }

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
  constructor(private opts: TypeDescribeRenderOpts) {}

  handlers(): EventHandlers<TypeDescribeEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const out = this.opts.methodsOnly
          ? {
            type: e.data.type,
            version: e.data.version,
            methods: e.data.methods.map((m) => ({
              name: m.name,
              description: m.description,
            })),
          }
          : e.data;
        console.log(JSON.stringify(out, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createTypeDescribeRenderer(
  mode: OutputMode,
  opts: TypeDescribeRenderOpts = {},
): Renderer<TypeDescribeEvent> {
  switch (mode) {
    case "json":
      return new JsonTypeDescribeRenderer(opts);
    case "log":
      return new LogTypeDescribeRenderer(opts);
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
