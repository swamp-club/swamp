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
import { findClosestMatch } from "../string_distance.ts";

export interface PathValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
  availableKeys?: string[];
}

/**
 * relies on Zod's internal _def structure, which is not public API and may need
 * updating if Zod changes it
 */
interface ZodDef {
  type: string;
  innerType?: z.ZodTypeAny;
  element?: z.ZodTypeAny;
  shape?: Record<string, z.ZodTypeAny>;
  valueType?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  schema?: z.ZodTypeAny;
}

function getSchemaType(schema: z.ZodTypeAny): string {
  const def = (schema as unknown as { _def: ZodDef })._def;
  return def?.type ?? "";
}

function getSchemaDef(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function getObjectKeys(schema: z.ZodTypeAny): string[] | null {
  const unwrapped = unwrapSchema(schema);
  const schemaType = getSchemaType(unwrapped);
  if (schemaType === "object") {
    const def = getSchemaDef(unwrapped);
    return def.shape ? Object.keys(def.shape) : null;
  }
  return null;
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

function getArrayElement(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  const unwrapped = unwrapSchema(schema);
  const schemaType = getSchemaType(unwrapped);
  if (schemaType === "array") {
    const def = getSchemaDef(unwrapped);
    return def.element ?? null;
  }
  return null;
}

function getObjectProperty(
  schema: z.ZodTypeAny,
  key: string,
): z.ZodTypeAny | null {
  const unwrapped = unwrapSchema(schema);
  const schemaType = getSchemaType(unwrapped);
  const def = getSchemaDef(unwrapped);

  if (schemaType === "object" && def.shape) {
    if (key in def.shape) {
      return def.shape[key];
    }
    return null;
  }

  if (schemaType === "record" && def.valueType) {
    return def.valueType;
  }

  const unionTypes = ["union", "discriminatedUnion"];
  if (unionTypes.includes(schemaType) && def.options) {
    for (const option of def.options) {
      const result = getObjectProperty(option, key);
      if (result) return result;
    }
  }

  return null;
}

export function validateSchemaPath(
  schema: z.ZodTypeAny,
  path: string[],
): PathValidationResult {
  if (path.length === 0) {
    return { valid: true };
  }

  let currentSchema = schema;
  const visitedPath: string[] = [];

  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    const unwrapped = unwrapSchema(currentSchema);

    const isArrayIndex = /^\d+$/.test(segment);

    if (isArrayIndex) {
      const elementSchema = getArrayElement(unwrapped);
      if (!elementSchema) {
        return {
          valid: false,
          error:
            `Cannot use array index [${segment}] on non-array type at path "${
              visitedPath.join(".")
            }"`,
        };
      }
      currentSchema = elementSchema;
      visitedPath.push(`[${segment}]`);
    } else {
      const propertySchema = getObjectProperty(unwrapped, segment);

      if (!propertySchema) {
        const availableKeys = getObjectKeys(unwrapped);
        const suggestion = availableKeys
          ? findClosestMatch(segment, availableKeys)
          : undefined;

        const pathSoFar = visitedPath.length > 0 ? visitedPath.join(".") : "";
        const location = pathSoFar ? ` at path "${pathSoFar}"` : "";

        return {
          valid: false,
          error: `Property "${segment}" not found${location}`,
          suggestion: suggestion
            ? `Did you mean "${suggestion}" instead of "${segment}"?`
            : undefined,
          availableKeys: availableKeys ?? undefined,
        };
      }

      currentSchema = propertySchema;
      visitedPath.push(segment);
    }
  }

  return { valid: true };
}

export function formatAvailableKeys(keys: string[], maxKeys = 5): string {
  if (keys.length === 0) return "";

  const sortedKeys = [...keys].sort();
  if (sortedKeys.length <= maxKeys) {
    return sortedKeys.join(", ");
  }

  const shown = sortedKeys.slice(0, maxKeys);
  const remaining = sortedKeys.length - maxKeys;
  return `${shown.join(", ")}, ... (${remaining} more)`;
}
