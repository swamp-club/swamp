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
import type {
  FileOutputSpec,
  MethodDefinition,
  ResourceOutputSpec,
} from "../../domain/models/model.ts";

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
  inputs: object;
  dataOutputSpecs?: DataOutputSpecDescribeData[];
}

/**
 * Internal interface for accessing Zod v4's internal definition structure.
 */
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

/**
 * Gets the definition type from a Zod schema (Zod v4 compatible).
 */
function getSchemaType(schema: z.ZodTypeAny): string {
  const def = (schema as unknown as { _def: ZodDef })._def;
  return def?.type ?? "";
}

/**
 * Gets the definition from a Zod schema.
 */
function getSchemaDef(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

/**
 * Unwraps optional, nullable, default, and effects wrapper types.
 */
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
 * Manually converts a Zod schema to JSON Schema format.
 * This is a fallback for when Zod's built-in toJSONSchema() crashes
 * on types like z.record(z.unknown()), z.uuid(), or z.iso.datetime().
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
      // Check for format metadata (uuid, datetime, etc.)
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
          if (getSchemaType(value) !== "optional") {
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
      // Safe fallback for any unrecognized type
      return {};
  }
}

/**
 * Converts a Zod schema to JSON Schema format.
 * Falls back to a manual converter if Zod's built-in toJSONSchema() fails.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): object {
  try {
    return z.toJSONSchema(schema);
  } catch {
    return manualZodToJsonSchema(schema);
  }
}

/**
 * Converts a MethodDefinition to MethodDescribeData for presentation.
 */
export function toMethodDescribeData(
  name: string,
  method: MethodDefinition,
  resources?: Record<string, ResourceOutputSpec>,
  files?: Record<string, FileOutputSpec>,
): MethodDescribeData {
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

  const dataOutputSpecs = [...resourceSpecs, ...fileSpecs];

  const schema = zodToJsonSchema(method.arguments);
  return {
    name,
    description: method.description,
    arguments: schema,
    inputs: schema,
    dataOutputSpecs: dataOutputSpecs.length > 0 ? dataOutputSpecs : undefined,
  };
}
