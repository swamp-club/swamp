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
  DataOutputSpecDescribeData,
  EventHandlers,
  TypeDescribeData,
  TypeDescribeEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { formatMethodLines, formatSchemaAttributes } from "./model_get.ts";

function formatDataOutputSpecs(
  specs: DataOutputSpecDescribeData[],
): string[] {
  const lines: string[] = [];
  for (const spec of specs) {
    const parts = [`${spec.specName} ${dim(`[${spec.kind}]`)}`];
    if (spec.description) parts.push(`${dim("-")} ${spec.description}`);
    const meta = [spec.contentType, spec.lifetime].filter(Boolean);
    if (meta.length > 0) parts.push(dim(`(${meta.join(", ")})`));
    lines.push(`  ${parts.join(" ")}`);
  }
  return lines;
}

interface CompactMethod {
  name: string;
  description: string;
  arguments: object;
}

interface CompactTypeDescribe {
  type: { raw: string; normalized: string };
  version: string;
  globalArguments?: object;
  dataOutputSpecs?: string[];
  methods: CompactMethod[];
}

function toCompactOutput(data: TypeDescribeData): CompactTypeDescribe {
  return {
    type: data.type,
    version: data.version,
    globalArguments: data.globalArguments
      ? compactSchema(data.globalArguments)
      : undefined,
    dataOutputSpecs: data.dataOutputSpecs?.map((s) => s.specName),
    methods: data.methods.map((m) => ({
      name: m.name,
      description: m.description,
      arguments: compactSchema(m.arguments),
    })),
  };
}

interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, { type?: string | string[]; enum?: string[] }>;
  required?: string[];
}

function compactSchema(schema: object): object {
  const s = schema as JsonSchemaLike;
  if (!s.properties) return {};
  const result: Record<string, unknown> = {};
  const props: Record<string, object> = {};
  for (const [key, val] of Object.entries(s.properties)) {
    const entry: Record<string, unknown> = {};
    if (val.type) entry.type = val.type;
    if (val.enum) entry.enum = val.enum;
    props[key] = entry;
  }
  result.properties = props;
  if (s.required && s.required.length > 0) {
    result.required = s.required;
  }
  return result;
}

class LogTypeDescribeRenderer implements Renderer<TypeDescribeEvent> {
  #compact: boolean;

  constructor(compact: boolean) {
    this.#compact = compact;
  }

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

        if (
          !this.#compact && data.dataOutputSpecs &&
          data.dataOutputSpecs.length > 0
        ) {
          lines.push("");
          lines.push(bold(cyan("Data Outputs:")));
          lines.push(...formatDataOutputSpecs(data.dataOutputSpecs));
        }

        if (
          this.#compact && data.dataOutputSpecs &&
          data.dataOutputSpecs.length > 0
        ) {
          lines.push("");
          lines.push(bold(cyan("Data Outputs:")));
          for (const spec of data.dataOutputSpecs) {
            lines.push(`  ${spec.specName} ${dim(`[${spec.kind}]`)}`);
          }
        }

        if (data.methods.length > 0) {
          lines.push("");
          lines.push(bold(cyan("Methods:")));
          lines.push(...formatMethodLines(data.methods));
        }

        if (data.type.normalized.startsWith("@swamp/")) {
          lines.push("");
          lines.push(
            dim(
              `Missing a capability? swamp issue feature --extension ${data.type.normalized}`,
            ),
          );
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
  #compact: boolean;

  constructor(compact: boolean) {
    this.#compact = compact;
  }

  handlers(): EventHandlers<TypeDescribeEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const output = this.#compact ? toCompactOutput(e.data) : e.data;
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createTypeDescribeRenderer(
  mode: OutputMode,
  compact = false,
): Renderer<TypeDescribeEvent> {
  switch (mode) {
    case "json":
      return new JsonTypeDescribeRenderer(compact);
    case "log":
      return new LogTypeDescribeRenderer(compact);
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
