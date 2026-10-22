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
  items?: z.ZodTypeAny[];
  rest?: z.ZodTypeAny | null;
  left?: z.ZodTypeAny;
  right?: z.ZodTypeAny;
  getter?: () => z.ZodTypeAny;
  catchall?: z.ZodTypeAny;
  coerce?: boolean;
  entries?: Record<string, unknown>;
  in?: z.ZodTypeAny;
  out?: z.ZodTypeAny;
  values?: unknown[];
  /** The checks the schema runs once its own parse has passed. */
  checks?: { _zod?: { def?: ZodCheckDef } }[];
  /** A node-level error map, as `z.object({...}, { error })` sets it. */
  error?: unknown;
}

/** The definition of a check a schema runs after its own parse. */
interface ZodCheckDef {
  check?: string;
  /** Set by `.refine()`, whose function only answers yes or no. */
  fn?: unknown;
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
  /**
   * The same place as `path`, as the object keys and array indexes that lead
   * to it from the root value.
   */
  keys: (string | number)[];
  /** The value found at that path */
  value: unknown;
  /** The metadata that matched */
  meta: FieldMetadata;
  /**
   * Whether the value sits inside an array element, tuple item or record
   * value, and so occurs once per element rather than once per schema. Also
   * set for a value reported whole because it does not have the shape of the
   * container its schema declares.
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
 * Characters `JSON.stringify` leaves as they are that can still move the
 * cursor, clear the screen or reorder the text of a terminal line.
 */
const UNPRINTABLE =
  /[\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Appends a key to a path. A key made of letters, digits, `_` and `-` is
 * joined with a dot; any other key is written as a quoted, escaped index
 * (`accounts["eu.west"]`), so a path names exactly one place in a value, a
 * `[0]` segment is always an array index, and no control or bidirectional
 * character from a key reaches the terminal.
 */
function appendKey(path: string, key: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    // JSON escapes the C0 controls; DEL, the C1 controls, the line and
    // paragraph separators and the bidirectional marks are escaped here.
    const quoted = JSON.stringify(key).replace(
      UNPRINTABLE,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    return `${path}[${quoted}]`;
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

/**
 * Follows wrappers down to the schema that describes the value itself.
 * Returns undefined when a `z.preprocess()` is on the way: its function can
 * turn the stored value into any shape, so the schema behind it says nothing
 * about the value as stored.
 */
function coreSchema(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  let current = schema;
  for (let inner = innerSchema(current); inner; inner = innerSchema(current)) {
    const def = getSchemaDef(current);
    if (
      getSchemaType(current) === "pipe" && def.in &&
      getSchemaType(def.in) === "transform"
    ) {
      return undefined;
    }
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

/** Schema types that accept only an absent value, or no value at all. */
const ABSENT_TYPES = ["null", "undefined", "void", "never"];

/**
 * Reports whether a value has the kind a union member describes: an object
 * for an object or record, an array for an array or tuple, a scalar for a
 * scalar. A number, boolean or bigint fits only a scalar member of its own
 * type, or a literal or enum that lists it; a string fits every scalar
 * member. A member that accepts only an absent value (`z.null()`,
 * `z.undefined()`, `z.void()`, `z.never()`) fits nothing, since the walk
 * never brings an absent value to a union. A member of any other type, a
 * coerced scalar, or one behind a `z.preprocess()`, is taken to fit every
 * value.
 */
function fitsShape(member: z.ZodTypeAny, value: unknown): boolean {
  const core = coreSchema(member);
  if (core === undefined) {
    return true;
  }
  const memberType = getSchemaType(core);
  const def = getSchemaDef(core);
  // `z.coerce.string()`, `z.coerce.date()` and the like accept any value by
  // converting it.
  if (def?.coerce === true) {
    return true;
  }
  if (memberType === "object" || memberType === "record") {
    return isPlainObject(value);
  }
  if (memberType === "array" || memberType === "tuple") {
    return Array.isArray(value);
  }
  if (SCALAR_TYPES.includes(memberType)) {
    if (typeof value === "object") {
      return false;
    }
    // A stored string can stand for a scalar of any type: an expression is
    // kept as text until it is resolved.
    if (typeof value === "string") {
      return true;
    }
    if (memberType === "literal") {
      return def.values?.includes(value) ?? true;
    }
    if (memberType === "enum") {
      return def.entries ? Object.values(def.entries).includes(value) : true;
    }
    return (memberType === "number" && typeof value === "number") ||
      (memberType === "boolean" && typeof value === "boolean") ||
      (memberType === "bigint" && typeof value === "bigint");
  }
  if (ABSENT_TYPES.includes(memberType)) {
    return false;
  }
  if (memberType === "date") {
    return value instanceof Date || typeof value === "string";
  }
  if (memberType === "nan") {
    return typeof value === "number";
  }
  return true;
}

/**
 * Returns the literal values an object member requires for its keys: for
 * `z.object({ kind: z.literal("token") })`, `kind` mapped to `["token"]`.
 * Empty for a member that is not a plain object schema.
 */
function literalTags(member: z.ZodTypeAny): Map<string, unknown[]> {
  const tags = new Map<string, unknown[]>();
  const memberSchema = unwrapSchema(member);
  if (getSchemaType(memberSchema) !== "object") {
    return tags;
  }
  for (
    const [key, fieldSchema] of Object.entries(
      getSchemaDef(memberSchema).shape ?? {},
    )
  ) {
    const fieldDef = getSchemaDef(unwrapSchema(fieldSchema));
    if (fieldDef?.type === "literal" && fieldDef.values) {
      tags.set(key, fieldDef.values);
    }
  }
  return tags;
}

/**
 * Picks the members of a union a value can belong to, without running any
 * member's validation. Two kinds of member are dropped, both certain to
 * reject the value: one of another kind (see {@link fitsShape}), and an
 * object member requiring a literal for a key where the value holds a
 * literal that a different member requires there (the value is tagged as
 * that other member). Every other case keeps the member, so a field one
 * member marks is never missed because another member also accepts the
 * value. When nothing is left, every member is kept.
 */
function unionMembers(def: ZodDef, value: unknown): z.ZodTypeAny[] {
  const all = def.options ?? [];
  const fitting = all.filter((option) => fitsShape(option, value));
  const options = fitting.length > 0 ? fitting : all;
  if (!isPlainObject(value)) {
    return options;
  }
  const tags = options.map(literalTags);
  const untagged = options.filter((_, index) => {
    for (const [key, required] of tags[index]) {
      const held = value[key];
      if (held === undefined || required.includes(held)) {
        continue;
      }
      const tagsAnotherMember = tags.some((other, otherIndex) =>
        otherIndex !== index && other.get(key)?.includes(held)
      );
      if (tagsAnotherMember) {
        return false;
      }
    }
    return true;
  });
  return untagged.length > 0 ? untagged : options;
}

/** State carried through one {@link findValuesWithMetadata} walk. */
interface ValueWalk {
  matches: (meta: FieldMetadata) => boolean;
  /** Report metadata on the root schema's own chain, for the root value. */
  reportRoot?: boolean;
  found: ValueWithMetadata[];
  /** Paths already in `found`. */
  foundPaths: Set<string>;
  /**
   * Paths each schema has already been walked at. Overlapping union members
   * lead to the same schema at the same place more than once; walking it
   * again would double the work at every level of a recursive schema.
   */
  visited: Map<z.ZodTypeAny, Set<string>>;
  /** Containers on the way down to the current value, to stop on a cycle. */
  ancestors: Set<object>;
  /** Answers already given by {@link matchWithin}; null for no match. */
  within: Map<z.ZodTypeAny, FieldMetadata | null>;
}

/**
 * Returns the first matching metadata on `schema` or on any schema reachable
 * from it, reading the schema alone. Used where a value cannot be walked
 * against its schema, to learn whether that schema marks anything at all.
 */
function matchWithin(
  walk: ValueWalk,
  schema: z.ZodTypeAny,
): FieldMetadata | undefined {
  const known = walk.within.get(schema);
  if (known !== undefined) {
    return known ?? undefined;
  }
  let match: FieldMetadata | undefined;
  const seen = new Set<z.ZodTypeAny>();
  const pending = [schema];
  while (pending.length > 0 && !match) {
    const current = pending.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    const meta = readMetadata(current);
    if (meta && walk.matches(meta)) {
      match = meta;
      break;
    }
    const def = getSchemaDef(current);
    if (!def?.type) {
      continue;
    }
    const children = [
      def.innerType,
      def.schema,
      def.type === "lazy" ? innerSchema(current) : undefined,
      def.in,
      def.out,
      ...Object.values(def.shape ?? {}),
      def.catchall,
      def.valueType,
      def.element,
      ...(def.items ?? []),
      def.rest,
      ...(def.options ?? []),
      def.left,
      def.right,
    ];
    for (const child of children) {
      if (child) {
        pending.push(child);
      }
    }
  }
  walk.within.set(schema, match ?? null);
  return match;
}

function visitValue(
  walk: ValueWalk,
  schema: z.ZodTypeAny,
  value: unknown,
  path: string,
  keys: (string | number)[],
  perElement: boolean,
  atRoot = false,
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === "object") {
    let paths = walk.visited.get(schema);
    if (!paths) {
      paths = new Set();
      walk.visited.set(schema, paths);
    }
    if (paths.has(path)) {
      return;
    }
    paths.add(path);
  }

  // Union and intersection members and both sides of a pipe revisit one
  // value. A path names one place in the value, so a path seen before is
  // that same value.
  const report = (meta: FieldMetadata, whole: boolean) => {
    if (!walk.foundPaths.has(path)) {
      walk.foundPaths.add(path);
      walk.found.push({ path, keys, value, meta, perElement: whole });
    }
  };

  let current = schema;
  let reported = atRoot && !walk.reportRoot;
  while (true) {
    const meta = readMetadata(current);
    if (!reported && meta && walk.matches(meta)) {
      report(meta, perElement);
      reported = true;
    }
    if (getSchemaType(current) === "pipe") {
      // `a.pipe(b)`: `b` describes the same value once `a` has accepted it,
      // so what `b` marks is marked here too.
      const pipe = getSchemaDef(current);
      if (pipe.in && pipe.out && getSchemaType(pipe.in) !== "transform") {
        visitValue(walk, pipe.out, value, path, keys, perElement, reported);
      }
    }
    const inner = innerSchema(current);
    if (!inner) {
      break;
    }
    current = inner;
  }

  const schemaType = getSchemaType(current);
  const def = getSchemaDef(current);
  const visitKey = (
    childSchema: z.ZodTypeAny,
    childValue: unknown,
    key: string,
    inElement: boolean,
  ) =>
    visitValue(
      walk,
      childSchema,
      childValue,
      appendKey(path, key),
      [...keys, key],
      inElement,
    );
  const visitIndex = (
    childSchema: z.ZodTypeAny,
    childValue: unknown,
    index: number,
  ) =>
    visitValue(
      walk,
      childSchema,
      childValue,
      `${path}[${index}]`,
      [...keys, index],
      true,
    );

  if (schemaType === "union") {
    for (const option of unionMembers(def, value)) {
      visitValue(walk, option, value, path, keys, perElement, atRoot);
    }
    return;
  }
  if (schemaType === "intersection") {
    for (const side of [def.left, def.right]) {
      if (side) {
        visitValue(walk, side, value, path, keys, perElement, atRoot);
      }
    }
    return;
  }

  const isObjectSchema = schemaType === "object" || schemaType === "record";
  const isArraySchema = schemaType === "array" || schemaType === "tuple";
  if (
    (isObjectSchema && !isPlainObject(value)) ||
    (isArraySchema && !Array.isArray(value))
  ) {
    // The value cannot be walked against the container the schema declares
    // (`tokens: "hunter2"` for an array of tokens), so nothing inside it can
    // be told apart. If the container marks anything, the whole value is
    // reported in its place.
    const meta = reported ? undefined : matchWithin(walk, current);
    if (meta) {
      report(meta, true);
    }
    return;
  }
  if (typeof value !== "object" || walk.ancestors.has(value)) {
    return;
  }

  walk.ancestors.add(value);
  if (schemaType === "object" && isPlainObject(value)) {
    const shape = def.shape ?? {};
    for (const [key, fieldSchema] of Object.entries(shape)) {
      // A key the value does not hold is absent, whatever the prototype
      // answers for it (`toString`, `constructor`).
      if (Object.hasOwn(value, key)) {
        visitKey(fieldSchema, value[key], key, perElement);
      }
    }
    const catchall = def.catchall;
    if (catchall) {
      for (const [key, entry] of Object.entries(value)) {
        if (!Object.hasOwn(shape, key)) {
          visitKey(catchall, entry, key, true);
        }
      }
    }
  } else if (schemaType === "record" && isPlainObject(value)) {
    const valueSchema = def.valueType;
    if (valueSchema) {
      for (const [key, entry] of Object.entries(value)) {
        visitKey(valueSchema, entry, key, true);
      }
    }
  } else if (schemaType === "array" && Array.isArray(value)) {
    const elementSchema = def.element;
    if (elementSchema) {
      value.forEach((element, index) =>
        visitIndex(elementSchema, element, index)
      );
    }
  } else if (schemaType === "tuple" && Array.isArray(value)) {
    value.forEach((element, index) => {
      const itemSchema = def.items?.[index] ?? def.rest;
      if (itemSchema) {
        visitIndex(itemSchema, element, index);
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
 * `.catchall()` keys, union members and intersections, and through
 * `.transform()`, `.readonly()` and `z.lazy()` wrappers, and on both sides of
 * a `.pipe()`. It reads the value as stored: a `z.preprocess()` that turns a
 * string into a container is not run, so fields inside that string are not
 * reached. A matching node is reported once, and its children are still
 * visited. A value that is not the object or array its schema declares is
 * reported whole when that schema marks anything inside it. Metadata on the
 * root schema itself is not reported, unless `reportRoot` asks for it: the
 * root value is then reported whole when the root schema, or a wrapper or
 * pipe side on its own chain, matches. No transform or validator is
 * executed.
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
  options: { reportRoot?: boolean } = {},
): ValueWithMetadata[] {
  const walk: ValueWalk = {
    matches,
    reportRoot: options.reportRoot,
    found: [],
    foundPaths: new Set(),
    visited: new Map(),
    ancestors: new Set(),
    within: new Map(),
  };
  visitValue(walk, schema, value, "", [], false, true);
  return walk.found;
}

/**
 * The paths of the fields in `schema` whose metadata, read across the whole
 * wrapper chain of the field (`.meta().optional()` and `.optional().meta()`
 * alike, and both sides of a `.pipe()`), satisfies `matches`, reading the
 * schema alone. Unlike {@link extractFieldsWithMetadata} it enters arrays,
 * tuples, records, unions, intersections and lazy schemas: an array element
 * or tuple rest is written `[]`, a tuple item `[<i>]`, a record value or
 * `.catchall()` key `[*]`, and a union or intersection member keeps the path
 * of the field it describes and continues its chain, so metadata on the
 * union and on a member are read together. A schema two fields share is read
 * once per distinct chain it is reached with, under the first path; a schema
 * that contains itself is entered once per path. Metadata on the root schema
 * itself is not reported.
 *
 * @param schema - A Zod schema (typically an object schema)
 * @param matches - Decides from a field's metadata, outermost wrapper first
 * @returns The matching field paths, in visit order
 */
export function findFieldsWhere(
  schema: z.ZodTypeAny,
  matches: (metadata: readonly FieldMetadata[]) => boolean,
): string[] {
  const found: string[] = [];
  /** The schemas on the way down to the current one, to stop on a cycle. */
  const ancestors = new Set<z.ZodTypeAny>();
  /**
   * The chains each schema was already read under. A schema two fields
   * share is read once per distinct inherited chain, so a DAG-shaped schema
   * costs one visit per node and chain, not one per path.
   */
  const seen = new Map<z.ZodTypeAny, Set<string>>();
  const chainIds = new WeakMap<FieldMetadata, number>();
  let nextChainId = 0;
  const chainKey = (chain: readonly FieldMetadata[]) =>
    chain.map((meta) => {
      let id = chainIds.get(meta);
      if (id === undefined) chainIds.set(meta, id = nextChainId++);
      return id;
    }).join(",");
  const visit = (
    node: z.ZodTypeAny,
    path: string,
    root: boolean,
    inherited: readonly FieldMetadata[] = [],
  ): void => {
    if (ancestors.has(node)) return;
    const key = chainKey(inherited);
    const keys = seen.get(node) ?? new Set<string>();
    if (keys.has(key)) return;
    keys.add(key);
    seen.set(node, keys);
    ancestors.add(node);
    try {
      visitWithin(node, path, root, inherited);
    } finally {
      ancestors.delete(node);
    }
  };
  const visitWithin = (
    node: z.ZodTypeAny,
    path: string,
    root: boolean,
    inherited: readonly FieldMetadata[],
  ): void => {
    // The chain of wrappers down to the core, each contributing its metadata;
    // a union or intersection member continues the chain of its field.
    const chain: FieldMetadata[] = [...inherited];
    const seen = new Set<z.ZodTypeAny>();
    let current: z.ZodTypeAny | undefined = node;
    let core: z.ZodTypeAny = node;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      core = current;
      const meta = readMetadata(current);
      if (meta) chain.push(meta);
      if (getSchemaType(current) === "pipe") {
        const pipe = getSchemaDef(current);
        if (pipe.in && pipe.out && getSchemaType(pipe.in) !== "transform") {
          const outMeta = readMetadata(pipe.out);
          if (outMeta) chain.push(outMeta);
        }
      }
      current = innerSchema(current);
    }
    if (!root && chain.length > 0 && matches(chain)) found.push(path);

    const def = getSchemaDef(core);
    if (!def?.type) return;
    switch (def.type) {
      case "object":
        for (const [key, field] of Object.entries(def.shape ?? {})) {
          visit(field, appendKey(path, key), false);
        }
        if (def.catchall) visit(def.catchall, `${path}[*]`, false);
        break;
      case "record":
        if (def.valueType) visit(def.valueType, `${path}[*]`, false);
        break;
      case "array":
        if (def.element) visit(def.element, `${path}[]`, false);
        break;
      case "tuple":
        (def.items ?? []).forEach((item, index) =>
          visit(item, `${path}[${index}]`, false)
        );
        if (def.rest) visit(def.rest, `${path}[]`, false);
        break;
      case "union":
        for (const option of def.options ?? []) {
          visit(option, path, root, chain);
        }
        break;
      case "intersection":
        for (const side of [def.left, def.right]) {
          if (side) visit(side, path, root, chain);
        }
        break;
    }
  };
  visit(schema, "", true);
  return found;
}

/**
 * Answers of {@link schemaHoldsMetadata}, per `matches` function and schema.
 * Weak on both, so an entry lasts no longer than the schema it describes.
 */
const heldAnswers = new WeakMap<
  (meta: FieldMetadata) => boolean,
  WeakMap<z.ZodTypeAny, boolean>
>();

/**
 * Reports whether `schema`, or any schema reachable from it, carries metadata
 * that satisfies `matches`. It reads the schema alone, and covers every place
 * {@link findValuesWithMetadata} can report, so a false answer means that
 * walk would find nothing in any value.
 *
 * The answer is kept per `matches` function and schema: pass the same
 * function each time, and expect metadata registered on a schema after its
 * first lookup to go unseen.
 */
export function schemaHoldsMetadata(
  schema: z.ZodTypeAny,
  matches: (meta: FieldMetadata) => boolean,
): boolean {
  let answers = heldAnswers.get(matches);
  if (!answers) {
    answers = new WeakMap();
    heldAnswers.set(matches, answers);
  }
  const known = answers.get(schema);
  if (known !== undefined) {
    return known;
  }
  const walk: ValueWalk = {
    matches,
    found: [],
    foundPaths: new Set(),
    visited: new Map(),
    ancestors: new Set(),
    within: new Map(),
  };
  const held = matchWithin(walk, schema) !== undefined;
  answers.set(schema, held);
  return held;
}

/** What a schema's own code, around the fields `matches` marks, can reach. */
export interface CodeAroundMetadata {
  /**
   * A custom check, a node-level error map or a pipe sits on a node that
   * encloses a marked field, or on a union or intersection member beside
   * one. It receives the marked value, so a message it writes may spell it,
   * and an issue it adds may sit at any path.
   */
  messages: boolean;
  /**
   * A `superRefine()`, a `.check()` or a pipe sits at or above a marked
   * field. An issue it adds may carry any code and any fields.
   */
  issues: boolean;
}

/**
 * Answers of {@link codeAroundMetadata}, per `matches` function and schema.
 */
const codeAnswers = new WeakMap<
  (meta: FieldMetadata) => boolean,
  WeakMap<z.ZodTypeAny, CodeAroundMetadata>
>();

/** The nodes that describe one value at a node's position, and the cores. */
interface Chain {
  /**
   * The node, its wrappers down to the core, both sides of a pipe, and at
   * a union or intersection every member's chain.
   */
  nodes: z.ZodTypeAny[];
  /** The schemas whose children are reached through a value step. */
  cores: z.ZodTypeAny[];
}

function chainOf(node: z.ZodTypeAny): Chain {
  const chain: Chain = { nodes: [], cores: [] };
  const seen = new Set<z.ZodTypeAny>();
  const follow = (start: z.ZodTypeAny): void => {
    let current: z.ZodTypeAny | undefined = start;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      chain.nodes.push(current);
      const def = getSchemaDef(current);
      const type = getSchemaType(current);
      if (
        type === "pipe" && def.in && def.out &&
        getSchemaType(def.in) !== "transform"
      ) {
        follow(def.out);
      }
      if (type === "union") {
        for (const option of def.options ?? []) follow(option);
        return;
      }
      if (type === "intersection") {
        for (const side of [def.left, def.right]) if (side) follow(side);
        return;
      }
      const inner = innerSchema(current);
      if (!inner) {
        chain.cores.push(current);
        return;
      }
      current = inner;
    }
  };
  follow(node);
  return chain;
}

/** The schemas a value step below `core` leads to. */
function valueChildren(core: z.ZodTypeAny): z.ZodTypeAny[] {
  const def = getSchemaDef(core);
  switch (def?.type) {
    case "object":
      return [
        ...Object.values(def.shape ?? {}),
        ...(def.catchall ? [def.catchall] : []),
      ];
    case "record":
    case "map":
    case "set":
      return def.valueType ? [def.valueType] : [];
    case "array":
      return def.element ? [def.element] : [];
    case "tuple":
      return [...(def.items ?? []), ...(def.rest ? [def.rest] : [])];
    default:
      return [];
  }
}

/**
 * Whether a node's own code receives the value and may write a message about
 * it: a custom check (`.refine()`, `superRefine()`, `.check()`), a node-level
 * error map, or a pipe. A string message is stored as a function, so a
 * static message cannot be told from one that reads the input. A built-in
 * check reports at the node's own position only, and is not counted.
 */
function writesMessages(node: z.ZodTypeAny): boolean {
  const def = getSchemaDef(node);
  return getSchemaType(node) === "pipe" || def?.error !== undefined ||
    (def?.checks ?? []).some((check) => check._zod?.def?.check === "custom");
}

/**
 * Whether a node's own code may add an issue of any code, with any fields and
 * any input: a `superRefine()` or `.check()`, or a pipe. A `.refine()` only
 * answers yes or no, and sets a message.
 */
function addsIssues(node: z.ZodTypeAny): boolean {
  const def = getSchemaDef(node);
  return getSchemaType(node) === "pipe" ||
    (def?.checks ?? []).some((check) => {
      const checkDef = check._zod?.def;
      return checkDef?.check === "custom" && !("fn" in (checkDef ?? {}));
    });
}

/**
 * Reports what the schema's own code can reach around the fields whose
 * metadata satisfies `matches`, reading the schema alone (swamp-club#3681).
 * The chain at each position is read whole (`.optional().refine()` keeps the
 * refinement on the wrapper), and a union or intersection member counts for
 * what every other member's subtree marks, since it receives the same value.
 * A `z.lazy()` schema is entered once. The answer is kept per `matches`
 * function and schema, as {@link schemaHoldsMetadata} keeps its own.
 */
export function codeAroundMetadata(
  schema: z.ZodTypeAny,
  matches: (meta: FieldMetadata) => boolean,
): CodeAroundMetadata {
  let answers = codeAnswers.get(matches);
  if (!answers) {
    answers = new WeakMap();
    codeAnswers.set(matches, answers);
  }
  const known = answers.get(schema);
  if (known) {
    return known;
  }
  const found: CodeAroundMetadata = { messages: false, issues: false };
  /** Whether each node's chain or subtree holds a match; null while read. */
  const holds = new Map<z.ZodTypeAny, boolean | null>();
  const visit = (node: z.ZodTypeAny): boolean => {
    const seen = holds.get(node);
    if (seen !== undefined) {
      return seen ?? false;
    }
    holds.set(node, null);
    const { nodes, cores } = chainOf(node);
    const self = nodes.some((member) => {
      const meta = readMetadata(member);
      return meta !== undefined && matches(meta);
    });
    let below = false;
    for (const core of cores) {
      for (const child of valueChildren(core)) {
        if (visit(child)) {
          below = true;
        }
      }
    }
    if (below && nodes.some(writesMessages)) {
      found.messages = true;
    }
    if ((self || below) && nodes.some(addsIssues)) {
      found.issues = true;
    }
    holds.set(node, self || below);
    return self || below;
  };
  visit(schema);
  answers.set(schema, found);
  return found;
}
