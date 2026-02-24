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

import { z } from "zod";

/**
 * Information about a sensitive field extracted from a Zod schema.
 */
export interface SensitiveFieldInfo {
  /** Dot-separated path to the field (e.g., "credentials.apiKey") */
  path: string;
  /** Optional vault name override from field metadata */
  vaultName?: string;
  /** Optional vault key override from field metadata */
  vaultKey?: string;
}

/**
 * Metadata shape expected on sensitive fields.
 */
interface SensitiveMetadata {
  sensitive?: boolean;
  vaultName?: string;
  vaultKey?: string;
}

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
 * Unwraps optional, nullable, default, and effects wrappers to get the underlying schema.
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
 * Checks metadata on a schema at multiple levels (before and after unwrapping).
 * Handles both `.meta().optional()` and `.optional().meta()` orderings.
 */
function getSensitiveMetadata(
  schema: z.ZodTypeAny,
): SensitiveMetadata | undefined {
  // Check metadata on the outer schema (handles `.optional().meta()`)
  const outerMeta = z.globalRegistry.get(schema) as
    | SensitiveMetadata
    | undefined;
  if (outerMeta?.sensitive) {
    return outerMeta;
  }

  // Check at each unwrap level (handles `.meta().optional()`)
  let current = schema;
  while (true) {
    const schemaType = getSchemaType(current);
    const def = getSchemaDef(current);

    const wrapperTypes = ["optional", "nullable", "default"];
    if (wrapperTypes.includes(schemaType) && def.innerType) {
      const innerMeta = z.globalRegistry.get(def.innerType) as
        | SensitiveMetadata
        | undefined;
      if (innerMeta?.sensitive) {
        return innerMeta;
      }
      current = def.innerType;
    } else if (schemaType === "effects" && def.schema) {
      const innerMeta = z.globalRegistry.get(def.schema) as
        | SensitiveMetadata
        | undefined;
      if (innerMeta?.sensitive) {
        return innerMeta;
      }
      current = def.schema;
    } else {
      break;
    }
  }

  return undefined;
}

/**
 * Extracts sensitive field information from a Zod schema.
 *
 * Walks the schema's object shape recursively, checking each field for
 * `{ sensitive: true }` metadata via `z.globalRegistry`. Handles both
 * `.meta().optional()` and `.optional().meta()` orderings.
 *
 * @param schema - A Zod schema (typically an object schema)
 * @param prefix - Path prefix for nested fields (used in recursion)
 * @returns Array of sensitive field info objects
 */
export function extractSensitiveFields(
  schema: z.ZodTypeAny,
  prefix = "",
): SensitiveFieldInfo[] {
  const unwrapped = unwrapSchema(schema);
  const schemaType = getSchemaType(unwrapped);

  if (schemaType !== "object") {
    return [];
  }

  const def = getSchemaDef(unwrapped);
  if (!def.shape) {
    return [];
  }

  const results: SensitiveFieldInfo[] = [];

  for (const [key, fieldSchema] of Object.entries(def.shape)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;

    // Check if this field has sensitive metadata
    const meta = getSensitiveMetadata(fieldSchema);
    if (meta?.sensitive) {
      results.push({
        path: fieldPath,
        vaultName: meta.vaultName,
        vaultKey: meta.vaultKey,
      });
    }

    // Recurse into nested objects
    const unwrappedField = unwrapSchema(fieldSchema);
    if (getSchemaType(unwrappedField) === "object") {
      results.push(...extractSensitiveFields(unwrappedField, fieldPath));
    }
  }

  return results;
}

/**
 * Gets a nested value from an object by dot-separated path.
 */
export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (
      current === null || current === undefined || typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Sets a nested value in an object by dot-separated path.
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      !(part in current) || current[part] === null ||
      typeof current[part] !== "object"
    ) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
