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
 * which }} ends an expression never changes whether there is one, so detection
 * needs no parsing
 */
const HAS_EXPRESSION_PATTERN = /\$\{\{.+?\}\}/s;

/**
 * the callable surface only: invalidateLatest is absent as it is never
 * registered with cel-js; the validator and data-function detection derive from
 * this list, DATA_FUNCTION_PATTERN stays narrower
 */
export const DATA_NAMESPACE_ACCESSORS = [
  "version",
  "latest",
  "listVersions",
  "findByTag",
  "findBySpec",
  "query",
] as const;

export function dataAccessorAlternation(): string {
  return DATA_NAMESPACE_ACCESSORS.join("|");
}

export function containsExpression(value: string): boolean {
  return HAS_EXPRESSION_PATTERN.test(value);
}

export function expressionSpans(value: string): Array<[number, number]> {
  return scanExpressions(value).map((span) => [span.start, span.end]);
}

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
 * for schema validation: static values are validated, expression-containing
 * fields are skipped and validated after evaluation
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
    const embedded = matchSingleExpression(data) === null;
    for (const span of scanExpressions(data)) {
      locations.push({
        path,
        raw: span.raw,
        celExpression: span.inner,
        start: span.start,
        end: span.end,
        ...(embedded ? { embedded: true } : {}),
      });
    }
  } else if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const itemPath = path ? `${path}[${i}]` : `[${i}]`;
      extractExpressionsRecursive(data[i], itemPath, locations, skipPath);
    }
  } else if (data !== null && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      const propPath = keyPath(path, key);
      extractExpressionsRecursive(value, propPath, locations, skipPath);
    }
  }
}

/**
 * only strings, arrays and objects on the way to a rewritten occurrence are
 * copied; every other value, a Date or Uint8Array included, is returned as is
 */
export function rewriteExpressions(
  data: unknown,
  rewrite: (location: ExpressionLocation) => string | undefined,
  path = "",
): unknown {
  if (typeof data === "string") {
    const embedded = matchSingleExpression(data) === null;
    return replaceExpressionSpans(data, (span) =>
      rewrite({
        path,
        raw: span.raw,
        celExpression: span.inner,
        start: span.start,
        end: span.end,
        ...(embedded ? { embedded: true } : {}),
      }) ?? span.raw);
  }
  if (Array.isArray(data)) {
    const items = data.map((item, i) =>
      rewriteExpressions(item, rewrite, path ? `${path}[${i}]` : `[${i}]`)
    );
    return items.some((item, i) => item !== data[i]) ? items : data;
  }
  if (data !== null && typeof data === "object") {
    const entries = Object.entries(data);
    const values = entries.map(([key, value]) =>
      rewriteExpressions(value, rewrite, keyPath(path, key))
    );
    if (values.every((value, i) => value === entries[i][1])) return data;
    return Object.fromEntries(entries.map(([key], i) => [key, values[i]]));
  }
  return data;
}

/**
 * applies only to spliced results, never the authored text around them;
 * embedded also gets the original value so policies can tell containers from
 * strings
 */
export interface SpliceSanitizer {
  whole(value: unknown, path: string): unknown;
  embedded(text: string, path: string, value?: unknown): string;
  resolve?: SentinelResolver;
}

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

    const single = matchSingleExpression(data);
    if (single) {
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
 * when the map cannot survive the splice (JSON-rendered object,
 * sanitizer-rewritten text), the spliced text is data except occurrences whose
 * raw is in authoredRaws
 */
export interface SpliceOrigin {
  map: ProvenanceMap;
  authoredRaws?: ReadonlySet<string>;
}

export const AUTHORED_ORIGIN: SpliceOrigin = { map: ProvenanceMap.authored() };

export interface TrackedSplice {
  data: unknown;
  provenance: ProvenanceMap;
}

/**
 * substitution stays keyed on raw text; an occurrence overlapping data in
 * provenance is never substituted
 */
export function replaceExpressionsTracked(
  data: unknown,
  values: Map<string, unknown>,
  provenance: ProvenanceMap,
  originOf: (raw: string) => SpliceOrigin,
  skipPath?: (path: string) => boolean,
  sanitizer?: SpliceSanitizer,
  onSpliceFailure?: (raw: string, error: unknown) => void,
): TrackedSplice {
  const state = {
    provenance,
    originOf,
    skipPath,
    sanitizer,
    values,
    onSpliceFailure,
  };
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
  onSpliceFailure?: (raw: string, error: unknown) => void;
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
      let value: unknown;
      try {
        value = state.sanitizer
          ? state.sanitizer.whole(evaluated, path)
          : evaluated;
      } catch (error) {
        if (!state.onSpliceFailure) throw error;
        state.onSpliceFailure(single.raw, error);
        return data;
      }
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
      let rendered: string;
      let text: string;
      try {
        rendered = typeof value === "object"
          ? JSON.stringify(value, null, 2)
          : String(value);
        text = state.sanitizer
          ? state.sanitizer.embedded(rendered, path, value)
          : rendered;
      } catch (error) {
        if (!state.onSpliceFailure) throw error;
        state.onSpliceFailure(span.raw, error);
        copy(span.start, span.end);
        continue;
      }
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
 * the origin map applies when the value is spliced unchanged; a
 * sanitizer-rewritten value falls back to the read-set rule
 */
function wholeSpliceMap(
  value: unknown,
  evaluated: unknown,
  origin: SpliceOrigin,
  resolve: SentinelResolver | undefined,
): ProvenanceMap {
  if (origin.map.isAuthored) return origin.map;
  if (value === evaluated) return origin.map;
  // carry the map across sentinels by position so data stays data; both copies
  // resolve alike since the value may already hold an earlier pass's sentinel
  return alignProvenance(origin.map, evaluated, value, resolve, resolve);
}

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
 * everything is data except occurrences whose raw is in authoredRaws; an
 * object's own keys stay data because a sensitive record takes its keys from
 * them
 */
export function readSetMap(
  value: unknown,
  authoredRaws: ReadonlySet<string> | undefined,
): ProvenanceMap {
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

export function extractCelExpression(raw: string): string | null {
  const match = raw.match(/^\$\{\{\s*(.+?)\s*\}\}\s*$/s);
  return match ? match[1].trim() : null;
}

export function isTaskInputsPath(path: string): boolean {
  return path.includes(".task.inputs.") || path.includes(".task.inputs[") ||
    path.endsWith(".task.inputs");
}

/**
 * modelName is included because a run-id-based name carries no step-output
 * dependency and would never reach deferral; a nested workflow target read from
 * an earlier step's record does not exist at run start
 */
export function isTaskTargetPath(path: string): boolean {
  return path.endsWith(".task.modelIdOrName") ||
    path.endsWith(".task.modelName") ||
    path.endsWith(".task.workflowIdOrName");
}

export function isTaskGlobalArgsPath(path: string): boolean {
  return path.includes(".task.globalArgs.") ||
    path.includes(".task.globalArgs[") ||
    path.endsWith(".task.globalArgs");
}

/**
 * assert messages with step-output dependencies are deferred, since they are
 * interpolated at step execution when upstream outputs exist
 */
export function isAssertMessagePath(path: string): boolean {
  return path.endsWith(".task.message");
}

/** Raw assert CEL is never interpolated, whether in a workflow or one step. */
export function isAssertExprPath(path: string): boolean {
  return /^(?:jobs\[\d+\]\.steps\[\d+\]\.)?task\.expr$/.test(path);
}

/**
 * trigger inputs are resolved at fire time (webhook payload CEL or static
 * literals), so workflow-body evaluation must leave them raw
 */
export function isTriggerInputsPath(path: string): boolean {
  return path === "trigger.inputs" ||
    path.startsWith("trigger.inputs.") ||
    path.startsWith("trigger.inputs[");
}

/**
 * guards are evaluated at step execution against runtime state, so
 * workflow-body evaluation must leave them raw
 */
export function isGuardPath(path: string): boolean {
  return path.endsWith(".guard");
}

/**
 * a step name is an identifier: a spliced secret keeps the
 * sensitive-<vault>.<key> stand-in, never the value or its sentinel
 */
export function isStepNamePath(path: string): boolean {
  return /^jobs\[\d+\]\.steps\[\d+\]\.name$/.test(path);
}

const INPUTS_DOT_PATTERN = /(?<!\.)inputs\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

const INPUTS_BRACKET_PATTERN = /(?<!\.)inputs\["([^"]+)"\]/g;

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
