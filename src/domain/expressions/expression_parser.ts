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

import { maskLiteralCalls } from "./cel_string_lexer.ts";
import type { ExpressionLocation } from "./expression.ts";
import {
  alignProvenance,
  alignStrings,
  type DataRange,
  keyPath,
  ProvenanceMap,
  type SentinelResolver,
} from "./provenance_map.ts";
import {
  matchSingleExpression,
  replaceExpressionSpans,
  scanExpressions,
} from "./expression_scanner.ts";

export { transformHyphenatedModelRefs } from "./cel_grammar.ts";

/**
 * Whether a string holds a `${{ ... }}` expression. Every expression the
 * scanner finds starts where this pattern matches — which `}}` ends it never
 * changes whether there is one — so detection needs no parsing.
 */
const HAS_EXPRESSION_PATTERN = /\$\{\{.+?\}\}/s;

/**
 * Every accessor the CEL `data.*` namespace exposes as an expression-callable
 * function, in the order they are declared on `DataNamespace`.
 *
 * This is the namespace's *callable* surface, not a convenience list, and that
 * distinction decides membership. `DataNamespace` in `model_resolver.ts`
 * declares a seventh member, the optional no-op `invalidateLatest`, which is
 * absent here because it returns void, is not supplied by
 * `buildDataNamespace`, and is never registered with cel-js — so no
 * expression can call it.
 *
 * Two places derive their patterns from this list rather than restating it:
 * the workflow-path expression validator, and the data-function detection
 * predicate in `dependency_extractor.ts`. A third pattern in that module
 * stays deliberately narrower; see the comment on `DATA_FUNCTION_PATTERN`.
 *
 * `integration/expression_accessors_rules_test.ts` pins this list against both
 * surfaces that define the namespace, so an accessor added to one without the
 * other fails a test rather than silently failing validation later.
 */
export const DATA_NAMESPACE_ACCESSORS = [
  "version",
  "latest",
  "listVersions",
  "findByTag",
  "findBySpec",
  "query",
] as const;

/**
 * The accessor names as a regex alternation, for patterns that mean "any data
 * accessor". Callers supply their own anchoring and argument matching.
 */
export function dataAccessorAlternation(): string {
  return DATA_NAMESPACE_ACCESSORS.join("|");
}

/**
 * Checks if a string contains any expressions.
 */
export function containsExpression(value: string): boolean {
  return HAS_EXPRESSION_PATTERN.test(value);
}

/**
 * Returns the `[start, end)` offsets of each `${{ ... }}` expression in a
 * string, exactly as {@link extractExpressions} sees them (see
 * {@link scanExpressions} for where an expression ends).
 */
export function expressionSpans(value: string): Array<[number, number]> {
  return scanExpressions(value).map((span) => [span.start, span.end]);
}

/**
 * Checks if a value is or contains an expression.
 * Works recursively for arrays and objects.
 */
export function valueContainsExpression(value: unknown): boolean {
  if (typeof value === "string") {
    return containsExpression(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsExpression(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((v) => valueContainsExpression(v));
  }
  return false;
}

/**
 * Strips fields that contain expressions from an object.
 * Used for schema validation where we want to validate static values
 * but skip expression-containing fields (which will be validated after evaluation).
 *
 * @param data - The data structure to process
 * @param holdsExpression - Decides which values to strip; defaults to any
 *   value containing `${{ ... }}` text
 * @returns A new object with expression-containing fields removed
 */
export function stripExpressionFields<T extends Record<string, unknown>>(
  data: T,
  holdsExpression: (value: unknown) => boolean = valueContainsExpression,
): Partial<T> {
  const result = Object.create(null) as Partial<T>;
  for (const [key, value] of Object.entries(data)) {
    if (!holdsExpression(value)) {
      Object.defineProperty(result, key, {
        value: value as T[keyof T],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return result;
}

/**
 * Extracts all expression locations from a nested data structure.
 *
 * @param data - The data structure to search (object, array, or primitive)
 * @param basePath - The base path for nested locations (default: "")
 * @param skipPath - Fields containing literal source rather than templates
 * @returns Array of expression locations found in the data
 */
export function extractExpressions(
  data: unknown,
  basePath = "",
  skipPath?: (path: string) => boolean,
): ExpressionLocation[] {
  const locations: ExpressionLocation[] = [];
  extractExpressionsRecursive(data, basePath, locations, skipPath);
  return locations;
}

function extractExpressionsRecursive(
  data: unknown,
  path: string,
  locations: ExpressionLocation[],
  skipPath?: (path: string) => boolean,
): void {
  if (skipPath?.(path)) return;
  if (typeof data === "string") {
    for (const span of scanExpressions(data)) {
      locations.push({
        path,
        raw: span.raw,
        celExpression: span.inner,
        start: span.start,
        end: span.end,
      });
    }
  } else if (Array.isArray(data)) {
    // Recursively process array elements
    for (let i = 0; i < data.length; i++) {
      const itemPath = path ? `${path}[${i}]` : `[${i}]`;
      extractExpressionsRecursive(data[i], itemPath, locations, skipPath);
    }
  } else if (data !== null && typeof data === "object") {
    // Recursively process object properties
    for (const [key, value] of Object.entries(data)) {
      const propPath = keyPath(path, key);
      extractExpressionsRecursive(value, propPath, locations, skipPath);
    }
  }
  // Primitives other than strings are ignored
}

/**
 * Rewrites an evaluated result as it is spliced at `path`: `whole` receives a
 * whole-field result; `embedded` receives rendered text and the original value
 * so policies can distinguish containers from strings. Only spliced results
 * pass through it, never the authored text
 * around them.
 */
export interface SpliceSanitizer {
  whole(value: unknown, path: string): unknown;
  embedded(text: string, path: string, value?: unknown): string;
  /** The real value of a sentinel this sanitizer writes, for provenance. */
  resolve?: SentinelResolver;
}

/**
 * Replaces expressions in a data structure with evaluated values.
 *
 * @param data - The data structure to process
 * @param values - Map of expression raw strings to their evaluated values
 * @param skipPath - Fields to preserve even if the same template occurs elsewhere
 * @param sanitizer - Optional rewrite applied to each spliced result
 * @returns A new data structure with expressions replaced
 */
export function replaceExpressions(
  data: unknown,
  values: Map<string, unknown>,
  skipPath?: (path: string) => boolean,
  sanitizer?: SpliceSanitizer,
): unknown {
  return replaceExpressionsRecursive(data, values, "", skipPath, sanitizer);
}

function replaceExpressionsRecursive(
  data: unknown,
  values: Map<string, unknown>,
  path: string,
  skipPath?: (path: string) => boolean,
  sanitizer?: SpliceSanitizer,
): unknown {
  if (skipPath?.(path)) return data;
  if (typeof data === "string") {
    if (!containsExpression(data)) return data;

    // Check if the entire string is a single expression
    const single = matchSingleExpression(data);
    if (single) {
      // Return the evaluated value directly (preserves type)
      const evaluated = values.get(single.raw);
      if (evaluated === undefined) return data;
      return sanitizer ? sanitizer.whole(evaluated, path) : evaluated;
    }

    // Replace inline expressions within a larger string, by position, so a
    // raw that also appears inside another expression's string literal is
    // left alone there.
    return replaceExpressionSpans(data, (span) => {
      if (!values.has(span.raw)) return span.raw;
      const value = values.get(span.raw);
      // JSON stringify arrays/objects to preserve structure
      if (value === null || value === undefined) return "";
      const rendered = typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);
      return sanitizer ? sanitizer.embedded(rendered, path, value) : rendered;
    });
  } else if (Array.isArray(data)) {
    return data.map((item, index) =>
      replaceExpressionsRecursive(
        item,
        values,
        `${path}[${index}]`,
        skipPath,
        sanitizer,
      )
    );
  } else if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(data)) {
      const propPath = keyPath(path, key);
      Object.defineProperty(result, key, {
        value: replaceExpressionsRecursive(
          value,
          values,
          propPath,
          skipPath,
          sanitizer,
        ),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }

  return data;
}

/**
 * Where an evaluated value came from, relative to the value itself: `map`
 * marks the parts that are data. When the value cannot be spliced with its
 * map intact (an object rendered as JSON inside a string, or text a sanitizer
 * rewrote), the spliced text is data except expression occurrences whose raw
 * text is in `authoredRaws`, the read-set rule.
 */
export interface SpliceOrigin {
  map: ProvenanceMap;
  authoredRaws?: ReadonlySet<string>;
}

/** An evaluated value that came entirely from authored source. */
export const AUTHORED_ORIGIN: SpliceOrigin = { map: ProvenanceMap.authored() };

/** A tree after substitution, with where data now sits in it. */
export interface TrackedSplice {
  data: unknown;
  provenance: ProvenanceMap;
}

/**
 * {@link replaceExpressions} that also tracks provenance. Substitution stays
 * keyed on raw text, so every authored occurrence of an evaluated raw
 * receives its value exactly as before; an occurrence that overlaps data in
 * `provenance` is never substituted. The returned map records where data sits
 * in the result: the input map carried through, plus each spliced value's
 * origin at its new position.
 */
export function replaceExpressionsTracked(
  data: unknown,
  values: Map<string, unknown>,
  provenance: ProvenanceMap,
  originOf: (raw: string) => SpliceOrigin,
  skipPath?: (path: string) => boolean,
  sanitizer?: SpliceSanitizer,
): TrackedSplice {
  const state = { provenance, originOf, skipPath, sanitizer, values };
  // Each visited path is written once and paths never nest, so the changes
  // are collected and applied in one pass.
  const changes: [string, ProvenanceMap][] = [];
  const result = replaceTracked(data, "", state, (path, map) => {
    changes.push([path, map]);
  });
  return { data: result, provenance: provenance.graftAll(changes) };
}

interface TrackedState {
  provenance: ProvenanceMap;
  originOf: (raw: string) => SpliceOrigin;
  skipPath?: (path: string) => boolean;
  sanitizer?: SpliceSanitizer;
  values: Map<string, unknown>;
}

function replaceTracked(
  data: unknown,
  path: string,
  state: TrackedState,
  update: (path: string, map: ProvenanceMap) => void,
): unknown {
  if (state.skipPath?.(path)) return data;
  if (state.provenance.isWholeDataAt(path)) return data;
  if (typeof data === "string") {
    if (!containsExpression(data)) return data;
    const single = matchSingleExpression(data);
    if (single) {
      if (state.provenance.overlapsData(path, single.start, single.end)) {
        return data;
      }
      if (!state.values.has(single.raw)) return data;
      const evaluated = state.values.get(single.raw);
      if (evaluated === undefined) return data;
      const value = state.sanitizer
        ? state.sanitizer.whole(evaluated, path)
        : evaluated;
      const origin = state.originOf(single.raw);
      update(
        path,
        wholeSpliceMap(value, evaluated, origin, state.sanitizer?.resolve),
      );
      return value;
    }
    const inRanges = state.provenance.rangesAt(path);
    const outRanges: DataRange[] = [];
    let out = "";
    let last = 0;
    const copy = (from: number, to: number) => {
      const offset = out.length - from;
      for (const [s, e] of inRanges) {
        const cs = Math.max(s, from);
        const ce = Math.min(e, to);
        if (cs < ce) outRanges.push([cs + offset, ce + offset]);
      }
      out += data.slice(from, to);
    };
    for (const span of scanExpressions(data)) {
      copy(last, span.start);
      last = span.end;
      if (
        state.provenance.overlapsData(path, span.start, span.end) ||
        !state.values.has(span.raw)
      ) {
        copy(span.start, span.end);
        continue;
      }
      const value = state.values.get(span.raw);
      if (value === null || value === undefined) continue;
      const rendered = typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);
      const text = state.sanitizer
        ? state.sanitizer.embedded(rendered, path, value)
        : rendered;
      const origin = state.originOf(span.raw);
      for (
        const [s, e] of embeddedRanges(
          value,
          rendered,
          text,
          origin,
          state.sanitizer?.resolve,
        )
      ) {
        outRanges.push([s + out.length, e + out.length]);
      }
      out += text;
    }
    copy(last, data.length);
    update(path, ProvenanceMap.authored().withRanges("", outRanges));
    return out;
  } else if (Array.isArray(data)) {
    return data.map((item, index) =>
      replaceTracked(item, `${path}[${index}]`, state, update)
    );
  } else if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(data)) {
      const propPath = keyPath(path, key);
      Object.defineProperty(result, key, {
        value: replaceTracked(value, propPath, state, update),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }
  return data;
}

/**
 * The map of a value spliced as a whole field. The origin's map applies when
 * the value is spliced unchanged; a value a sanitizer rewrote falls back to
 * the read-set rule over the rewritten value.
 */
function wholeSpliceMap(
  value: unknown,
  evaluated: unknown,
  origin: SpliceOrigin,
  resolve: SentinelResolver | undefined,
): ProvenanceMap {
  if (origin.map.isAuthored) return origin.map;
  if (value === evaluated) return origin.map;
  // A sanitizer swapped sensitive values for sentinels: carry the map
  // across by position, so data stays data wherever it now sits. Both
  // copies resolve alike, as the evaluated value can already carry a
  // sentinel an earlier pass issued.
  return alignProvenance(origin.map, evaluated, value, resolve, resolve);
}

/**
 * Data ranges, relative to `text`, of a value spliced inside a string.
 * A string spliced unchanged keeps its own ranges; anything rendered or
 * rewritten falls back to the read-set rule.
 */
function embeddedRanges(
  value: unknown,
  rendered: string,
  text: string,
  origin: SpliceOrigin,
  resolve: SentinelResolver | undefined,
): DataRange[] {
  if (origin.map.isAuthored) return [];
  if (typeof value === "string") {
    const ranges: DataRange[] = origin.map.isWholeDataAt("")
      ? [[0, rendered.length]]
      : [...origin.map.rangesAt("")];
    return text === rendered
      ? ranges
      : alignStrings(ranges, rendered, text, undefined, resolve);
  }
  // An object rendered as JSON: positions do not survive, so the read-set
  // rule decides, over the text as it is spliced.
  return readSetRanges(text, origin.authoredRaws);
}

/**
 * The read-set rule over a whole value: everything in it is data except
 * expression occurrences whose raw text is in `authoredRaws`. A subtree
 * holding no such occurrence is data in its entirety, keys included. A
 * subtree holding one is described part by part: a string keeps the ranges
 * around its occurrences, an array its items, and an object's own keys are
 * data on their own, since they came with the value and a sensitive record
 * takes its keys from them (swamp-club#3681); only the occurrence itself
 * stays authored, so it still resolves.
 */
export function readSetMap(
  value: unknown,
  authoredRaws: ReadonlySet<string> | undefined,
): ProvenanceMap {
  // Nothing in it is vouched for: all of it is data, as one entry.
  if (!authoredRaws?.size || !valueContainsExpression(value)) {
    return ProvenanceMap.data();
  }
  const whole: string[] = [];
  const ranges: [string, DataRange[]][] = [];
  const keys: string[] = [];
  const visit = (node: unknown, path: string) => {
    if (!holdsAuthoredRaw(node, authoredRaws)) {
      whole.push(path);
    } else if (typeof node === "string") {
      ranges.push([path, readSetRanges(node, authoredRaws)]);
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else if (node !== null && typeof node === "object") {
      keys.push(path);
      for (const [key, item] of Object.entries(node)) {
        visit(item, keyPath(path, key));
      }
    }
  };
  visit(value, "");
  return ProvenanceMap.fromEntries(whole, ranges, keys);
}

/** Whether a string in `node` holds an expression occurrence in `authoredRaws`. */
function holdsAuthoredRaw(
  node: unknown,
  authoredRaws: ReadonlySet<string>,
): boolean {
  if (typeof node === "string") {
    if (!containsExpression(node)) return false;
    for (const span of scanExpressions(node)) {
      if (authoredRaws.has(span.raw)) return true;
    }
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((item) => holdsAuthoredRaw(item, authoredRaws));
  }
  if (node !== null && typeof node === "object") {
    return Object.values(node).some((item) =>
      holdsAuthoredRaw(item, authoredRaws)
    );
  }
  return false;
}

/**
 * The read-set rule over one string: all of it is data except expression
 * occurrences whose raw text is in `authoredRaws`.
 */
function readSetRanges(
  text: string,
  authoredRaws: ReadonlySet<string> | undefined,
): DataRange[] {
  if (text.length === 0) return [];
  const ranges: DataRange[] = [];
  let last = 0;
  for (const span of scanExpressions(text)) {
    if (!authoredRaws?.has(span.raw)) continue;
    if (span.start > last) ranges.push([last, span.start]);
    last = span.end;
  }
  if (last < text.length) ranges.push([last, text.length]);
  return ranges;
}

/**
 * Extracts the CEL expression from a raw expression string.
 *
 * @param raw - The raw expression string (e.g., "${{ model.foo.input }}")
 * @returns The CEL expression (e.g., "model.foo.input") or null if not valid
 */
export function extractCelExpression(raw: string): string | null {
  const match = raw.match(/^\$\{\{\s*(.+?)\s*\}\}\s*$/s);
  return match ? match[1].trim() : null;
}

/**
 * Checks if an expression path is at or within a step's task.inputs.
 *
 * @param path - The expression path (e.g., "jobs[0].steps[1].task.inputs.vpc_id")
 * @returns True if the path is at or within a step's task.inputs
 */
export function isTaskInputsPath(path: string): boolean {
  return path.includes(".task.inputs.") || path.includes(".task.inputs[") ||
    path.endsWith(".task.inputs");
}

/**
 * Checks if an expression path names what a step executes — the task target.
 *
 * `modelIdOrName` selects an existing definition; `modelType` + `modelName`
 * name a definition to auto-create. `modelName` is included because the
 * direct-execution form fails the same way when its name resolves to empty,
 * and because a run-id-based name like `build-lint-${{ run.id }}` carries no
 * step-output dependency — without this it would never reach the deferral
 * rule at all. `workflowIdOrName` is the target of a nested workflow step:
 * a driver step that picks the next workflow from a record an earlier step
 * wrote reads data that does not exist at run start (swamp-club#2351).
 *
 * @param path - The expression path (e.g. "jobs[0].steps[1].task.modelIdOrName")
 * @returns True if the path is a step's task target
 */
export function isTaskTargetPath(path: string): boolean {
  return path.endsWith(".task.modelIdOrName") ||
    path.endsWith(".task.modelName") ||
    path.endsWith(".task.workflowIdOrName");
}

/**
 * Checks if an expression path is at or within a step's task.globalArgs.
 *
 * @param path - The expression path
 * @returns True if the path is at or within a step's task.globalArgs
 */
export function isTaskGlobalArgsPath(path: string): boolean {
  return path.includes(".task.globalArgs.") ||
    path.includes(".task.globalArgs[") ||
    path.endsWith(".task.globalArgs");
}

/**
 * Checks if an expression path is a step's assert task.message field.
 *
 * Assert message expressions with step-output dependencies must be deferred
 * past workflow evaluation — the message is interpolated at step execution
 * time when upstream step outputs are available.
 *
 * @param path - The expression path (e.g., "jobs[0].steps[1].task.message")
 * @returns True if the path is a step's task.message
 */
export function isAssertMessagePath(path: string): boolean {
  return path.endsWith(".task.message");
}

/** Raw assert CEL is never interpolated, whether in a workflow or one step. */
export function isAssertExprPath(path: string): boolean {
  return /^(?:jobs\[\d+\]\.steps\[\d+\]\.)?task\.expr$/.test(path);
}

/**
 * Checks if an expression path is within a workflow's `trigger.inputs`.
 *
 * These values are resolved at fire time by the trigger machinery — webhook
 * runs CEL-evaluate them against the request payload (see TriggerInputResolver),
 * scheduled runs use them as static literals — so workflow-body evaluation must
 * leave them raw rather than evaluate `webhook.*` against a context that lacks
 * the payload.
 *
 * @param path - The expression path (e.g., "trigger.inputs.identifier")
 * @returns True if the path is within the trigger's inputs map
 */
export function isTriggerInputsPath(path: string): boolean {
  return path === "trigger.inputs" ||
    path.startsWith("trigger.inputs.") ||
    path.startsWith("trigger.inputs[");
}

/**
 * Checks if an expression path is a step's guard field.
 *
 * Guard expressions are evaluated at step execution time — they check runtime
 * state (data outputs from upstream steps, forEach variables) to decide whether
 * a step should be skipped, so workflow-body evaluation must leave them raw.
 */
export function isGuardPath(path: string): boolean {
  return path.endsWith(".guard");
}

/**
 * Checks if an expression path is a step's `name`.
 *
 * A step name is an identifier: a secret spliced into one at run start keeps
 * the `sensitive-<vault>.<key>` stand-in, never the value or its sentinel
 * (design/enablers/typed-secrets.md, Identifiers).
 */
export function isStepNamePath(path: string): boolean {
  return /^jobs\[\d+\]\.steps\[\d+\]\.name$/.test(path);
}

/**
 * Pattern to match `inputs.fieldName` (dot notation) in CEL expressions.
 * Uses negative lookbehind to exclude cross-model references like `model.foo.input.bar`.
 */
const INPUTS_DOT_PATTERN = /(?<!\.)inputs\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Pattern to match `inputs["field-name"]` (bracket notation) in CEL expressions.
 * Uses negative lookbehind to exclude cross-model references.
 */
const INPUTS_BRACKET_PATTERN = /(?<!\.)inputs\["([^"]+)"\]/g;

/**
 * Extracts input field names referenced in a single CEL expression string.
 * Handles both dot notation (`inputs.fieldName`) and bracket notation
 * (`inputs["field-name"]`). Excludes cross-model references.
 *
 * @param celExpression - The raw CEL expression (without `${{ }}` wrapper)
 * @returns Set of unique input field names referenced
 */
export function extractInputReferencesFromCel(
  celExpression: string,
): Set<string> {
  const inputNames = new Set<string>();
  // A literal() argument is text, not a reference.
  const cel = maskLiteralCalls(celExpression);
  for (const match of cel.matchAll(INPUTS_DOT_PATTERN)) {
    inputNames.add(match[1]);
  }
  for (const match of cel.matchAll(INPUTS_BRACKET_PATTERN)) {
    inputNames.add(match[1]);
  }
  return inputNames;
}

export function extractWholeFieldInputRef(value: string): string | null {
  const single = matchSingleExpression(value);
  if (!single) return null;

  const cel = single.inner;

  const dotMatch = cel.match(/^inputs\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (dotMatch) return dotMatch[1];

  const bracketMatch = cel.match(/^inputs\["([^"]+)"\]$/);
  if (bracketMatch) return bracketMatch[1];

  return null;
}

export function extractInputReferences(data: unknown): Set<string> {
  const expressions = extractExpressions(data);
  const inputNames = new Set<string>();

  for (const expr of expressions) {
    const refs = extractInputReferencesFromCel(expr.celExpression);
    for (const name of refs) {
      inputNames.add(name);
    }
  }

  return inputNames;
}
