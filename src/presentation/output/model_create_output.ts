import { bold, cyan, dim } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";
import {
  formatMethodLines,
  formatSchemaAttributes,
  type MethodDescribeData,
} from "./type_describe_output.ts";

export interface ModelCreateData {
  id: string;
  type: string;
  name: string;
  path: string;
  version?: string;
  globalArguments?: object;
  methods?: MethodDescribeData[];
}

export function renderModelCreate(
  data: ModelCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const lines = [
      `${bold(cyan("Created:"))} ${bold(data.name)} ${dim(`(${data.type})`)}`,
      `${bold(cyan("Path:"))} ${data.path}`,
    ];

    if (data.version) {
      lines.push(`${bold(cyan("Version:"))} ${data.version}`);
    }

    if (data.globalArguments) {
      const attrs = formatSchemaAttributes(
        data.globalArguments,
        "  ",
      );
      if (attrs.length > 0) {
        lines.push("");
        lines.push(bold(cyan("Global Arguments:")));
        lines.push(...attrs);
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
