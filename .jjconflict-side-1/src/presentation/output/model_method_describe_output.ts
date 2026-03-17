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
import { writeOutput } from "../logging.ts";
import type { OutputMode } from "./output.ts";
import {
  formatSchemaAttributes,
  type MethodDescribeData,
} from "./type_describe_output.ts";

/**
 * Data structure for the model method describe output.
 */
export interface ModelMethodDescribeData {
  modelName: string;
  modelType: string;
  version: string;
  method: MethodDescribeData;
}

/**
 * Renders the model method description in either log or JSON mode.
 */
export function renderModelMethodDescribe(
  data: ModelMethodDescribeData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

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

  const argAttrs = formatSchemaAttributes(data.method.arguments, "  ");
  if (argAttrs.length > 0) {
    lines.push("");
    lines.push(bold(cyan("Arguments:")));
    lines.push(...argAttrs);
  }

  if (data.method.dataOutputSpecs && data.method.dataOutputSpecs.length > 0) {
    lines.push("");
    lines.push(bold(cyan("Data Outputs:")));
    for (const spec of data.method.dataOutputSpecs) {
      const parts = [`${spec.specName} ${dim(`[${spec.kind}]`)}`];
      if (spec.description) parts.push(`${dim("-")} ${spec.description}`);
      const meta = [spec.contentType, spec.lifetime].filter(Boolean);
      if (meta.length > 0) parts.push(dim(`(${meta.join(", ")})`));
      lines.push(`  ${parts.join(" ")}`);
    }
  }

  writeOutput(lines.join("\n"));
}
