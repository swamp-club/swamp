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
import {
  formatMethodLines,
  formatSchemaAttributes,
  type MethodDescribeData,
} from "./type_describe_output.ts";

/**
 * Data structure for resource information.
 */
export interface ResourceData {
  id: string;
  createdAt: string;
  attributes: Record<string, unknown>;
}

/**
 * Data structure for the model get output.
 */
export interface ModelGetData {
  id: string;
  name: string;
  type: string;
  version: number;
  tags: Record<string, string>;
  globalArguments: Record<string, unknown>;
  resource?: ResourceData;
  typeVersion?: string;
  globalArgumentsSchema?: object;
  methods?: MethodDescribeData[];
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

/**
 * Renders the model get output in either log or JSON mode.
 */
export function renderModelGet(data: ModelGetData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
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

    if (data.resource) {
      lines.push("");
      lines.push(bold(cyan("Resource:")));
      lines.push(`  ${bold(cyan("ID:"))} ${dim(data.resource.id)}`);
      lines.push(
        `  ${bold(cyan("Created:"))} ${data.resource.createdAt}`,
      );
      const resAttrs = Object.entries(data.resource.attributes);
      if (resAttrs.length > 0) {
        lines.push(`  ${cyan("Attributes:")}`);
        lines.push(...formatRecord(data.resource.attributes, "    "));
      }
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
  }
}
