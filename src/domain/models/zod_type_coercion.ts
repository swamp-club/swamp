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

import type { z } from "zod";

/**
 * Internal Zod definition structure for schema introspection.
 *
 * Extension authors may import Zod v3 (`npm:zod@3`) or Zod v4 (`npm:zod@4`).
 * The two versions name the type field differently (`typeName` in v3,
 * `type` in v4) and store object shape differently (`shape()` function in
 * v3, `shape` value in v4). Both fields are read here so the helpers work
 * regardless of which Zod version the extension imports.
 */
interface ZodDef {
  type?: string;
  typeName?: string;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  shape?: Record<string, z.ZodTypeAny> | (() => Record<string, z.ZodTypeAny>);
}

/**
 * Gets the internal definition from a Zod schema.
 */
function getSchemaDef(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

/**
 * Returns a normalized type name ("object", "optional", "effects", ...) for
 * a Zod schema. Maps Zod v3 typeName values (e.g. "ZodObject") to Zod v4
 * type values (e.g. "object").
 */
function getSchemaType(schema: z.ZodTypeAny): string {
  const def = getSchemaDef(schema);
  if (!def) return "";
  if (def.type) return def.type;
  if (def.typeName) {
    return def.typeName.replace(/^Zod/, "").toLowerCase();
  }
  return "";
}

/**
 * Returns the field shape of a ZodObject, accepting both Zod v3 (where
 * `_def.shape` is a function) and Zod v4 (where `_def.shape` is a value).
 */
function readShape(def: ZodDef): Record<string, z.ZodTypeAny> | undefined {
  if (typeof def.shape === "function") return def.shape();
  return def.shape;
}

/**
 * Unwraps optional, nullable, default, and effects wrappers to get the leaf type.
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
 * Coerces string values in `args` to match the expected types in a Zod object schema.
 *
 * When CLI flags like `--input key=true` are parsed, all values arrive as strings.
 * This function converts `"true"`/`"false"` to booleans and numeric strings to numbers
 * so that Zod validation succeeds.
 *
 * Non-string values and strings that don't match a known coercion pass through unchanged.
 * Keys not present in the schema are also passed through unchanged (Zod will handle them).
 */
export function coerceMethodArgs(
  args: Record<string, unknown>,
  zodSchema: z.ZodTypeAny,
): Record<string, unknown> {
  // Unwrap wrappers to find the object shape
  const unwrapped = unwrapSchema(zodSchema);
  const schemaType = getSchemaType(unwrapped);

  if (schemaType !== "object") {
    return args;
  }

  const def = getSchemaDef(unwrapped);
  const shape = readShape(def);
  if (!shape) {
    return args;
  }

  const result: Record<string, unknown> = { ...args };

  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== "string") {
      continue;
    }

    const fieldSchema = shape[key];
    if (!fieldSchema) {
      continue;
    }

    const leafType = getSchemaType(unwrapSchema(fieldSchema));

    if (leafType === "boolean") {
      if (value === "true") {
        result[key] = true;
      } else if (value === "false") {
        result[key] = false;
      }
    } else if (leafType === "number") {
      const num = Number(value);
      if (!Number.isNaN(num)) {
        result[key] = num;
      }
    }
  }

  return result;
}

/**
 * Returns the field shape of the inner ZodObject for a schema, unwrapping
 * optional/nullable/default/effects wrappers. Returns undefined when the
 * schema does not resolve to a ZodObject (e.g. a primitive or a union).
 *
 * Used to detect unknown keys passed via CLI flags before Zod's default
 * strip mode silently discards them.
 */
export function getObjectShape(
  schema: z.ZodTypeAny,
): Record<string, z.ZodTypeAny> | undefined {
  const unwrapped = unwrapSchema(schema);
  if (getSchemaType(unwrapped) !== "object") {
    return undefined;
  }
  return readShape(getSchemaDef(unwrapped));
}
