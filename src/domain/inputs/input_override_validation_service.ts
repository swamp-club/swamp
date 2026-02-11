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
 * Error details for an individual input override validation failure.
 */
export interface InputOverrideError {
  /** The input key that failed validation */
  key: string;
  /** Human-readable error message */
  message: string;
  /** Suggestion for fixing the error (e.g., typo correction) */
  suggestion?: string;
  /** Available valid keys, if applicable */
  availableKeys?: string[];
}

/**
 * Result of validating input overrides against a schema.
 */
export interface InputOverrideValidationResult {
  /** Whether all input overrides are valid */
  valid: boolean;
  /** List of validation errors */
  errors: InputOverrideError[];
}

/**
 * Internal type for Zod v4 schema definition.
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
 * Gets a human-readable type name from a Zod schema.
 */
function getTypeName(schema: z.ZodTypeAny): string {
  const unwrapped = unwrapSchema(schema);
  const schemaType = getSchemaType(unwrapped);

  switch (schemaType) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    case "literal": {
      const def = getSchemaDef(unwrapped);
      const value = (def as unknown as { value: unknown }).value;
      return typeof value;
    }
    case "enum":
      return "enum";
    case "union":
    case "discriminatedUnion":
      return "union";
    default:
      return schemaType || "unknown";
  }
}

/**
 * Domain service for validating input overrides against a model's Zod schema.
 *
 * This service ensures that:
 * 1. Input keys exist in the model's inputAttributesSchema
 * 2. Input values have the correct type for their corresponding schema field
 */
export class InputOverrideValidationService {
  /**
   * Validates input overrides against a model's schema.
   *
   * @param inputs - The input values to validate
   * @param schema - The Zod schema to validate against
   * @returns Validation result with any errors
   */
  validate(
    inputs: Record<string, unknown>,
    schema: z.ZodTypeAny,
  ): InputOverrideValidationResult {
    const errors: InputOverrideError[] = [];

    // Empty inputs are always valid
    if (Object.keys(inputs).length === 0) {
      return { valid: true, errors: [] };
    }

    // Get available keys from schema
    const availableKeys = getObjectKeys(schema);

    for (const [key, value] of Object.entries(inputs)) {
      // Check if key exists in schema
      const propertySchema = getObjectProperty(schema, key);

      if (!propertySchema) {
        const suggestion = availableKeys
          ? findClosestKey(key, availableKeys)
          : undefined;

        errors.push({
          key,
          message: `Unknown input key "${key}"`,
          suggestion: suggestion
            ? `Did you mean "${suggestion}" instead of "${key}"?`
            : undefined,
          availableKeys: availableKeys ?? undefined,
        });
        continue;
      }

      // Validate the value's type using safeParse
      const parseResult = propertySchema.safeParse(value);
      if (!parseResult.success) {
        const expectedType = getTypeName(propertySchema);
        const actualType = Array.isArray(value)
          ? "array"
          : value === null
          ? "null"
          : typeof value;

        // Extract more specific error message from Zod if available
        const zodIssue = parseResult.error.issues[0];
        const detailedMessage = zodIssue?.message
          ? zodIssue.message
          : `Expected ${expectedType}, got ${actualType}`;

        errors.push({
          key,
          message: `Invalid value for "${key}": ${detailedMessage}`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
