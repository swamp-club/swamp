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
import { argumentParseContext } from "../untrusted_parse.ts";

/**
 * extensions must use Zod v4; the v3 field variants stay for already-installed
 * extensions bundled before the v3 gate
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
 * a key a parse reports that is in neither this set nor the input came from the
 * schema's own code, which may have built it from a value
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

function getSchemaDef(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function getSchemaType(schema: z.ZodTypeAny): string {
  const def = getSchemaDef(schema);
  if (!def) return "";
  if (def.type) return def.type;
  if (def.typeName) {
    return def.typeName.replace(/^Zod/, "").toLowerCase();
  }
  return "";
}

function readShape(def: ZodDef): Record<string, z.ZodTypeAny> | undefined {
  if (typeof def.shape === "function") return def.shape();
  return def.shape;
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

export function coerceMethodArgs(
  args: Record<string, unknown>,
  zodSchema: z.ZodTypeAny,
): Record<string, unknown> {
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
 * used to detect unknown keys passed via CLI flags before Zod's default strip
 * mode silently discards them
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
 * checks a key without parsing values or running transforms; composite schemas
 * and catchalls accept keys a single object shape cannot list
 */
export function acceptsMethodArgumentKey(
  schema: z.ZodTypeAny,
  key: string,
): boolean {
  const seen = new Set<z.ZodTypeAny>();
  const visit = (current: z.ZodTypeAny | undefined): boolean => {
    if (!current) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const def = getSchemaDef(current);
    switch (getSchemaType(current)) {
      case "object":
        return Object.hasOwn(readShape(def) ?? {}, key) ||
          (def.catchall !== undefined &&
            getSchemaType(def.catchall) !== "never");
      case "record":
      case "any":
      case "unknown":
        return true;
      case "union":
      case "discriminatedunion":
        return def.options?.some(visit) ?? true;
      case "intersection":
        return visit(def.left) || visit(def.right);
      case "effects":
        return visit(def.schema);
      case "pipe":
        // A preprocessor accepts arbitrary input; its output shape cannot
        // tell us which input keys it reads.
        return def.in && getSchemaType(def.in) === "transform"
          ? true
          : visit(def.in);
      case "lazy":
        return visit(def.getter?.());
      default:
        // Opaque schemas can accept an object without describing its keys.
        // Only omit keys an inspected object shape is known not to accept.
        return visit(def.innerType);
    }
  };
  return visit(schema);
}

export type LenientParseResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; issues: z.ZodIssue[] };

/**
 * Zod v4 throws from partial() on object schemas that carry refinements, which
 * is the refused answer; a schema without partial() is none
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
 * drops issues rooted at a missing key; parses the raw values since a
 * transformed field would not parse twice; async refinements cannot run
 * synchronously, so they report nothing
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
    // every issue, not stopping at the first: issues at missing keys are
    // dropped below, so stopping early could hide a failing present key; runs
    // only after every field passed
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
 * checks only provided fields and applies defaults; skipKeys (unresolved
 * expressions) are neither parsed nor returned; issues carry the failing input
 * so callers can register sensitive echoes first
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
      const result = fieldSchema.safeParse(
        present ? input[key] : undefined,
        argumentParseContext(),
      );
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
    argumentParseContext(),
  );
  if (!result.success) {
    return { success: false, issues: result.error.issues };
  }
  if (
    typeof result.data !== "object" || result.data === null ||
    Array.isArray(result.data)
  ) {
    // global arguments are a record: a scalar, null or array result is refused,
    // naming the shape and never the value, since spreading a string would
    // store one character per key
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

export function isRecordSchema(schema: z.ZodTypeAny): boolean {
  const unwrapped = unwrapSchema(schema);
  return getSchemaType(unwrapped) === "record";
}
