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
import { SENTINEL_EXACT } from "../vaults/secret_bag_registry.ts";
import { freeRoots, isBlankConstant } from "../expressions/cel_grammar.ts";
import { indexPath, keyPath } from "../expressions/provenance_map.ts";
import {
  isExpressionsOnly,
  scanExpressions,
} from "../expressions/expression_scanner.ts";
import {
  codeAroundMetadata,
  collectFieldMetadata,
  extractFieldsWithMetadata,
  type FieldMetadata,
  findValuesWithMetadata,
  schemaHoldsMetadata,
  type ValueWithMetadata,
} from "./zod_field_metadata.ts";
import {
  schemaDeclaredKeys,
  schemaTransformsValues,
} from "./zod_type_coercion.ts";

export interface SensitiveFieldInfo {
  path: string;
  vaultName?: string;
  vaultKey?: string;
}

interface SensitiveMetadata {
  sensitive?: boolean;
  vaultName?: string;
  vaultKey?: string;
}

/**
 * walks the object shape for sensitive metadata in either meta ordering; fields
 * inside arrays, records and unions are not reached here (see
 * findSensitiveResourceValues and collectSensitiveFieldMetadata)
 */
export function extractSensitiveFields(
  schema: z.ZodTypeAny,
  prefix = "",
): SensitiveFieldInfo[] {
  return extractFieldsWithMetadata(schema, isSensitive, prefix).map(
    ({ path, meta }) => toSensitiveFieldInfo(path, meta),
  );
}

export interface SensitiveFieldMetadata {
  vaultName?: string;
  vaultKey?: string;
  /**
   * Whether the field sits inside an array element, tuple item, record value
   * or `.catchall()` key, so that a value holds it once per element.
   */
  perElement: boolean;
}

/**
 * reads the schema alone, afresh each call, so later-registered metadata is
 * seen: a missing field would let its value be written in cleartext. Root
 * metadata is excluded.
 */
export function collectSensitiveFieldMetadata(
  schema: z.ZodTypeAny,
): SensitiveFieldMetadata[] {
  return collectFieldMetadata(schema, isSensitive).map(
    ({ meta, perElement }) => {
      const sensitive = meta as SensitiveMetadata;
      return {
        vaultName: sensitive.vaultName,
        vaultKey: sensitive.vaultKey,
        perElement,
      };
    },
  );
}

/**
 * unlike hasSensitiveFields, root-schema metadata does not count, since no
 * value is vaulted for the root
 */
export function schemaHoldsSensitiveFields(schema: z.ZodTypeAny): boolean {
  return collectSensitiveFieldMetadata(schema).length > 0;
}

export function findSensitiveResourceValues(
  schema: z.ZodTypeAny,
  data: unknown,
): (ValueWithMetadata & SensitiveFieldInfo)[] {
  return findValuesWithMetadata(schema, data, isSensitive).map((found) => ({
    ...found,
    ...toSensitiveFieldInfo(found.path, found.meta),
  }));
}

function isSensitive(meta: FieldMetadata): boolean {
  return Boolean((meta as SensitiveMetadata).sensitive);
}

export function hasSensitiveFields(schema: z.ZodTypeAny): boolean {
  return schemaHoldsMetadata(schema, isSensitive);
}

function toSensitiveFieldInfo(
  path: string,
  meta: FieldMetadata,
): SensitiveFieldInfo {
  const sensitive = meta as SensitiveMetadata;
  return {
    path,
    vaultName: sensitive.vaultName,
    vaultKey: sensitive.vaultKey,
  };
}

/**
 * expression-only strings carry no cleartext secret; a literal mixed with an
 * expression, or an expression reading nothing such as literal('x'), is stored
 * as written. Unparseable expressions never evaluate, so they are safe.
 */
function isRuntimeExpressionOnly(value: string): boolean {
  if (!isExpressionsOnly(value)) {
    return false;
  }
  return scanExpressions(value).every((span) =>
    freeRoots(span.inner)?.size !== 0 || isBlankConstant(span.inner)
  );
}

/**
 * syntax only: whether an expression part is still to come. A caller must check
 * provenance before trusting surrounding text; isLiteralSecret instead refuses
 * mixed strings because the surrounding text would be stored.
 */
export function holdsRuntimeExpression(value: string): boolean {
  return scanExpressions(value).some((span) =>
    freeRoots(span.inner)?.size !== 0
  );
}

/**
 * expression-only strings reading runtime data are safe; arrays and objects are
 * secret iff any leaf is; any other present value, even a non-string scalar, is
 * a literal secret (fails closed)
 */
export function isLiteralSecret(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      return false;
    }
    return !isRuntimeExpressionOnly(value);
  }
  if (Array.isArray(value)) {
    return value.some(isLiteralSecret);
  }
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return Object.values(value as Record<string, unknown>).some(
      isLiteralSecret,
    );
  }
  return true;
}

export function sensitiveGlobalArgPaths(
  schema: z.ZodTypeAny | undefined,
  args: Record<string, unknown> | undefined,
): string[] {
  if (!schema || !args) return [];
  return findValuesWithMetadata(schema, args, isSensitive).map(({ keys }) =>
    keys.reduce<string>(
      (path, key) =>
        typeof key === "number" ? indexPath(path, key) : keyPath(path, key),
      "",
    )
  );
}

/**
 * One line of a refusal to store expression text in a sensitive field. The
 * text is the sensitive value, so the line never repeats it.
 */
export function withheldSensitiveTextLine(path: string): string {
  return `  ${path}: (value withheld) (is in a sensitive field, which would store it in cleartext)`;
}

/**
 * shared rule enforced where user globalArguments are persisted (the repository
 * save chokepoint, and earlier at create and direct execution); a literal would
 * otherwise reach the YAML in cleartext. Walks schema and values together.
 */
export function findLiteralSensitiveGlobalArgs(
  schema: z.ZodTypeAny | undefined,
  args: Record<string, unknown> | undefined,
): string[] {
  return findLiteralSensitiveValues(schema, args).map(({ path }) => path);
}

export interface LiteralSensitiveValue {
  path: string;
  keys: (string | number)[];
  value: unknown;
  /**
   * set when the value is only potentially sensitive: an input a pipeline
   * transform may carry into a sensitive output, reported with rawInputs
   */
  rawInput?: true;
}

/**
 * same walk and rule as findLiteralSensitiveGlobalArgs, with key positions for
 * callers that act on position rather than spelling, such as the evaluated
 * cache
 */
export function findLiteralSensitiveValues(
  schema: z.ZodTypeAny | undefined,
  args: Record<string, unknown> | undefined,
): LiteralSensitiveValue[] {
  return findSensitiveValues(schema, args).filter(({ value }) =>
    isLiteralSecret(value)
  );
}

/**
 * Sensitive positions, including expression-shaped values supplied as data.
 * `rawInputs` conservatively covers inputs to sensitive pipeline outputs.
 */
export function findSensitiveValues(
  schema: z.ZodTypeAny | undefined,
  args: Record<string, unknown> | undefined,
  rawInputs = false,
): LiteralSensitiveValue[] {
  if (!schema || !args) {
    return [];
  }
  return findValuesWithMetadata(schema, args, isSensitive, { rawInputs })
    .map(({ path, keys, value, rawInput }) => ({
      path,
      keys,
      value,
      ...(rawInput ? { rawInput } : {}),
    }));
}

export function literalSensitiveGlobalArgsMessage(paths: string[]): string {
  const fieldList = paths.map((p) => `'${p}'`).join(", ");
  const subject = paths.length > 1
    ? `Global arguments ${fieldList} are`
    : `Global argument ${fieldList} is`;
  return (
    `${subject} marked sensitive and cannot be set to a literal value or a ` +
    `constant expression such as \${{ literal('...') }} — it would be stored ` +
    `in cleartext in the definition YAML. Store the secret in a vault and ` +
    `reference it with a vault.get expression, e.g. ` +
    `--global-arg "apiKey=\${{ vault.get('my-vault', 'api-key') }}". If a ` +
    `stored definition already holds the value, run \`swamp doctor secrets\` ` +
    `to find it.` + arrayElementHint(paths)
  );
}

function arrayElementHint(paths: string[]): string {
  const arrays = paths.map(outermostArrayPath).filter((a) => a !== undefined);
  if (arrays.length === 0) {
    return "";
  }
  // The array's own path is a usable key only when every segment above it is
  // a plain dot-path segment.
  const name = arrays.find((a) => /^[A-Za-z0-9_.-]+$/.test(a)) ?? "<name>";
  return ` A field inside an array is set by passing the whole array, e.g. ` +
    `--global-arg '${name}:json=[...]'.`;
}

/**
 * Returns the part of a path before its first array index, or undefined when
 * the path crosses no array. A quoted key (`["eu[1]"]`) is skipped whole, so
 * brackets inside it are not read as an index.
 */
function outermostArrayPath(path: string): string | undefined {
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== "[") {
      continue;
    }
    if (path[i + 1] !== '"') {
      return path.slice(0, i);
    }
    for (i += 2; i < path.length && path[i] !== '"'; i++) {
      if (path[i] === "\\") {
        i++;
      }
    }
  }
  return undefined;
}

export const LITERAL_SENSITIVE_GLOBAL_ARG_CODE = "literal_sensitive_global_arg";

export interface SensitiveArgRemediation {
  /**
   * Path of the offending sensitive global argument, for display: a field in
   * an array element reads `users[0].password`, which is not a
   * `--global-arg` key.
   */
  path: string;
  vaultName: string;
  vaultKey: string;
  expression: string;
}

const DEFAULT_REMEDIATION_VAULT = "my-vault";

/** Reads a quoted path segment back; a malformed one is returned as is. */
function unquoteKey(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return quoted;
  }
}

/**
 * last key a path names, as a vault key; a quoted key is reduced like an
 * element path, since it may hold characters unfit for a vault key or shell
 * command
 */
function lastKeyOf(path: string): string {
  let key = "";
  let i = 0;
  while (i < path.length) {
    if (path[i] === ".") {
      i++;
    } else if (path[i] === "[" && path[i + 1] === '"') {
      let end = i + 2;
      while (end < path.length && path[end] !== '"') {
        end += path[end] === "\\" ? 2 : 1;
      }
      key = vaultKeyForElementPath(unquoteKey(path.slice(i + 1, end + 1)));
      i = end + 2;
    } else if (path[i] === "[") {
      const end = path.indexOf("]", i);
      i = end === -1 ? path.length : end + 1;
    } else {
      let end = i;
      while (end < path.length && path[end] !== "." && path[end] !== "[") {
        end++;
      }
      key = path.slice(i, end);
      i = end;
    }
  }
  return key || path;
}

function vaultKeyForElementPath(path: string): string {
  const key = path.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return key || "secret";
}

/**
 * value-free remediation per leaked path: declared vaultName/vaultKey else
 * defaults. Element and record-value fields get a key from the whole path,
 * since a shared key would point every element at one secret.
 */
export function buildSensitiveArgRemediations(
  leakedPaths: string[],
  schema?: z.ZodTypeAny,
  args?: Record<string, unknown>,
): SensitiveArgRemediation[] {
  const fieldsByPath = new Map<string, SensitiveFieldInfo>();
  const elementPaths = new Set<string>();
  if (schema) {
    if (args) {
      for (
        const { path, meta, perElement } of findValuesWithMetadata(
          schema,
          args,
          isSensitive,
        )
      ) {
        if (!fieldsByPath.has(path)) {
          fieldsByPath.set(path, toSensitiveFieldInfo(path, meta));
          if (perElement) {
            elementPaths.add(path);
          }
        }
      }
    }
    for (const field of extractSensitiveFields(schema)) {
      if (!fieldsByPath.has(field.path)) {
        fieldsByPath.set(field.path, field);
      }
    }
  }
  // A declared key is used as written, and fields that declare the same key
  // share it. Every other key is derived, and must differ from every key
  // suggested here.
  const declaredKey = (path: string) =>
    elementPaths.has(path) ? undefined : fieldsByPath.get(path)?.vaultKey;
  const takenKeys = new Set(
    leakedPaths.map(declaredKey).filter((key) => key !== undefined),
  );
  return leakedPaths.map((path) => {
    const vaultName = fieldsByPath.get(path)?.vaultName ??
      DEFAULT_REMEDIATION_VAULT;
    let vaultKey = declaredKey(path);
    if (vaultKey === undefined) {
      const base = elementPaths.has(path)
        ? vaultKeyForElementPath(path)
        : lastKeyOf(path);
      vaultKey = base;
      for (let n = 2; takenKeys.has(vaultKey); n++) {
        vaultKey = `${base}-${n}`;
      }
      takenKeys.add(vaultKey);
    }
    return {
      path,
      vaultName,
      vaultKey,
      expression: `\${{ vault.get('${vaultName}', '${vaultKey}') }}`,
    };
  });
}

/**
 * canonical redaction shared by every surface that scrubs before display or
 * persistence: deep clone, walking schema and data together, only present
 * sensitive fields replaced by ***
 */
export function redactSensitiveValues(
  schema: z.ZodTypeAny,
  data: Record<string, unknown>,
): Record<string, unknown> {
  // Most schemas mark nothing; this is answered once per schema, and spares
  // walking the value on every call.
  if (!schemaHoldsMetadata(schema, isSensitive)) {
    return data;
  }
  // The schema-only pass also masks a field holding null, which the walk
  // skips as absent.
  const fields = extractSensitiveFields(schema).filter((field) =>
    getNestedValue(data, field.path) !== undefined
  );
  const found = findValuesWithMetadata(schema, data, isSensitive);
  if (fields.length === 0 && found.length === 0) {
    return data;
  }

  const redacted = structuredClone(data);
  for (const field of fields) {
    setNestedValue(redacted, field.path, "***");
  }
  for (const { keys } of found) {
    let parent: unknown = redacted;
    for (const key of keys.slice(0, -1)) {
      // A parent already masked is a string by now, and covers this value.
      parent = typeof parent === "object" && parent !== null
        ? (parent as Record<string | number, unknown>)[key]
        : undefined;
    }
    const last = keys.at(-1);
    if (typeof parent === "object" && parent !== null && last !== undefined) {
      (parent as Record<string | number, unknown>)[last] = "***";
    }
  }
  return redacted;
}

/**
 * masks values findLiteralSensitiveGlobalArgs would refuse, for display;
 * runtime-expression-only values such as vault.get references stay visible
 * since they name where the secret lives. Input is not mutated.
 */
export function maskLiteralSensitiveValues(
  schema: z.ZodTypeAny,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!schemaHoldsMetadata(schema, isSensitive)) {
    return data;
  }
  const literals = findValuesWithMetadata(schema, data, isSensitive).filter((
    { value },
  ) => isLiteralSecret(value));
  if (literals.length === 0) {
    return data;
  }

  const masked = structuredClone(data);
  for (const { keys } of literals) {
    let parent: unknown = masked;
    for (const key of keys.slice(0, -1)) {
      // A parent already masked is a string by now, and covers this value.
      parent = typeof parent === "object" && parent !== null
        ? (parent as Record<string | number, unknown>)[key]
        : undefined;
    }
    const last = keys.at(-1);
    if (typeof parent === "object" && parent !== null && last !== undefined) {
      (parent as Record<string | number, unknown>)[last] = "***";
    }
  }
  return masked;
}

/**
 * fallback redaction when no schema is available: every leaf value is assumed
 * sensitive
 */
export function redactAllValues(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = structuredClone(data);
  for (const key of Object.keys(redacted)) {
    redacted[key] = "***";
  }
  return redacted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

/**
 * collects the secret text of a value tree, numbers as they print, and keys
 * only if includeKey accepts them. Exact vault sentinels are skipped as
 * references; unreadable values contribute what was read.
 */
function collectSecretStrings(
  value: unknown,
  out: string[],
  includeKey?: (key: string) => boolean,
  seen: Set<object> = new Set(),
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === "string") {
    if (!SENTINEL_EXACT.test(value)) out.push(value);
    return;
  }
  if (typeof value === "bigint" || Number.isFinite(value)) {
    out.push(String(value));
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const element of value) {
        collectSecretStrings(element, out, includeKey, seen);
      }
      return;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        // A Map key is a key: collected as an object's would be, as it
        // prints.
        const keyText = typeof key === "string"
          ? key
          : typeof key === "bigint" || Number.isFinite(key)
          ? String(key)
          : undefined;
        if (keyText !== undefined && includeKey?.(keyText)) out.push(keyText);
        collectSecretStrings(entry, out, includeKey, seen);
      }
      return;
    }
    if (value instanceof Set) {
      for (const entry of value) {
        collectSecretStrings(entry, out, includeKey, seen);
      }
      return;
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      return;
    }
    if (!isPlainObject(value)) {
      try {
        const prints = (value as { toString?: unknown }).toString;
        if (
          typeof prints === "function" && prints !== Object.prototype.toString
        ) {
          out.push(String(value));
        }
      } catch {
        // A value that cannot print cannot be echoed as text.
      }
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (includeKey?.(k)) out.push(k);
      collectSecretStrings(v, out, includeKey, seen);
    }
  } catch {
    // A value the walk cannot read (a revoked Proxy, an own getter that
    // throws) cannot be read by the method either; what was collected
    // stays.
  }
}

export interface SpelledKeys {
  keys: Set<string>;
  indices: Set<number>;
}

/**
 * every own key of every plain object and every array index at any depth; a
 * parse's input is read this way to tell spelled keys from those its schema
 * introduced
 */
export function inputKeysOf(value: unknown): SpelledKeys {
  const keys = new Set<string>();
  const indices = new Set<number>();
  const seen = new Set<object>();
  const visit = (node: unknown) => {
    if (typeof node !== "object" || node === null || seen.has(node)) {
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        indices.add(index);
        visit(item);
      });
    } else if (isPlainObject(node)) {
      for (const [key, item] of Object.entries(node)) {
        keys.add(key);
        visit(item);
      }
    }
  };
  visit(value);
  return { keys, indices };
}

export function objectKeysOf(value: unknown): Set<string> {
  return inputKeysOf(value).keys;
}

export interface SensitiveValueOptions {
  /**
   * collects keys under a sensitive position that this accepts, since a key a
   * transform derived from a value is a secret too; never applied inside what a
   * reshaping node delivered whole
   */
  includeKey?: (key: string) => boolean;
  /**
   * data is a parse's output: values a transform, codec, overwrite or catch
   * delivered are collected whole, but not their keys, as code wrote them and
   * masking names like headers would hit unrelated output
   */
  delivered?: boolean;
  /**
   * text left out of what a node delivered whole: values at positions the
   * schema leaves plain, which it declares no secret. A value a schema node
   * marks itself is never left out.
   */
  exclude?: ReadonlySet<string>;
}

/**
 * collects runtime secrets under sensitive fields (or the whole value if the
 * root is marked): strings, and numbers as text, inside arrays and objects;
 * undefined, null and booleans are skipped
 */
export function extractSensitiveFieldValues(
  schema: z.ZodTypeAny,
  data: unknown,
  options: SensitiveValueOptions = {},
): string[] {
  if (!schemaHoldsMetadata(schema, isSensitive)) {
    return [];
  }
  const secrets: string[] = [];

  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    for (const field of extractSensitiveFields(schema)) {
      const texts: string[] = [];
      collectSecretStrings(
        getNestedValue(data as Record<string, unknown>, field.path),
        texts,
        // In what a parse delivered, a field's path may lead into what a
        // reshaping node made, whose keys and plain values its code wrote:
        // they are left out as from that whole. The walk below collects
        // every position the schema marks, keys included.
        options.delivered ? undefined : options.includeKey,
      );
      for (const text of texts) {
        if (!options.delivered || !options.exclude?.has(text)) {
          secrets.push(text);
        }
      }
    }
  }
  for (
    const { value, rawInput } of findValuesWithMetadata(
      schema,
      data,
      isSensitive,
      { reportRoot: true, transformed: options.delivered },
    )
  ) {
    if (rawInput) {
      // What a reshaping node delivered whole: its values, not its keys.
      const texts: string[] = [];
      collectSecretStrings(value, texts);
      for (const text of texts) {
        if (!options.exclude?.has(text)) secrets.push(text);
      }
    } else {
      collectSecretStrings(value, secrets, options.includeKey);
    }
  }

  return [...new Set(secrets)];
}

/**
 * secret text a parse delivered that earlier-registered values miss: sensitive
 * positions, introduced keys, and values of reshaping nodes whole (not their
 * keys). Text only at plain input positions is left out.
 */
export function extractDeliveredSensitiveValues(
  schema: z.ZodTypeAny,
  parseInput: unknown,
  delivered: unknown,
): string[] {
  if (!schemaHoldsMetadata(schema, isSensitive)) {
    return [];
  }
  const spelled = objectKeysOf(parseInput);
  const declared = schemaDeclaredKeys(schema);
  return extractSensitiveFieldValues(schema, delivered, {
    includeKey: (key) => !spelled.has(key) && !declared.has(key),
    delivered: true,
    exclude: plainTextsOf(schema, parseInput),
  });
}

export interface RefusedIssue {
  readonly path: readonly PropertyKey[];
  readonly input?: unknown;
}

/**
 * secret text a refused parse may echo: issue inputs at, under or above a
 * sensitive position (every issue if transforms or schema code enclose one).
 * Plain-position text is left out so it is not masked everywhere.
 */
export function extractRefusedSensitiveValues(
  schema: z.ZodTypeAny,
  input: unknown,
  issues: readonly RefusedIssue[],
): string[] {
  if (!schemaHoldsMetadata(schema, isSensitive)) {
    return [];
  }
  const spelled = objectKeysOf(input);
  const declared = schemaDeclaredKeys(schema);
  const includeKey = (key: string) => !spelled.has(key) && !declared.has(key);
  const plain = plainTextsOf(schema, input);
  const positions = sensitivePositions(schema, input);
  const secrets: string[] = [];
  for (const issue of issues) {
    if (
      positions && !positions.some((position) => meets(position, issue.path))
    ) {
      continue;
    }
    const texts: string[] = [];
    collectSecretStrings(issue.input, texts, includeKey);
    for (const text of texts) {
      if (!plain.has(text)) secrets.push(text);
    }
  }
  return [...new Set(secrets)];
}

/**
 * text the input holds only at plain positions; a value a sensitive position
 * also holds still counts as sensitive
 */
function plainTextsOf(schema: z.ZodTypeAny, input: unknown): Set<string> {
  const marked: string[] = [];
  if (isPlainObject(input)) {
    for (const field of extractSensitiveFields(schema)) {
      collectSecretStrings(getNestedValue(input, field.path), marked);
    }
  }
  for (
    const { value } of findValuesWithMetadata(schema, input, isSensitive, {
      reportRoot: true,
    })
  ) {
    collectSecretStrings(value, marked);
  }
  const sensitive = new Set(marked);
  const texts: string[] = [];
  collectSecretStrings(input, texts);
  return new Set(texts.filter((text) => !sensitive.has(text)));
}

/**
 * sensitive positions of input as key paths, undefined when no issue path can
 * be trusted (transforms, or schema code enclosing a sensitive position can add
 * issues at any path); every issue then counts
 */
function sensitivePositions(
  schema: z.ZodTypeAny,
  input: unknown,
): string[][] | undefined {
  if (
    schemaTransformsValues(schema) ||
    codeAroundMetadata(schema, isSensitive).messages
  ) {
    return undefined;
  }
  return findValuesWithMetadata(schema, input, isSensitive, {
    reportRoot: true,
  }).map((found) => found.keys.map(String));
}

function meets(
  position: readonly string[],
  path: readonly PropertyKey[],
): boolean {
  const depth = Math.min(position.length, path.length);
  for (let i = 0; i < depth; i++) {
    if (position[i] !== String(path[i])) return false;
  }
  return true;
}

const STANDARD_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

/**
 * the error to report when a schema throws: withheld when the schema marks a
 * field sensitive, since a transform may throw with an unregistered value; only
 * standard error names are shown; Zod's async advice passes
 */
export function schemaThrew(
  error: unknown,
  schema: z.ZodTypeAny,
  subject: string,
): unknown {
  if (!schemaHoldsMetadata(schema, isSensitive)) return error;
  if (error instanceof z.core.$ZodAsyncError) return error;
  const name = error instanceof Error
    ? STANDARD_ERROR_NAMES.has(error.name) ? error.name : "an error"
    : `a ${typeof error}`;
  return new Error(
    `${subject} validation failed: the schema threw ${name} while parsing ` +
      `them, and its message is withheld because the schema marks a field ` +
      `sensitive. A transform refuses a value through ctx.addIssue, which ` +
      `is reported in Zod's words with the value masked.`,
  );
}

/**
 * message for a validation whose schema threw: withheld when the schema marks a
 * field sensitive, otherwise the throw's own message
 */
export function schemaThrowMessage(
  error: unknown,
  schema: z.ZodTypeAny,
  subject: string,
): string {
  const reported = schemaThrew(error, schema, subject);
  return reported instanceof Error ? reported.message : String(reported);
}

const MASK = "***";

export interface ReportedIssue {
  readonly code: string;
  readonly path: (string | number)[];
  readonly message: string;
}

/**
 * reduces issues to code, path and message; near sensitive positions the
 * message is Zod's own wording rebuilt from issue fields (never the value), or
 * Invalid input where code may own them; unexplained path segments are masked
 */
export function maskRefusedIssues(
  schema: z.ZodTypeAny,
  input: unknown,
  issues: readonly z.ZodIssue[],
): ReportedIssue[] {
  if (!schemaHoldsMetadata(schema, isSensitive)) {
    return issues.map(({ code, path, message }) => ({
      code,
      path: path.map((segment) => typeof segment === "symbol" ? MASK : segment),
      message,
    }));
  }
  const spelled = inputKeysOf(input);
  const declared = schemaDeclaredKeys(schema);
  const positions = sensitivePositions(schema, input);
  const unread = schemaTransformsValues(schema) ||
    codeAroundMetadata(schema, isSensitive).issues;
  const describe = z.locales.en().localeError;
  const worded = (issue: z.core.$ZodRawIssue): string => {
    const described = describe(issue);
    return typeof described === "string"
      ? described
      : described?.message ?? "Invalid input";
  };
  const known = (key: string) => spelled.keys.has(key) || declared.has(key);
  return issues.map((issue) => {
    const path = issue.path.map((segment) =>
      typeof segment === "string"
        ? known(segment) ? segment : MASK
        : typeof segment === "number" && spelled.indices.has(segment)
        ? segment
        : MASK
    );
    const sensitive = !positions ||
      positions.some((position) => meets(position, issue.path));
    if (!sensitive) {
      return { code: issue.code, path, message: issue.message };
    }
    if (unread) {
      return {
        code: issue.code,
        path,
        message: worded({ code: "custom", input: undefined }),
      };
    }
    // Only an invalid-type description reads the input, and for its type
    // alone, which an instance names after its class: such an input is
    // described as an object. Unrecognized keys are named as the input
    // spelled them or the schema declares them, and masked otherwise.
    // Every other kind is described from the issue's own fields.
    const trusted: z.core.$ZodRawIssue = issue.code === "invalid_type"
      ? {
        ...issue,
        input: typeof issue.input !== "object" || issue.input === null ||
            Array.isArray(issue.input) || isPlainObject(issue.input)
          ? issue.input
          : {},
      }
      : issue.code === "unrecognized_keys"
      ? {
        ...issue,
        keys: issue.keys.map((key) => known(key) ? key : MASK),
        input: undefined,
      }
      : { ...issue, input: undefined };
    return { code: issue.code, path, message: worded(trusted) };
  });
}

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
    // A key the object does not hold is absent, whatever the prototype
    // answers for it (`toString`, `constructor`).
    if (!Object.hasOwn(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

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
