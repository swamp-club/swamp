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

import { z } from "zod";
import {
  type FileOutputSpec,
  type MethodDefinition,
  type MethodKind,
  type MethodKindSource,
  resolveMethodKind,
  type ResourceOutputSpec,
} from "../../domain/models/model.ts";

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

export interface MethodDescribeData {
  name: string;
  description: string;
  arguments: object;
  kind?: MethodKind;
  kindSource: MethodKindSource;
  outputLifetime?: string;
}

interface ZodDef {
  type: string;
  innerType?: z.ZodTypeAny;
  element?: z.ZodTypeAny;
  shape?: Record<string, z.ZodTypeAny>;
  valueType?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  schema?: z.ZodTypeAny;
  values?: readonly string[];
  value?: unknown;
  defaultValue?: unknown;
}

function getSchemaType(schema: z.ZodTypeAny): string {
  const def = (schema as unknown as { _def: ZodDef })._def;
  return def?.type ?? "";
}

function getSchemaDef(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const schemaType = getSchemaType(schema);
  const def = getSchemaDef(schema);

  const wrapperTypes = ["optional", "nullable", "default"];
  if (wrapperTypes.includes(schemaType) && def.innerType) {
    return unwrapSchema(def.innerType);
  }
  if (schemaType === "effects" && def.schema) {
    return unwrapSchema(def.schema);
  }
  return schema;
}

/**
 * fallback for when Zod's toJSONSchema() crashes on types like
 * z.record(z.unknown()), z.uuid() or z.iso.datetime()
 */
function manualZodToJsonSchema(schema: z.ZodTypeAny): object {
  const unwrapped = unwrapSchema(schema);
  const schemaType = getSchemaType(unwrapped);
  const def = getSchemaDef(unwrapped);

  switch (schemaType) {
    case "unknown":
      return {};
    case "string": {
      const result: Record<string, unknown> = { type: "string" };
      const zodInternals = unwrapped as unknown as {
        _zod?: { format?: string };
      };
      if (zodInternals._zod?.format) {
        result.format = zodInternals._zod.format;
      }
      return result;
    }
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "record": {
      const additionalProperties = def.valueType
        ? manualZodToJsonSchema(def.valueType)
        : {};
      return { type: "object", additionalProperties };
    }
    case "object": {
      const result: Record<string, unknown> = { type: "object" };
      if (def.shape) {
        const properties: Record<string, object> = {};
        const required: string[] = [];
        for (const [key, value] of Object.entries(def.shape)) {
          properties[key] = manualZodToJsonSchema(value);
          const valueType = getSchemaType(value);
          if (valueType !== "optional" && valueType !== "default") {
            required.push(key);
          }
        }
        result.properties = properties;
        if (required.length > 0) {
          result.required = required;
        }
      }
      return result;
    }
    case "array": {
      const items = def.element ? manualZodToJsonSchema(def.element) : {};
      return { type: "array", items };
    }
    case "enum": {
      if (def.values) {
        return { type: "string", enum: [...def.values] };
      }
      return { type: "string" };
    }
    case "literal": {
      return { type: typeof def.value, const: def.value };
    }
    default:
      return {};
  }
}

/**
 * falls back to a manual converter when Zod's toJSONSchema() fails on known v4
 * edge cases; io "input" describes what a schema with a transform accepts, the
 * default is its output
 */
export function zodToJsonSchema(
  schema: z.ZodTypeAny,
  options: { io?: "input" | "output" } = {},
): object {
  try {
    const result = z.toJSONSchema(schema, { io: options.io ?? "output" });
    return stripDefaultsFromRequired(result);
  } catch {
    const v3Diagnostic = detectZodV3Schema(schema);
    if (v3Diagnostic) return v3Diagnostic;
    return manualZodToJsonSchema(schema);
  }
}

function detectZodV3Schema(
  schema: z.ZodTypeAny,
): object | undefined {
  const def = schema as unknown as {
    _def?: { type?: string; typeName?: string };
  };
  if (def._def && !def._def.type && def._def.typeName) {
    return {
      $error: "unsupported_zod_version",
      message:
        `This schema was created with Zod v3. Upgrade to Zod v4 to see ` +
        `method arguments. See https://zod.dev/v4 for migration guidance.`,
    };
  }
  return undefined;
}

/**
 * Zod lists defaulted fields as required, but swamp treats a schema default as
 * satisfying the requirement at runtime
 */
function stripDefaultsFromRequired(
  jsonSchema: object,
): object {
  const schema = jsonSchema as Record<string, unknown>;
  const required = schema.required;
  const properties = schema.properties;
  if (
    !Array.isArray(required) || typeof properties !== "object" ||
    properties === null
  ) {
    return jsonSchema;
  }
  const props = properties as Record<string, Record<string, unknown>>;
  const filtered = required.filter((key: string) =>
    !(key in props && "default" in props[key])
  );
  const result = { ...schema };
  if (filtered.length > 0) {
    result.required = filtered;
  } else {
    delete result.required;
  }
  return result;
}

export function toMethodDescribeData(
  name: string,
  method: MethodDefinition,
): MethodDescribeData {
  const { kind, source } = resolveMethodKind(name, method);
  return {
    name,
    description: method.description,
    arguments: zodToJsonSchema(method.arguments),
    ...(kind ? { kind } : {}),
    kindSource: source,
    ...(method.outputLifetime ? { outputLifetime: method.outputLifetime } : {}),
  };
}

export function buildDataOutputSpecs(
  resources?: Record<string, ResourceOutputSpec>,
  files?: Record<string, FileOutputSpec>,
): DataOutputSpecDescribeData[] {
  const resourceSpecs = resources
    ? Object.entries(resources).map(
      ([specName, spec]) => ({
        specName,
        kind: "resource" as const,
        description: spec.description,
        schema: zodToJsonSchema(spec.schema),
        lifetime: spec.lifetime,
        garbageCollection: spec.garbageCollection,
        tags: spec.tags,
      }),
    )
    : [];

  const fileSpecs = files
    ? Object.entries(files).map(
      ([specName, spec]) => ({
        specName,
        kind: "file" as const,
        description: spec.description,
        contentType: spec.contentType,
        lifetime: spec.lifetime,
        garbageCollection: spec.garbageCollection,
        streaming: spec.streaming,
        tags: spec.tags,
      }),
    )
    : [];

  return [...resourceSpecs, ...fileSpecs];
}
