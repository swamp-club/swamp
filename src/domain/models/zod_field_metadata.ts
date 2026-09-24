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

/**
 * Metadata a model type attaches to a schema field with `.meta({...})`, read
 * back from `z.globalRegistry`.
 */
export type FieldMetadata = Record<string, unknown>;

/**
 * A schema field whose metadata matched, with its dot-separated path.
 */
export interface FieldWithMetadata {
  /** Dot-separated path to the field (e.g., "credentials.apiKey") */
  path: string;
  /** The metadata that matched */
  meta: FieldMetadata;
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
 * Finds the metadata on a field that satisfies `matches`, checking the schema
 * at multiple levels (before and after unwrapping). Handles both
 * `.meta().optional()` and `.optional().meta()` orderings.
 */
export function findFieldMetadata(
  schema: z.ZodTypeAny,
  matches: (meta: FieldMetadata) => boolean,
): FieldMetadata | undefined {
  // Check metadata on the outer schema (handles `.optional().meta()`)
  const outerMeta = z.globalRegistry.get(schema) as FieldMetadata | undefined;
  if (outerMeta && matches(outerMeta)) {
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
        | FieldMetadata
        | undefined;
      if (innerMeta && matches(innerMeta)) {
        return innerMeta;
      }
      current = def.innerType;
    } else if (schemaType === "effects" && def.schema) {
      const innerMeta = z.globalRegistry.get(def.schema) as
        | FieldMetadata
        | undefined;
      if (innerMeta && matches(innerMeta)) {
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
 * Extracts every field of a Zod object schema whose metadata satisfies
 * `matches`.
 *
 * Walks the schema's object shape recursively. Fields nested inside
 * non-object schemas (records, arrays, unions) are not visited, and a schema
 * wrapped in `.transform()` is not unwrapped, so metadata must sit on the
 * field itself.
 *
 * @param schema - A Zod schema (typically an object schema)
 * @param matches - Decides whether a field's metadata marks it
 * @param prefix - Path prefix for nested fields (used in recursion)
 * @returns The matching fields with their metadata
 */
export function extractFieldsWithMetadata(
  schema: z.ZodTypeAny,
  matches: (meta: FieldMetadata) => boolean,
  prefix = "",
): FieldWithMetadata[] {
  const unwrapped = unwrapSchema(schema);
  const schemaType = getSchemaType(unwrapped);

  if (schemaType !== "object") {
    return [];
  }

  const def = getSchemaDef(unwrapped);
  if (!def.shape) {
    return [];
  }

  const results: FieldWithMetadata[] = [];

  for (const [key, fieldSchema] of Object.entries(def.shape)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;

    const meta = findFieldMetadata(fieldSchema, matches);
    if (meta) {
      results.push({ path: fieldPath, meta });
    }

    // Recurse into nested objects
    const unwrappedField = unwrapSchema(fieldSchema);
    if (getSchemaType(unwrappedField) === "object") {
      results.push(
        ...extractFieldsWithMetadata(unwrappedField, matches, fieldPath),
      );
    }
  }

  return results;
}
