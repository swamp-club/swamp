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

import type { z } from "zod";

/**
 * Internal Zod v4 definition structure for schema introspection.
 */
interface ZodDef {
  type: string;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  shape?: Record<string, z.ZodTypeAny>;
}

/**
 * Gets the internal definition from a Zod schema.
 */
function getSchemaDef(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

/**
 * Gets the definition type string from a Zod schema.
 */
function getSchemaType(schema: z.ZodTypeAny): string {
  return getSchemaDef(schema)?.type ?? "";
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
  if (!def.shape) {
    return args;
  }

  const result: Record<string, unknown> = { ...args };

  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== "string") {
      continue;
    }

    const fieldSchema = def.shape[key];
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
