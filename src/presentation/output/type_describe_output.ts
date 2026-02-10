import { bold, cyan, dim } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

/**
 * Data structure for a method's description.
 */
export interface MethodDescribeData {
  name: string;
  description: string;
  inputAttributesSchema: object;
  dataOutputSpecs?: Array<{
    specType: string;
    description?: string;
    contentType?: string;
    lifetime?: string;
    garbageCollection?: number | string;
    streaming?: boolean;
    tags?: Record<string, string>;
  }>;
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
  inputAttributesSchema: object;
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
function formatSchemaAttributes(
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

  const attrs = formatSchemaAttributes(data.inputAttributesSchema, "  ");
  if (attrs.length > 0) {
    lines.push("");
    lines.push(bold(cyan("Input Attributes:")));
    lines.push(...attrs);
  }

  if (data.methods.length > 0) {
    lines.push("");
    lines.push(bold(cyan("Methods:")));
    for (let i = 0; i < data.methods.length; i++) {
      const method = data.methods[i];
      lines.push(
        `  ${bold(cyan(method.name))} ${dim("-")} ${method.description}`,
      );

      const methodAttrs = formatSchemaAttributes(
        method.inputAttributesSchema,
        "      ",
      );
      if (methodAttrs.length > 0) {
        lines.push(`    ${cyan("Input Attributes:")}`);
        lines.push(...methodAttrs);
      }

      if (method.dataOutputSpecs && method.dataOutputSpecs.length > 0) {
        lines.push(`    ${cyan("Data Outputs:")}`);
        for (const spec of method.dataOutputSpecs) {
          const parts = [spec.specType];
          if (spec.description) parts.push(`${dim("-")} ${spec.description}`);
          const meta = [spec.contentType, spec.lifetime].filter(Boolean);
          if (meta.length > 0) parts.push(dim(`(${meta.join(", ")})`));
          lines.push(`      ${parts.join(" ")}`);
        }
      }
    }
  }

  writeOutput(lines.join("\n"));
}
