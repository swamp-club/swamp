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
 * Extensions must use Zod v4 — v3 imports are rejected at bundle time.
 * The v3 field variants (`typeName`, `shape` as function) are retained
 * here for backwards compatibility with already-installed extensions
 * that were bundled before the v3 gate was added.
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
    } else if (leafType === "array") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          result[key] = parsed;
        }
      } catch {
        // Not valid JSON — leave as string for downstream validation
      }
    } else if (leafType === "object") {
      try {
        const parsed = JSON.parse(value);
        if (
          typeof parsed === "object" && parsed !== null &&
          !Array.isArray(parsed)
        ) {
          result[key] = parsed;
        }
      } catch {
        // Not valid JSON — leave as string for downstream validation
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

/**
 * Result of {@link parseGlobalArgumentsLeniently}: the parsed values on
 * success, or the Zod issues (with paths rooted at the global argument key).
 */
export type LenientParseResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; issues: z.ZodIssue[] };

/**
 * Returns the schema's `.partial()` form, "none" when the schema has no
 * `.partial()` (e.g. a transform), or "refused" when calling it throws — Zod
 * v4 throws for object schemas that carry refinements.
 */
function tryPartial(schema: z.ZodTypeAny): z.ZodTypeAny | "none" | "refused" {
  if (!("partial" in schema) || typeof schema.partial !== "function") {
    return "none";
  }
  try {
    return schema.partial() as z.ZodTypeAny;
  } catch {
    return "refused";
  }
}

/**
 * Validates global arguments against a model's schema without requiring the
 * fields that are missing: provided fields are checked and missing fields get
 * their Zod defaults.
 *
 * - A schema that supports `.partial()` is parsed with its partial form.
 * - An object schema whose `.partial()` throws (a Zod v4 object with
 *   refinements) is parsed field by field against its shape; object-level
 *   refinements do not run, since the object may be incomplete.
 * - Any other schema (no `.partial()`, e.g. a transform) is parsed as-is,
 *   unless keys are skipped: it cannot check an incomplete object, so the
 *   input is returned unchecked.
 *
 * Keys in `skipKeys` (global arguments holding an unresolved expression) are
 * neither parsed nor returned, so a default can never replace them.
 */
export function parseGlobalArgumentsLeniently(
  schema: z.ZodTypeAny,
  args: Record<string, unknown>,
  skipKeys: ReadonlySet<string> = new Set(),
): LenientParseResult {
  // fromEntries defines own properties, so a "__proto__" key stays a key.
  const input: Record<string, unknown> = Object.fromEntries(
    Object.entries(args).filter(([key]) => !skipKeys.has(key)),
  );

  const partial = tryPartial(schema);
  const shape = partial === "refused" ? getObjectShape(schema) : undefined;
  if (shape) {
    const data: Record<string, unknown> = {};
    const issues: z.ZodIssue[] = [];
    for (const [key, fieldSchema] of Object.entries(shape)) {
      if (skipKeys.has(key)) continue;
      const present = Object.hasOwn(input, key);
      const result = fieldSchema.safeParse(present ? input[key] : undefined);
      if (result.success) {
        if (present || result.data !== undefined) data[key] = result.data;
      } else if (present) {
        for (const issue of result.error.issues) {
          issues.push({ ...issue, path: [key, ...issue.path] } as z.ZodIssue);
        }
      }
    }
    return issues.length > 0
      ? { success: false, issues }
      : { success: true, data };
  }

  if (typeof partial === "string" && skipKeys.size > 0) {
    // Without a partial or per-field form, the schema can only check a
    // complete object, so a subset passes through unchecked.
    return { success: true, data: input };
  }
  const result = (typeof partial === "string" ? schema : partial).safeParse(
    input,
  );
  if (!result.success) {
    return { success: false, issues: result.error.issues };
  }
  const data = { ...(result.data as Record<string, unknown>) };
  for (const key of skipKeys) delete data[key];
  return { success: true, data };
}

/**
 * Returns true when the schema (after unwrapping optional/nullable/default/
 * effects wrappers) resolves to a ZodRecord. Record schemas accept arbitrary
 * string keys, so key-based routing and unknown-key checks don't apply.
 */
export function isRecordSchema(schema: z.ZodTypeAny): boolean {
  const unwrapped = unwrapSchema(schema);
  return getSchemaType(unwrapped) === "record";
}
