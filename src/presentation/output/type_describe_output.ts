import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
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

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, { type?: string }>;
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
    if (prop.type) parts.push(`(${prop.type})`);
    if (required.has(name)) parts.push("*required");
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

  const logger = getSwampLogger(["type", "describe"]);

  const typeName = data.type.raw !== data.type.normalized
    ? `${data.type.normalized} (${data.type.raw})`
    : data.type.normalized;

  logger.info("Type: {typeName}", { typeName });
  logger.info("Version: {version}", { version: data.version });

  const attrs = formatSchemaAttributes(data.inputAttributesSchema, "  ");
  if (attrs.length > 0) {
    logger.info("");
    logger.info("Input Attributes:");
    for (const attr of attrs) {
      logger.info(attr);
    }
  }

  if (data.methods.length > 0) {
    logger.info("");
    logger.info("Methods:");
    for (const method of data.methods) {
      logger.info("  {name} - {description}", {
        name: method.name,
        description: method.description,
      });

      const methodAttrs = formatSchemaAttributes(
        method.inputAttributesSchema,
        "      ",
      );
      if (methodAttrs.length > 0) {
        logger.info("    Input Attributes:");
        for (const attr of methodAttrs) {
          logger.info(attr);
        }
      }

      if (method.dataOutputSpecs && method.dataOutputSpecs.length > 0) {
        logger.info("    Data Outputs:");
        for (const spec of method.dataOutputSpecs) {
          const parts = [spec.specType];
          if (spec.description) parts.push(`- ${spec.description}`);
          const meta = [spec.contentType, spec.lifetime].filter(Boolean);
          if (meta.length > 0) parts.push(`(${meta.join(", ")})`);
          logger.info(`      ${parts.join(" ")}`);
        }
      }
    }
  }
}
