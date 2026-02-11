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
 * Result of validating a path against a Zod schema.
 */
export interface PathValidationResult {
  /** Whether the path is valid in the schema */
  valid: boolean;
  /** Error message if the path is invalid */
  error?: string;
  /** Suggestion for fixing the error (e.g., "Did you mean 'resource' instead of 'resources'?") */
  suggestion?: string;
  /** Available keys at the point where validation failed */
  availableKeys?: string[];
}

/**
 * Internal type for Zod v4 schema definition.
 *
 * Note: This relies on Zod's internal `_def` structure which is not part of
 * the public API. If Zod changes its internal structure in future versions,
 * this interface and the functions that use it may need to be updated.
 * See: https://github.com/colinhacks/zod
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

/**
 * Computes Levenshtein distance between two strings for typo detection.
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1, // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Finds the closest match to a key among available keys.
 */
function findClosestKey(
  key: string,
  availableKeys: string[],
): string | undefined {
  if (availableKeys.length === 0) return undefined;

  let closest: string | undefined;
  let minDistance = Infinity;
  const threshold = Math.max(2, Math.floor(key.length / 2));

  for (const available of availableKeys) {
    const distance = levenshteinDistance(
      key.toLowerCase(),
      available.toLowerCase(),
    );
    if (distance < minDistance && distance <= threshold) {
      minDistance = distance;
      closest = available;
    }
  }

  return closest;
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
 * Gets the keys from a Zod object schema.
 */
function getObjectKeys(schema: z.ZodTypeAny): string[] | null {
  const unwrapped = unwrapSchema(schema);
  const schemaType = getSchemaType(unwrapped);
  if (schemaType === "object") {
    const def = getSchemaDef(unwrapped);
    return def.shape ? Object.keys(def.shape) : null;
  }
  return null;
}

/**
 * Unwraps optional, nullable, and other wrapper types to get the underlying schema.
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
 * Gets the element schema from an array type.
 */
function getArrayElement(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  const unwrapped = unwrapSchema(schema);
  const schemaType = getSchemaType(unwrapped);
  if (schemaType === "array") {
    const def = getSchemaDef(unwrapped);
    return def.element ?? null;
  }
  return null;
}

/**
 * Gets the property schema from an object by key.
 */
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
    // Records allow any string key
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

/**
 * Validates a path against a Zod schema.
 *
 * @param schema - The Zod schema to validate against
 * @param path - The path segments to validate (e.g., ["attributes", "VpcId"])
 * @returns Validation result with error details if invalid
 */
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

    // Check if segment is an array index
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
      // Property access
      const propertySchema = getObjectProperty(unwrapped, segment);

      if (!propertySchema) {
        const availableKeys = getObjectKeys(unwrapped);
        const suggestion = availableKeys
          ? findClosestKey(segment, availableKeys)
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

/**
 * Formats available keys into a readable string.
 *
 * @param keys - The keys to format
 * @param maxKeys - Maximum number of keys to show (default: 5)
 * @returns Formatted string of available keys
 */
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
