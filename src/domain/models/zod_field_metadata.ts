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
import { schemaTransformsValues } from "./zod_type_coercion.ts";

export type FieldMetadata = Record<string, unknown>;

export interface FieldWithMetadata {
  path: string;
  meta: FieldMetadata;
}

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
  checks?: { _zod?: { def?: ZodCheckDef } }[];
  error?: unknown;
  transform?: unknown;
}

interface ZodCheckDef {
  check?: string;
  fn?: unknown;
}

function getSchemaDef(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function getSchemaType(schema: z.ZodTypeAny): string {
  return getSchemaDef(schema)?.type ?? "";
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

export function findFieldMetadata(
  schema: z.ZodTypeAny,
  matches: (meta: FieldMetadata) => boolean,
): FieldMetadata | undefined {
  const outerMeta = z.globalRegistry.get(schema) as FieldMetadata | undefined;
  if (outerMeta && matches(outerMeta)) {
    return outerMeta;
  }

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

    const unwrappedField = unwrapSchema(fieldSchema);
    if (getSchemaType(unwrappedField) === "object") {
      results.push(
        ...extractFieldsWithMetadata(unwrappedField, matches, fieldPath),
      );
    }
  }

  return results;
}

export interface ValueWithMetadata {
  path: string;
  keys: (string | number)[];
  value: unknown;
  meta: FieldMetadata;
  /**
   * set when the value is reported conservatively (a pipeline input that may
   * reach a marked output, or a reshaping node's whole value) rather than
   * marked by a schema node itself
   */
  rawInput?: true;
  perElement: boolean;
}

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
 * a key of letters, digits, _ and - joins with a dot; any other is a quoted,
 * escaped index, so a path names one place and no control or bidi character
 * reaches the terminal
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
 * a schema this Zod did not build (e.g. an extension's own Zod v3) has no
 * registry entry and the registry throws on it, so it counts as having no
 * metadata
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
 * returns undefined when a z.preprocess() is on the way: its function can turn
 * the stored value into any shape, so the schema behind it says nothing about
 * the stored value
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

const ABSENT_TYPES = ["null", "undefined", "void", "never"];

/**
 * a scalar fits a scalar member of its own type, and a string fits any scalar
 * member; absent-only members fit nothing; any other member type, coerced or
 * preprocessed, is assumed to fit
 */
function fitsShape(member: z.ZodTypeAny, value: unknown): boolean {
  const core = coreSchema(member);
  if (core === undefined) {
    return true;
  }
  const memberType = getSchemaType(core);
  const def = getSchemaDef(core);
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
 * drops only members certain to reject the value (wrong kind, or a different
 * literal tag), so a field any plausible member marks is never missed; if none
 * remain, keeps all
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

interface ValueWalk {
  matches: (meta: FieldMetadata) => boolean;
  /** Cache inputs precede transforms, whose output keys may differ completely. */
  rawInputs?: boolean;
  reportRoot?: boolean;
  transformed?: boolean;
  found: ValueWithMetadata[];
  foundPaths: Map<string, number>;
  /**
   * Paths each schema has already been walked at. Overlapping union members
   * lead to the same schema at the same place more than once; walking it
   * again would double the work at every level of a recursive schema.
   */
  visited: Map<z.ZodTypeAny, Set<string>>;
  ancestors: Set<object>;
  within: Map<z.ZodTypeAny, FieldMetadata | null>;
}

/**
 * a path names one place, so a path seen before is reported once; under
 * rawInputs an exact report replaces a raw-input one, whichever side of a pipe
 * or member was reached first
 */
function record(walk: ValueWalk, entry: ValueWithMetadata): void {
  const index = walk.foundPaths.get(entry.path);
  if (index === undefined) {
    walk.foundPaths.set(entry.path, walk.found.length);
    walk.found.push(entry);
  } else if (
    walk.rawInputs && walk.found[index].rawInput && !entry.rawInput
  ) {
    walk.found[index] = entry;
  }
}

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

  const report = (meta: FieldMetadata, whole: boolean, rawInput?: true) =>
    record(walk, {
      path,
      keys,
      value,
      meta,
      perElement: whole,
      ...(rawInput ? { rawInput } : {}),
    });

  let current = schema;
  let reported = atRoot && !walk.reportRoot;
  while (true) {
    const meta = readMetadata(current);
    if (!reported && meta && walk.matches(meta)) {
      report(meta, perElement);
      reported = true;
    }
    if (walk.transformed && reshapes(current)) {
      // The value is what this node's own code made of what it was given,
      // which may hold a marked value anywhere, under any key. Nothing
      // below can be told apart, so the whole value is reported in its
      // place when the node reaches a marked schema at all.
      const made = reported ? undefined : matchWithin(walk, current);
      if (made) {
        report(made, true, true);
      }
      return;
    }
    if (getSchemaType(current) === "pipe") {
      const pipe = getSchemaDef(current);
      // Only code on the input side can carry an input into a marked output
      // under another key. A pipe without any describes one value on both
      // sides, so the branch below reads what its output marks exactly.
      if (walk.rawInputs && pipe.out && pipeMayReshape(current, pipe.in)) {
        const outputMeta = matchWithin(walk, pipe.out);
        if (outputMeta) {
          // No transform runs here. Any input may contribute to a marked
          // output, so preserve only references or masks for those inputs.
          report(outputMeta, true, true);
          if (atRoot && isPlainObject(value)) {
            for (const [key, input] of Object.entries(value)) {
              record(walk, {
                path: appendKey(path, key),
                keys: [...keys, key],
                value: input,
                meta: outputMeta,
                perElement: true,
                rawInput: true,
              });
            }
          }
          // The walk goes on as it would without `rawInputs`, so what either
          // side of the pipe marks at a position the input holds is still
          // reported exactly, and replaces a raw-input report there.
        }
      }
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

  if (
    walk.transformed &&
    (schemaType === "union" || schemaType === "intersection")
  ) {
    // Every member receives the whole value, so a member that reshapes it
    // may hold what another member marks, under any key.
    const members = schemaType === "union"
      ? def.options ?? []
      : [def.left, def.right];
    if (
      members.some((member) => member !== undefined && chainReshapes(member))
    ) {
      const made = reported ? undefined : matchWithin(walk, current);
      if (made) {
        report(made, true, true);
      }
      return;
    }
  }
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
 * whether a node's own code may deliver a value of any shape: transform, codec,
 * overwrite check or catch; a z.preprocess() does not, as its output conforms
 * to the schema behind it
 */
function reshapes(node: z.ZodTypeAny): boolean {
  const def = getSchemaDef(node);
  const type = getSchemaType(node);
  if (type === "catch") {
    return true;
  }
  if (type === "pipe") {
    return typeof def?.transform === "function" ||
      (def?.out !== undefined && getSchemaType(def.out) === "transform");
  }
  return (def?.checks ?? []).some((check) =>
    check._zod?.def?.check === "overwrite"
  );
}

/**
 * true when a pipe's input side may reshape the value (preprocess, transform,
 * codec or reshaping node), or cannot be read; otherwise both sides describe
 * one value at the same position
 */
function pipeMayReshape(
  pipe: z.ZodTypeAny,
  input: z.ZodTypeAny | undefined,
): boolean {
  return input === undefined || reshapes(pipe) ||
    schemaTransformsValues(input) || chainReshapes(input);
}

function chainReshapes(node: z.ZodTypeAny): boolean {
  const seen = new Set<z.ZodTypeAny>();
  for (
    let current: z.ZodTypeAny | undefined = node;
    current !== undefined && !seen.has(current);
    current = innerSchema(current)
  ) {
    seen.add(current);
    if (reshapes(current)) {
      return true;
    }
  }
  return false;
}

/**
 * walks schema and value together, reaching arrays, records, unions and pipes;
 * reads the value as stored and runs no transform or validator; each path names
 * one place; root metadata only with reportRoot
 */
export function findValuesWithMetadata(
  schema: z.ZodTypeAny,
  value: unknown,
  matches: (meta: FieldMetadata) => boolean,
  options: {
    rawInputs?: boolean;
    reportRoot?: boolean;
    transformed?: boolean;
  } = {},
): ValueWithMetadata[] {
  const walk: ValueWalk = {
    matches,
    rawInputs: options.rawInputs,
    reportRoot: options.reportRoot,
    transformed: options.transformed,
    found: [],
    foundPaths: new Map(),
    visited: new Map(),
    ancestors: new Set(),
    within: new Map(),
  };
  visitValue(walk, schema, value, "", [], false, true);
  return walk.found;
}

/**
 * reads the schema alone: array elements are [], tuple items [i], record values
 * and catchall [*]; a shared schema is read once per distinct chain; root
 * metadata is not reported
 */
export function findFieldsWhere(
  schema: z.ZodTypeAny,
  matches: (metadata: readonly FieldMetadata[]) => boolean,
): string[] {
  const found: string[] = [];
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

export interface MetadataOccurrence {
  meta: FieldMetadata;
  perElement: boolean;
}

/**
 * reads the schema alone and reaches every place findValuesWithMetadata can
 * report; like it, leaves out metadata on the root schema and its wrappers
 */
export function collectFieldMetadata(
  schema: z.ZodTypeAny,
  matches: (meta: FieldMetadata) => boolean,
): MetadataOccurrence[] {
  const found: MetadataOccurrence[] = [];
  const reported = new Map<FieldMetadata, Set<boolean>>();
  const visited = new Map<z.ZodTypeAny, Set<string>>();
  const pending: {
    schema: z.ZodTypeAny;
    perElement: boolean;
    atRoot: boolean;
  }[] = [
    { schema, perElement: false, atRoot: true },
  ];
  while (pending.length > 0) {
    const { schema: current, perElement, atRoot } = pending.pop()!;
    const state = `${perElement}:${atRoot}`;
    let states = visited.get(current);
    if (!states) {
      states = new Set();
      visited.set(current, states);
    }
    if (states.has(state)) {
      continue;
    }
    states.add(state);

    const meta = readMetadata(current);
    if (!atRoot && meta && matches(meta)) {
      let answers = reported.get(meta);
      if (!answers) {
        answers = new Set();
        reported.set(meta, answers);
      }
      if (!answers.has(perElement)) {
        answers.add(perElement);
        found.push({ meta, perElement });
      }
    }

    const def = getSchemaDef(current);
    if (!def?.type) {
      continue;
    }
    const children: typeof pending = [];
    for (
      const child of [
        def.innerType,
        def.schema,
        def.type === "lazy" ? innerSchema(current) : undefined,
        def.in,
        def.out,
        ...(def.options ?? []),
        def.left,
        def.right,
      ]
    ) {
      if (child) children.push({ schema: child, perElement, atRoot });
    }
    for (const child of Object.values(def.shape ?? {})) {
      if (child) children.push({ schema: child, perElement, atRoot: false });
    }
    for (
      const child of [
        def.catchall,
        def.valueType,
        def.element,
        ...(def.items ?? []),
        def.rest,
      ]
    ) {
      if (child) {
        children.push({ schema: child, perElement: true, atRoot: false });
      }
    }
    // Pushed in reverse, so schemas are visited in declaration order.
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push(children[i]);
    }
  }
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
 * a false answer means findValuesWithMetadata finds nothing in any value; the
 * answer is cached per matches function and schema, so metadata registered
 * after the first lookup goes unseen
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
    foundPaths: new Map(),
    visited: new Map(),
    ancestors: new Set(),
    within: new Map(),
  };
  const held = matchWithin(walk, schema) !== undefined;
  answers.set(schema, held);
  return held;
}

export interface CodeAroundMetadata {
  /**
   * a custom check, node-level error map or pipe on a node enclosing a marked
   * field, or beside one in a union, receives the marked value, so its message
   * may spell it
   */
  messages: boolean;
  /**
   * A `superRefine()`, a `.check()` or a pipe sits at or above a marked
   * field. An issue it adds may carry any code and any fields.
   */
  issues: boolean;
}

const codeAnswers = new WeakMap<
  (meta: FieldMetadata) => boolean,
  WeakMap<z.ZodTypeAny, CodeAroundMetadata>
>();

interface Chain {
  nodes: z.ZodTypeAny[];
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
 * a string message is stored as a function, so a static message cannot be told
 * from one that reads the input; built-in checks report only at the node's own
 * position and are not counted
 */
function writesMessages(node: z.ZodTypeAny): boolean {
  const def = getSchemaDef(node);
  return getSchemaType(node) === "pipe" || def?.error !== undefined ||
    (def?.checks ?? []).some((check) => check._zod?.def?.check === "custom");
}

/**
 * superRefine, check or a pipe may add an issue of any code, fields and input;
 * a refine only answers yes or no and sets a message
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
 * a union or intersection member counts for what every other member's subtree
 * marks, since it receives the same value; the answer is cached per matches
 * function and schema
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
