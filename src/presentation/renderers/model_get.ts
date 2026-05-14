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
  MethodDescribeData,
  ModelGetData,
  ModelGetEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

interface JsonSchemaProperty {
  type?: string | string[];
  enum?: string[];
  description?: string;
}

interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Formats a JSON Schema `type` field into a human-readable string.
 * Handles both single types (`"string"`) and nullable/union arrays
 * (`["string", "null"]`) produced by `zodToJsonSchema` for optional
 * or nullable Zod types.
 */
export function formatSchemaType(
  type: string | string[] | undefined,
): string | undefined {
  if (type === undefined) return undefined;
  if (Array.isArray(type)) {
    return type.join(" | ");
  }
  return type;
}

/**
 * Formats JSON Schema properties as human-readable attribute lines.
 */
export function formatSchemaAttributes(
  schema: object,
  indent: string,
): string[] {
  const s = schema as JsonSchemaObject;
  if (!s.properties) return [];

  const required = new Set(s.required ?? []);
  return Object.entries(s.properties).map(([name, prop]) => {
    const parts = [name];
    const formatted = formatSchemaType(prop.type);
    if (formatted) parts.push(dim(`(${formatted})`));
    if (prop.enum) parts.push(dim(`[${prop.enum.join(", ")}]`));
    if (required.has(name)) parts.push(dim("*required"));
    return `${indent}${parts.join(" ")}`;
  });
}

/**
 * Formats method descriptions as human-readable lines.
 */
export function formatMethodLines(methods: MethodDescribeData[]): string[] {
  const lines: string[] = [];
  for (const method of methods) {
    lines.push(
      `  ${bold(cyan(method.name))} ${dim("-")} ${method.description}`,
    );

    const methodAttrs = formatSchemaAttributes(
      method.inputs,
      "      ",
    );
    if (methodAttrs.length > 0) {
      lines.push(`    ${cyan("Inputs:")}`);
      lines.push(...methodAttrs);
    }

    if (method.dataOutputSpecs && method.dataOutputSpecs.length > 0) {
      lines.push(`    ${cyan("Data Outputs:")}`);
      for (const spec of method.dataOutputSpecs) {
        const parts = [`${spec.specName} ${dim(`[${spec.kind}]`)}`];
        if (spec.description) parts.push(`${dim("-")} ${spec.description}`);
        const meta = [spec.contentType, spec.lifetime].filter(Boolean);
        if (meta.length > 0) parts.push(dim(`(${meta.join(", ")})`));
        lines.push(`      ${parts.join(" ")}`);
      }
    }
  }
  return lines;
}

/**
 * Formats a record as indented key: value lines.
 */
function formatRecord(
  record: Record<string, unknown>,
  indent: string,
): string[] {
  return Object.entries(record).map(([key, value]) =>
    `${indent}${key}: ${dim(String(value))}`
  );
}

class LogModelGetRenderer implements Renderer<ModelGetEvent> {
  handlers(): EventHandlers<ModelGetEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const data = e.data;
        const lines = [
          `${bold(cyan("Name:"))} ${bold(data.name)} ${dim(`(${data.type})`)}`,
          `${bold(cyan("ID:"))} ${dim(data.id)}`,
          `${bold(cyan("Version:"))} ${data.version}`,
        ];

        const tagEntries = Object.entries(data.tags);
        if (tagEntries.length > 0) {
          lines.push("");
          lines.push(bold(cyan("Tags:")));
          lines.push(...formatRecord(data.tags, "  "));
        }

        const attrEntries = Object.entries(data.globalArguments);
        if (attrEntries.length > 0) {
          lines.push("");
          lines.push(bold(cyan("Global Arguments:")));
          lines.push(...formatRecord(data.globalArguments, "  "));
        }

        if (data.typeVersion) {
          lines.push("");
          lines.push(bold(cyan("Type Version:")) + ` ${data.typeVersion}`);
        }

        if (data.globalArgumentsSchema) {
          const schemaAttrs = formatSchemaAttributes(
            data.globalArgumentsSchema,
            "  ",
          );
          if (schemaAttrs.length > 0) {
            lines.push("");
            lines.push(bold(cyan("Global Arguments Schema:")));
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

class JsonModelGetRenderer implements Renderer<ModelGetEvent> {
  handlers(): EventHandlers<ModelGetEvent> {
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

export function createModelGetRenderer(
  mode: OutputMode,
): Renderer<ModelGetEvent> {
  switch (mode) {
    case "json":
      return new JsonModelGetRenderer();
    case "log":
      return new LogModelGetRenderer();
  }
}

/** Standalone render function for use by un-migrated search commands. */
export function renderModelGet(data: ModelGetData, mode: OutputMode): void {
  const renderer = createModelGetRenderer(mode);
  const handlers = renderer.handlers();
  handlers.completed({ kind: "completed", data });
}
