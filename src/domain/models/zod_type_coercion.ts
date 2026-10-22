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
  catchall?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  left?: z.ZodTypeAny;
  right?: z.ZodTypeAny;
  in?: z.ZodTypeAny;
  out?: z.ZodTypeAny;
  getter?: () => z.ZodTypeAny;
  element?: z.ZodTypeAny;
  keyType?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  items?: z.ZodTypeAny[];
  rest?: z.ZodTypeAny | null;
}

/** A transform can change how raw globals contribute to method arguments. */
export function schemaTransformsValues(schema: z.ZodTypeAny): boolean {
  const seen = new Set<z.ZodTypeAny>();
  const visit = (current: z.ZodTypeAny | null | undefined): boolean => {
    if (!current || seen.has(current)) return false;
    seen.add(current);
    const def = getSchemaDef(current);
    const type = getSchemaType(current);
    if (type === "pipe" || type === "transform" || type === "effects") {
      return true;
    }
    return [
      def.innerType,
      def.schema,
      def.left,
      def.right,
      def.element,
      def.keyType,
      def.valueType,
      def.rest,
      def.catchall,
      ...(def.options ?? []),
      ...(def.items ?? []),
      ...Object.values(readShape(def) ?? {}),
      type === "lazy" ? def.getter?.() : undefined,
    ].some(visit);
  };
  return visit(schema);
}

/**
 * Every object key `schema` declares, at any depth: the keys of each object
 * shape reachable through wrappers, array elements, tuple items, record
 * values, union and intersection members, lazy schemas and both sides of a
 * pipe. A key a parse reports that neither this set nor the input spells
 * came from the schema's own code, which may have made it from a value
 * (swamp-club#3681).
 */
export function schemaDeclaredKeys(schema: z.ZodTypeAny): Set<string> {
  const keys = new Set<string>();
  const seen = new Set<z.ZodTypeAny>();
  const visit = (current: z.ZodTypeAny | null | undefined): void => {
    if (!current || seen.has(current)) return;
    seen.add(current);
    const def = getSchemaDef(current);
    if (!def) return;
    const shape = readShape(def) ?? {};
    for (const key of Object.keys(shape)) keys.add(key);
    const lazy = getSchemaType(current) === "lazy"
      ? (current as unknown as { _zod?: { innerType?: z.ZodTypeAny } })._zod
        ?.innerType ?? def.getter?.()
      : undefined;
    for (
      const next of [
        def.innerType,
        def.schema,
        def.left,
        def.right,
        def.in,
        def.out,
        def.element,
        def.keyType,
        def.valueType,
        def.rest,
        def.catchall,
        ...(def.options ?? []),
        ...(def.items ?? []),
        ...Object.values(shape),
        lazy,
      ]
    ) visit(next);
  };
  visit(schema);
  return keys;
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
 * This function converts `"true"`/`"false"` to booleans and numeric strings to numbers,
 * and JSON-parses strings for array, object and record fields, so that Zod validation
 * succeeds.
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
    } else if (leafType === "object" || leafType === "record") {
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
 * Runs the whole schema over the raw values of the shape's keys and returns
 * its issues, leaving out every issue rooted at a `missing` key: a field that
 * is absent and fails on its own, which the lenient check does not require.
 * Issues at the root, at a present key or at an absent optional key are kept,
 * so a refinement's own issues are reported. The raw values are parsed, not
 * the field outputs, since a transformed field would not parse a second time.
 * A schema whose refinements are async cannot be checked by a synchronous
 * parse, so it reports nothing.
 */
function objectRefinementIssues(
  schema: z.ZodTypeAny,
  input: Record<string, unknown>,
  shape: Record<string, unknown>,
  missing: ReadonlySet<PropertyKey>,
): z.ZodIssue[] {
  const raw: Record<string, unknown> = Object.fromEntries(
    Object.entries(input).filter(([key]) => Object.hasOwn(shape, key)),
  );
  let result;
  try {
    result = schema.safeParse(raw, { reportInput: true });
  } catch (error) {
    if (error instanceof z.core.$ZodAsyncError) return [];
    throw error;
  }
  if (result.success) return [];
  return result.error.issues.filter((issue) =>
    issue.path.length === 0 || !missing.has(issue.path[0])
  );
}

/**
 * Validates global arguments against a model's schema without requiring the
 * fields that are missing: provided fields are checked and missing fields get
 * their Zod defaults.
 *
 * - A schema that supports `.partial()` is parsed with its partial form.
 * - An object schema whose `.partial()` throws (a Zod v4 object with
 *   refinements) is parsed field by field against its shape. When every field
 *   passes and no key is skipped, the whole schema then runs over the input,
 *   so object-level refinements are enforced. Zod skips them while a
 *   required field is missing, so an incomplete object is not refined.
 * - Any other schema (no `.partial()`, e.g. a transform) is parsed as-is,
 *   unless keys are skipped: it cannot check an incomplete object, so the
 *   input is returned unchecked.
 *
 * Keys in `skipKeys` (global arguments holding an unresolved expression) are
 * neither parsed nor returned, so a default can never replace them.
 *
 * Every issue carries the `input` the failing check received, which under a
 * transform is what the transform made of the value, so a caller can
 * register what a sensitive field's refusal may echo before it reports it
 * (swamp-club#3681). A parse that delivers a scalar, null or an array is
 * refused with a value-free issue: global arguments are a record.
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
    const missing = new Set<string>();
    for (const [key, fieldSchema] of Object.entries(shape)) {
      if (skipKeys.has(key)) continue;
      const present = Object.hasOwn(input, key);
      const result = fieldSchema.safeParse(present ? input[key] : undefined, {
        reportInput: true,
      });
      if (result.success) {
        if (present || result.data !== undefined) data[key] = result.data;
      } else if (present) {
        for (const issue of result.error.issues) {
          issues.push({ ...issue, path: [key, ...issue.path] } as z.ZodIssue);
        }
      } else {
        missing.add(key);
      }
    }
    // Refinements run only on an object whose fields all pass and none is
    // skipped: a failing field is reported alone, and a skipped one would make
    // a refinement see the field as missing.
    if (issues.length > 0) return { success: false, issues };
    if (skipKeys.size > 0) return { success: true, data };
    const refined = objectRefinementIssues(schema, input, shape, missing);
    return refined.length > 0
      ? { success: false, issues: refined }
      : { success: true, data };
  }

  if (typeof partial === "string" && skipKeys.size > 0) {
    // Without a partial or per-field form, the schema can only check a
    // complete object, so a subset passes through unchecked.
    return { success: true, data: input };
  }
  const result = (typeof partial === "string" ? schema : partial).safeParse(
    input,
    { reportInput: true },
  );
  if (!result.success) {
    return { success: false, issues: result.error.issues };
  }
  if (
    typeof result.data !== "object" || result.data === null ||
    Array.isArray(result.data)
  ) {
    // Global arguments are a record. A schema delivering a scalar, null or
    // an array cannot be stored as them, and spreading a string would store
    // it one character per key (swamp-club#3681). The refusal names the
    // shape, never the value. An instance is stored by its own properties.
    return {
      success: false,
      issues: [{
        code: "custom",
        path: [],
        message: `the global-arguments schema delivered ${
          describeShape(result.data)
        }, not an object`,
        input: undefined,
      } as z.ZodIssue],
    };
  }
  const data = { ...(result.data as Record<string, unknown>) };
  for (const key of skipKeys) delete data[key];
  return { success: true, data };
}

/** Names a value's kind, never its content. */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
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
