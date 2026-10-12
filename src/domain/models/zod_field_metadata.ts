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
  element?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  discriminator?: string;
  items?: z.ZodTypeAny[];
  rest?: z.ZodTypeAny | null;
  left?: z.ZodTypeAny;
  right?: z.ZodTypeAny;
  getter?: () => z.ZodTypeAny;
  in?: z.ZodTypeAny;
  out?: z.ZodTypeAny;
  values?: unknown[];
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

/**
 * A value found under a schema node whose metadata matched, with its path.
 */
export interface ValueWithMetadata {
  /**
   * Path to the value (e.g., "credentials.apiKey", "users[0].password",
   * `accounts["eu.west"].token`)
   */
  path: string;
  /** The value found at that path */
  value: unknown;
  /** The metadata that matched */
  meta: FieldMetadata;
  /**
   * Whether the value sits inside an array element, tuple item or record
   * value, and so occurs once per element rather than once per schema.
   */
  perElement: boolean;
}

/** Wrapper schema types that hold the wrapped schema in `innerType`. */
const INNER_TYPE_WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "readonly",
  "catch",
  "prefault",
  "nonoptional",
]);

/**
 * Appends a key to a path. A key made of letters, digits, `_` and `-` is
 * joined with a dot; any other key is written as a quoted, escaped index
 * (`accounts["eu.west"]`), so a path names exactly one place in a value and a
 * `[0]` segment is always an array index.
 */
function appendKey(path: string, key: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    return `${path}[${JSON.stringify(key)}]`;
  }
  return path ? `${path}.${key}` : key;
}

/**
 * Returns the schema one wrapper level down, or undefined when `schema` is
 * not a wrapper. A pipe yields the side that describes the input value: the
 * source of a `.transform()`, the target of a `z.preprocess()`.
 */
function innerSchema(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const schemaType = getSchemaType(schema);
  const def = getSchemaDef(schema);

  if (INNER_TYPE_WRAPPERS.has(schemaType)) {
    return def.innerType;
  }
  if (schemaType === "effects") {
    return def.schema;
  }
  if (schemaType === "lazy") {
    // Zod resolves the getter once and keeps the result; calling the getter
    // here would build the schema again on every visit.
    return (schema as unknown as { _zod?: { innerType?: z.ZodTypeAny } })._zod
      ?.innerType ?? def.getter?.();
  }
  if (schemaType === "pipe") {
    return def.in && getSchemaType(def.in) === "transform" ? def.out : def.in;
  }
  return undefined;
}

/**
 * Reads a schema's registered metadata. A schema this Zod did not build (one
 * from an extension's own Zod v3, say) has none, and the registry throws on
 * it, so it is answered as having no metadata.
 */
function readMetadata(schema: z.ZodTypeAny): FieldMetadata | undefined {
  if (!(schema as { _zod?: unknown })?._zod) {
    return undefined;
  }
  return z.globalRegistry.get(schema) as FieldMetadata | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

/** Follows wrappers down to the schema that describes the value itself. */
function coreSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (let inner = innerSchema(current); inner; inner = innerSchema(current)) {
    current = inner;
  }
  return current;
}

const SCALAR_TYPES = [
  "string",
  "number",
  "boolean",
  "bigint",
  "literal",
  "enum",
  "template_literal",
];

/**
 * Reports whether a value has the container kind a union member describes: an
 * object for an object or record, an array for an array or tuple, neither for
 * a scalar. A member of any other type is taken to fit every value.
 */
function fitsShape(member: z.ZodTypeAny, value: unknown): boolean {
  const memberType = getSchemaType(coreSchema(member));
  if (memberType === "object" || memberType === "record") {
    return isPlainObject(value);
  }
  if (memberType === "array" || memberType === "tuple") {
    return Array.isArray(value);
  }
  if (SCALAR_TYPES.includes(memberType)) {
    return typeof value !== "object";
  }
  return true;
}

/**
 * Picks the members of a union a value can belong to, without running any
 * member's validation. Members whose container kind the value does not have
 * are dropped, and a discriminated union is narrowed by the value's
 * discriminator when that names members exactly. Every other case keeps the
 * member, so a field one member marks is never missed because another member
 * also accepts the value.
 */
function unionMembers(def: ZodDef, value: unknown): z.ZodTypeAny[] {
  const all = def.options ?? [];
  const fitting = all.filter((option) => fitsShape(option, value));
  const options = fitting.length > 0 ? fitting : all;
  if (!def.discriminator || !isPlainObject(value)) {
    return options;
  }
  const tag = value[def.discriminator];
  const tagged: z.ZodTypeAny[] = [];
  for (const option of options) {
    const optionDef = getSchemaDef(unwrapSchema(option));
    const tagSchema = optionDef?.shape?.[def.discriminator];
    const tagDef = tagSchema
      ? getSchemaDef(unwrapSchema(tagSchema))
      : undefined;
    if (tagDef?.type !== "literal" || !tagDef.values) {
      return options;
    }
    if (tagDef.values.includes(tag)) {
      tagged.push(option);
    }
  }
  return tagged.length > 0 ? tagged : options;
}

/** State carried through one {@link findValuesWithMetadata} walk. */
interface ValueWalk {
  matches: (meta: FieldMetadata) => boolean;
  found: ValueWithMetadata[];
  /** Paths already in `found`. */
  foundPaths: Set<string>;
  /** Containers on the way down to the current value, to stop on a cycle. */
  ancestors: Set<object>;
}

function visitValue(
  walk: ValueWalk,
  schema: z.ZodTypeAny,
  value: unknown,
  path: string,
  perElement: boolean,
  atRoot = false,
): void {
  if (value === undefined || value === null) {
    return;
  }

  let current = schema;
  let reported = atRoot;
  while (true) {
    const meta = readMetadata(current);
    if (!reported && meta && walk.matches(meta)) {
      // Union and intersection members revisit one value. A path names one
      // place in the value, so a path seen before is that same value.
      if (!walk.foundPaths.has(path)) {
        walk.foundPaths.add(path);
        walk.found.push({ path, value, meta, perElement });
      }
      reported = true;
    }
    const inner = innerSchema(current);
    if (!inner) {
      break;
    }
    current = inner;
  }

  const schemaType = getSchemaType(current);
  const def = getSchemaDef(current);
  const child = (key: string) => appendKey(path, key);

  if (schemaType === "union") {
    for (const option of unionMembers(def, value)) {
      visitValue(walk, option, value, path, perElement, atRoot);
    }
    return;
  }
  if (schemaType === "intersection") {
    for (const side of [def.left, def.right]) {
      if (side) {
        visitValue(walk, side, value, path, perElement, atRoot);
      }
    }
    return;
  }
  if (typeof value !== "object" || walk.ancestors.has(value)) {
    return;
  }

  walk.ancestors.add(value);
  if (schemaType === "object" && isPlainObject(value)) {
    for (const [key, fieldSchema] of Object.entries(def.shape ?? {})) {
      visitValue(walk, fieldSchema, value[key], child(key), perElement);
    }
  } else if (schemaType === "record" && isPlainObject(value)) {
    const valueSchema = def.valueType;
    if (valueSchema) {
      for (const [key, entry] of Object.entries(value)) {
        visitValue(walk, valueSchema, entry, child(key), true);
      }
    }
  } else if (schemaType === "array" && Array.isArray(value)) {
    const elementSchema = def.element;
    if (elementSchema) {
      value.forEach((element, index) =>
        visitValue(walk, elementSchema, element, `${path}[${index}]`, true)
      );
    }
  } else if (schemaType === "tuple" && Array.isArray(value)) {
    value.forEach((element, index) => {
      const itemSchema = def.items?.[index] ?? def.rest;
      if (itemSchema) {
        visitValue(walk, itemSchema, element, `${path}[${index}]`, true);
      }
    });
  }
  walk.ancestors.delete(value);
}

/**
 * Finds every value in `value` that sits under a schema node whose metadata
 * satisfies `matches`.
 *
 * Unlike {@link extractFieldsWithMetadata}, which reads the schema alone and
 * stops at anything that is not an object, this walks the schema and a
 * concrete value together, so it also reaches fields inside array elements
 * and tuple items (`users[0].password`), record values (`labels.team`),
 * union members and intersections, and through `.transform()`, `.readonly()`
 * and `z.lazy()` wrappers. A matching node is reported once, and its children
 * are still visited. Metadata on the root schema itself is not reported.
 *
 * The walk follows the value, so it visits at most what the value holds and
 * ends on a recursive schema; a value that contains itself is not entered
 * twice. Each path names one place in the value: a key holding anything but
 * letters, digits, `_` and `-` is written quoted (`accounts["eu.west"]`), so
 * it cannot be mistaken for nesting or for an array index.
 *
 * @param schema - A Zod schema (typically an object schema)
 * @param value - The value the schema describes
 * @param matches - Decides whether a node's metadata marks it
 * @returns The matching values with their paths and metadata, in visit order
 */
export function findValuesWithMetadata(
  schema: z.ZodTypeAny,
  value: unknown,
  matches: (meta: FieldMetadata) => boolean,
): ValueWithMetadata[] {
  const walk: ValueWalk = {
    matches,
    found: [],
    foundPaths: new Set(),
    ancestors: new Set(),
  };
  visitValue(walk, schema, value, "", false, true);
  return walk.found;
}
