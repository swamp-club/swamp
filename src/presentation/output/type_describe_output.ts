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
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

/**
 * Data structure for a data output spec in the describe output.
 */
export interface DataOutputSpecDescribeData {
  specName: string;
  kind: "resource" | "file";
  description?: string;
  schema?: object;
  contentType?: string;
  lifetime?: string;
  garbageCollection?: number | string;
  streaming?: boolean;
  tags?: Record<string, string>;
}

/**
 * Data structure for a method's description.
 */
export interface MethodDescribeData {
  name: string;
  description: string;
  arguments: object;
  dataOutputSpecs?: DataOutputSpecDescribeData[];
}

/**
 * Data structure for the type describe output.
 */
export interface TypeDescribeData {
  type: {
    raw: string;
    normalized: string;
  };
  version: string;
  globalArguments?: object;
  methods: MethodDescribeData[];
}

interface JsonSchemaProperty {
  type?: string;
  enum?: string[];
  description?: string;
}

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
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
    if (prop.type) parts.push(dim(`(${prop.type})`));
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
      method.arguments,
      "      ",
    );
    if (methodAttrs.length > 0) {
      lines.push(`    ${cyan("Arguments:")}`);
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
 * Renders the type description in either log or JSON mode.
 */
export function renderTypeDescribe(
  data: TypeDescribeData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
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
}
