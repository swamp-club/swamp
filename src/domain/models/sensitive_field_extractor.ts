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
import {
  isExpressionsOnly,
  scanExpressions,
} from "../expressions/expression_scanner.ts";
import {
  codeAroundMetadata,
  extractFieldsWithMetadata,
  type FieldMetadata,
  findValuesWithMetadata,
  schemaHoldsMetadata,
} from "./zod_field_metadata.ts";
import {
  schemaDeclaredKeys,
  schemaTransformsValues,
} from "./zod_type_coercion.ts";

/**
 * Information about a sensitive field extracted from a Zod schema.
 */
export interface SensitiveFieldInfo {
  /** Dot-separated path to the field (e.g., "credentials.apiKey") */
  path: string;
  /** Optional vault name override from field metadata */
  vaultName?: string;
  /** Optional vault key override from field metadata */
  vaultKey?: string;
}

/**
 * Metadata shape expected on sensitive fields.
 */
interface SensitiveMetadata {
  sensitive?: boolean;
  vaultName?: string;
  vaultKey?: string;
}

/**
 * Extracts sensitive field information from a Zod schema.
 *
 * Walks the schema's object shape recursively, checking each field for
 * `{ sensitive: true }` metadata via `z.globalRegistry`. Handles both
 * `.meta().optional()` and `.optional().meta()` orderings.
 *
 * @param schema - A Zod schema (typically an object schema)
 * @param prefix - Path prefix for nested fields (used in recursion)
 * @returns Array of sensitive field info objects
 */
export function extractSensitiveFields(
  schema: z.ZodTypeAny,
  prefix = "",
): SensitiveFieldInfo[] {
  return extractFieldsWithMetadata(schema, isSensitive, prefix).map(
    ({ path, meta }) => toSensitiveFieldInfo(path, meta),
  );
}

function isSensitive(meta: FieldMetadata): boolean {
  return Boolean((meta as SensitiveMetadata).sensitive);
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
 * Determines whether a string is composed solely of CEL template expressions
 * (one or more `${{ ... }}`) with only whitespace around or between them,
 * each of which reads something at runtime.
 *
 * Such a value carries no cleartext secret — the secret is resolved at runtime
 * from a vault/env reference. A string mixing a literal with an expression
 * (e.g. `prefix-${{ vault.get(...) }}`) is NOT expression-only: the literal
 * portion would still be persisted in cleartext. Neither is an expression
 * that reads nothing, such as `${{ literal('hunter2') }}` or
 * `${{ 'hunter2' }}`: its text is the secret, stored as written. The empty
 * string and null carry no text, so they stay safe, and so does an
 * expression that does not parse, which never evaluates to a value.
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
 * Whether a string still holds an expression that reads something at
 * runtime — `vault.get`, `env.X`, a data read a workflow deferred — or one
 * that does not parse and so never becomes a value. This describes syntax
 * only: a caller must check provenance before trusting the surrounding text
 * or treating an expression-shaped input as pending code. Unlike
 * {@link isLiteralSecret}, which refuses a mixed string at save time because
 * the text around the expression would be stored, this asks only whether the
 * expression part is still to come.
 */
export function holdsRuntimeExpression(value: string): boolean {
  return scanExpressions(value).some((span) =>
    freeRoots(span.inner)?.size !== 0
  );
}

/**
 * Reports whether a value supplied for a sensitive field is a literal secret
 * that would be persisted in cleartext.
 *
 * - `undefined`/`null` and empty/whitespace-only strings carry no secret.
 * - A string that is composed solely of `${{ ... }}` expressions that read
 *   something at runtime (e.g. a `vault.get(...)` reference) is safe. A
 *   constant expression such as `${{ literal('hunter2') }}` is not.
 * - An array or plain object (record/map) is a literal secret iff any leaf
 *   value is one — an all-`vault.get(...)` map carries no cleartext; an empty
 *   container carries no secret.
 * - Any other present value — a non-expression string, a string mixing literal
 *   text with an expression, or a bare non-string scalar (number/boolean) — is
 *   treated as a literal secret. Bare non-string scalars cannot be expression
 *   references, so they fail closed.
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

/**
 * Returns the paths of global-argument fields marked `{ sensitive: true }`
 * in `schema` whose value in `args` is a literal secret (see
 * {@link isLiteralSecret}). An empty result means every sensitive global
 * argument is either absent or a runtime expression and is safe to persist.
 *
 * This is the shared rule enforced at every seam that persists user-supplied
 * `globalArguments` — primarily the persistence chokepoint
 * (`YamlDefinitionRepository.save`), and additionally `model create` /
 * direct-execution for an earlier, friendlier error. A literal value supplied
 * for a sensitive global argument would otherwise be written in cleartext into
 * the definition YAML.
 *
 * The schema and the supplied values are walked together, so a sensitive
 * field is found inside objects (`credentials.apiKey`), array elements and
 * tuple items (`users[0].password`), record values (`accounts.prod.token`),
 * `.catchall()` keys and union members. A value that is not the array or
 * object its schema declares (`tokens: "hunter2"` for an array of tokens) is
 * reported whole. See `findValuesWithMetadata` for what the walk does not
 * reach. {@link redactSensitiveValues} and {@link extractSensitiveFieldValues}
 * walk the same way, so a field this guard sends to a vault is also masked
 * once it is resolved.
 *
 * @param schema - The global-arguments Zod schema for the model type
 * @param args - The supplied global-argument values
 * @returns Paths of sensitive fields holding a literal secret
 */
export function findLiteralSensitiveGlobalArgs(
  schema: z.ZodTypeAny | undefined,
  args: Record<string, unknown> | undefined,
): string[] {
  return findLiteralSensitiveValues(schema, args).map(({ path }) => path);
}

/** A sensitive value that is a literal secret, and where it sits in `args`. */
export interface LiteralSensitiveValue {
  /** The path as {@link findLiteralSensitiveGlobalArgs} spells it. */
  path: string;
  /** The keys that lead to the value from the root of the arguments. */
  keys: (string | number)[];
  value: unknown;
}

/**
 * The values {@link findLiteralSensitiveGlobalArgs} reports, each with the
 * keys that lead to it, for a caller that acts on the value's position
 * rather than its spelling — the evaluated cache, which masks some of them
 * (swamp-club#3681). Same walk, same rule.
 */
export function findLiteralSensitiveValues(
  schema: z.ZodTypeAny | undefined,
  args: Record<string, unknown> | undefined,
): LiteralSensitiveValue[] {
  return findSensitiveValues(schema, args).filter(({ value }) =>
    isLiteralSecret(value)
  );
}

/** Sensitive positions, including expression-shaped values supplied as data. */
export function findSensitiveValues(
  schema: z.ZodTypeAny | undefined,
  args: Record<string, unknown> | undefined,
): LiteralSensitiveValue[] {
  if (!schema || !args) {
    return [];
  }
  return findValuesWithMetadata(schema, args, isSensitive)
    .map(({ path, keys, value }) => ({ path, keys, value }));
}

/**
 * Builds the user-facing remediation message for one or more sensitive global
 * arguments that were supplied as literal values. Shared by every call site so
 * the guidance is identical whether the rejection comes from the persistence
 * chokepoint, `model create`, or direct execution.
 */
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

/**
 * `--global-arg` keys are dot paths, so a path naming an array element cannot
 * be passed back as a key. Says how to set such a field instead.
 */
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

/** Machine-readable error code for a rejected literal sensitive global argument. */
export const LITERAL_SENSITIVE_GLOBAL_ARG_CODE = "literal_sensitive_global_arg";

/**
 * Value-free remediation guidance for a single sensitive global argument found
 * holding a cleartext literal. Carries only the field path and the vault
 * coordinates to migrate the secret to — never the secret value itself.
 */
export interface SensitiveArgRemediation {
  /**
   * Path of the offending sensitive global argument, for display: a field in
   * an array element reads `users[0].password`, which is not a
   * `--global-arg` key.
   */
  path: string;
  /** Suggested vault name to store the secret under. */
  vaultName: string;
  /** Suggested vault key to store the secret under. */
  vaultKey: string;
  /** The `vault.get(...)` expression to set as the argument's value. */
  expression: string;
}

/** Fallback vault name used when a sensitive field declares no `vaultName`. */
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
 * Returns the last key a path names, as a vault key: `apiKey` for
 * `credentials.apiKey`. A quoted key holds characters that do not belong in a
 * vault key or a shell command, so it is reduced the way an element path is:
 * `api-key` for `credentials["api key"]`.
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

/**
 * Turns an element path into a vault key: every run of characters outside
 * letters, digits, `_` and `-` becomes one `-`.
 */
function vaultKeyForElementPath(path: string): string {
  const key = path.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return key || "secret";
}

/**
 * Builds value-free remediation guidance for sensitive global arguments that
 * were found holding a literal secret (see {@link findLiteralSensitiveGlobalArgs}).
 *
 * This is the structured sibling of {@link literalSensitiveGlobalArgsMessage}:
 * both point the user at the same fix — store the secret in a vault and
 * reference it with a `vault.get(...)` expression — but this returns per-path
 * coordinates a diagnostic can render as concrete commands.
 *
 * The output never contains the secret value: only the field path and the
 * suggested vault name/key. When a field declares `vaultName`/`vaultKey`
 * metadata, those are used; otherwise the vault name falls back to
 * `"my-vault"` and the key to the field's leaf path segment.
 *
 * A field inside an array element or a record value occurs once per element,
 * so its key is built from the whole path (`users[0].password` gives
 * `users-0-password`) rather than from a declared `vaultKey` or the leaf
 * segment, either of which would point every element at the same secret.
 * A key that is not declared gets a numeric suffix when it equals another
 * key suggested in the same call. Keys already in the vault are not consulted.
 * These paths, and any path holding a quoted key, are only matched to their
 * field's metadata when `args` is given.
 *
 * @param leakedPaths - Paths returned by `findLiteralSensitiveGlobalArgs`
 * @param schema - The global-arguments schema, read for vault metadata overrides
 * @param args - The global-argument values the paths were found in
 * @returns One remediation per leaked path, in input order
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
 * Returns a redacted clone of `data` with every field marked `{ sensitive: true }`
 * in `schema` replaced by `"***"`.
 *
 * This is the canonical redaction primitive shared by every surface that must
 * scrub sensitive values before display or persistence (reports, `model get`).
 * It does not mutate the input — callers receive a deep clone. Only fields that
 * are actually present in `data` are redacted; absent sensitive fields are left
 * untouched. The schema and the data are walked together (see
 * `findValuesWithMetadata`), so fields inside nested objects, array elements,
 * record values and union members are redacted too.
 *
 * @param schema - A Zod schema (typically a global-arguments or method-argument schema)
 * @param data - The data object to redact
 * @returns A deep clone of `data` with sensitive fields set to `"***"`
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
 * Returns a clone of `data` with every literal secret under a field marked
 * `{ sensitive: true }` in `schema` replaced by `"***"`, for display.
 *
 * A value is masked when {@link findLiteralSensitiveGlobalArgs} would refuse
 * it: plain text, a constant expression, a bare number or boolean, or a
 * container holding any of those (masked whole). A value made only of
 * runtime expressions, such as a `vault.get(...)` reference, is kept as
 * written, since its text names where the secret lives and is not the secret.
 * Unlike {@link redactSensitiveValues}, which masks every sensitive value, this
 * keeps that reference visible. The input is not mutated, and is returned as
 * is when nothing is masked.
 *
 * @param schema - A global-arguments or method-argument Zod schema
 * @param data - The argument values to mask
 * @returns `data`, or a deep clone with literal sensitive values set to `"***"`
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
 * Returns a deep clone of `data` with every leaf value replaced by `"***"`.
 * Used as the fallback redaction strategy when no Zod schema is available
 * to drive field-level redaction — all values are assumed sensitive.
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
 * Recursively collects the secret text of a value tree into `out`: every
 * string, and every finite number or bigint as it prints, since a sensitive
 * number (a PIN, an account number) echoed in an error or a log reads as
 * that text (swamp-club#3681). Enters arrays, plain objects (records/maps),
 * Maps, Sets, and the own entries of any other object a transform may
 * deliver, which also contributes how it prints when it prints as more than
 * `[object X]` (a URL its href, a Date its time); a binary buffer holds no
 * text, and an object whose own entries cannot be read (a getter that
 * throws) contributes only how it prints. An object's own keys, and a Map's
 * string or numeric keys as they print, are collected too when `includeKey`
 * accepts them, and never without it. A boolean is not a secret. A string
 * that is exactly a vault secret sentinel is skipped: it stands for a
 * reference, and the load that delivers its value registers that value. A
 * value that contains itself is entered once.
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
  if (Array.isArray(value)) {
    for (const element of value) {
      collectSecretStrings(element, out, includeKey, seen);
    }
    return;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      // A Map key is a key: collected as an object's would be, as it prints.
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
    const prints = (value as { toString?: unknown }).toString;
    if (typeof prints === "function" && prints !== Object.prototype.toString) {
      try {
        out.push(String(value));
      } catch {
        // A value that cannot print cannot be echoed as text.
      }
    }
  }
  let entries: [string, unknown][];
  try {
    entries = Object.entries(value as Record<string, unknown>);
  } catch {
    // An own getter that throws cannot be read, here or by the method.
    return;
  }
  for (const [k, v] of entries) {
    if (includeKey?.(k)) out.push(k);
    collectSecretStrings(v, out, includeKey, seen);
  }
}

/** The keys and array indexes a value spells, at any depth. */
export interface SpelledKeys {
  /** Every own key of every plain object. */
  keys: Set<string>;
  /** Every index of every array. */
  indices: Set<number>;
}

/**
 * Every own key of every plain object in `value`, and every index of every
 * array, at any depth. A parse's input is read this way to tell the keys
 * and indexes the method's arguments spelled from those its schema
 * introduced (swamp-club#3681).
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

/** The keys of {@link inputKeysOf}. */
export function objectKeysOf(value: unknown): Set<string> {
  return inputKeysOf(value).keys;
}

/** What {@link extractSensitiveFieldValues} collects beyond values. */
export interface SensitiveValueOptions {
  /**
   * Collects the own keys of every object under a sensitive position that
   * this accepts, as a key a schema transform derived from a value is a
   * secret like the value (swamp-club#3681); without it, keys are left out.
   * Never applied inside what a reshaping node delivered whole (see
   * `delivered`).
   */
  includeKey?: (key: string) => boolean;
  /**
   * The data is what a parse delivered, not what it was given: a
   * `.transform()`, codec, `.overwrite()` or `.catch()` that encloses a
   * sensitive position may have moved its value under any key, so the
   * values such a node delivered are collected whole (swamp-club#3681). The
   * keys in it are not: its own code wrote them, and an identifier such as
   * `headers` or `Authorization` held by the redactor would mask every
   * occurrence in unrelated output (swamp-club#3754). A secret that code
   * moved into a key is therefore not collected; a key under a position the
   * schema itself marks still is, as `includeKey` accepts it.
   */
  delivered?: boolean;
  /**
   * Text left out of what a node delivered whole: the values the input holds
   * at positions its schema leaves plain, which the schema itself declares
   * no secret. A value a schema node marks itself is never left out.
   */
  exclude?: ReadonlySet<string>;
}

/**
 * Extracts the runtime secret values from a data value based on its Zod
 * schema.
 *
 * For each value under a field marked `{ sensitive: true }` in the schema,
 * wherever the field sits (nested objects, array elements, record values,
 * union members — see `findValuesWithMetadata`), and for the whole value
 * when the schema marks its root, as a pipeline delivering a sensitive
 * array or scalar does (swamp-club#3681):
 * - String values are collected directly, and a number as its text.
 * - Array and plain-object values have each string and number inside them
 *   collected.
 * - Undefined, null and boolean values are skipped.
 *
 * Used to register sensitive argument values with SecretRedactor before
 * method execution so they are scrubbed from log files and result resources.
 * The data is read as stored unless `delivered` says it is a parse's output.
 *
 * @param schema - A Zod schema (typically a method argument schema)
 * @param data - The resolved data to extract values from, of any shape
 * @param options - Whether object keys under a sensitive position count, and
 *   whether the data is what a parse delivered
 * @returns Array of secret string values to register with SecretRedactor
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
      collectSecretStrings(
        getNestedValue(data as Record<string, unknown>, field.path),
        secrets,
        // In what a parse delivered, a field's path may lead into what a
        // reshaping node made, whose keys its code wrote. The walk below
        // collects the keys at every position the schema marks.
        options.delivered ? undefined : options.includeKey,
      );
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
 * The secret text a parse delivered that the values registered before the
 * parse do not cover (swamp-club#3681): what sits under the sensitive
 * positions of `delivered` as the schema parsed it, a transform's output and
 * a number included, every object key the parse introduced there, and the
 * values of what a transform, codec, overwrite or catch enclosing a
 * sensitive position delivered, since it may have moved the value under any
 * key. The keys of such a whole are not collected, since its code wrote
 * them (swamp-club#3754). As a refusal does (see
 * {@link extractRefusedSensitiveValues}), text `parseInput` holds only at
 * positions the schema leaves plain (see {@link plainTextsOf}) is left out of
 * such a whole, and a key the schema declares is not collected, so a region,
 * a port, a year or a field name a transform passes through is not masked out
 * of every log and resource; a value a schema node marks itself is collected
 * whatever the input holds.
 *
 * @param schema - The arguments schema the parse ran
 * @param parseInput - What the parse received
 * @param delivered - What the parse delivered
 * @returns The text to register with SecretRedactor before the method runs
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

/** The parts of a parse issue a refusal can echo. */
export interface RefusedIssue {
  readonly path: readonly PropertyKey[];
  /** What the failing check received, reported with `reportInput`. */
  readonly input?: unknown;
}

/**
 * The secret text a refused parse of `input` against `schema` may echo:
 * the `input` of every issue at, under or above a sensitive position of
 * `input`, which under a transform is what the transform made of the value
 * and not the value the caller registered before the parse, plus any object
 * key in it the parse introduced (swamp-club#3681). When the schema
 * transforms values anywhere, an issue's path names a position in the
 * transformed shape, and when the schema's own code encloses a sensitive
 * position, an issue it adds may sit at any path (see
 * {@link codeAroundMetadata}), so every issue counts. An issue above a
 * position, or one that counts for that reason, may have received plain
 * values beside the sensitive one, and a run shares its redactor across
 * every step: text `input` holds only at positions the schema leaves plain
 * (see {@link plainTextsOf}), and a key the schema declares, are left out,
 * so a region or a field name is not masked out of every later log and
 * resource. A schema that marks nothing yields nothing.
 *
 * @param schema - The arguments schema the parse ran
 * @param input - What the parse received
 * @param issues - The parse's issues, with their inputs
 * @returns The text to register with SecretRedactor before reporting
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
 * The text `input` holds only at positions `schema` leaves plain: every
 * string in it less those under a sensitive position, a schema marked at its
 * root included. The schema itself declares such text no secret, so a value
 * a sensitive position holds counts as sensitive even where a plain position
 * holds it too.
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
 * The sensitive positions of `input` under `schema`, as key paths; a
 * schema marked at its root gives the root. Undefined when no path can be
 * trusted (swamp-club#3681): the schema transforms values anywhere, so an
 * issue's path names a position in the transformed shape, which the input
 * cannot locate; or its own code encloses a sensitive position (a custom
 * check, a node-level error map or a pipe on an enclosing node, or on a
 * union or intersection member beside one), so an issue it adds, written
 * from the value, may sit at any path. Every issue then counts.
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

/** Whether an issue at `path` sits at, under or above `position`. */
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

/** The names of the errors the runtime itself throws. */
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
 * The error to report when a schema throws while parsing instead of adding
 * an issue. A schema marking nothing sensitive has its throw reported as it
 * is. One marking a field has the message withheld: a transform throws with
 * whatever it was given or made of it, which nothing has registered, since
 * the parse delivered nothing (swamp-club#3681). The error's name is written
 * as the schema's code may have set it, so only a standard name is reported.
 * Zod's own error for an async check met by a synchronous parse names no
 * input and is returned as it is, so its advice to parse asynchronously
 * reaches the author. A run throws what this returns; a validation reports
 * its message, see {@link schemaThrowMessage}.
 *
 * @param error - What the parse threw
 * @param schema - The arguments schema the parse ran
 * @param subject - What was parsed, as the report names it
 * @returns `error`, or the error that withholds its message
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
 * The message a validation reports for a schema that threw while parsing:
 * the withheld message of {@link schemaThrew} when the schema marks a field
 * sensitive, the throw's own message otherwise.
 */
export function schemaThrowMessage(
  error: unknown,
  schema: z.ZodTypeAny,
  subject: string,
): string {
  const reported = schemaThrew(error, schema, subject);
  return reported instanceof Error ? reported.message : String(reported);
}

/** The mask a refusal shows for a path segment the parse introduced. */
const MASK = "***";

/** An issue of a refused parse as a refusal may report it: nothing else. */
export interface ReportedIssue {
  readonly code: string;
  /** The issue's path, with every segment the parse introduced masked. */
  readonly path: (string | number)[];
  readonly message: string;
}

/**
 * The issues of a refused parse of `input` against `schema` as the refusal
 * may report them (swamp-club#3681), each reduced to its code, path and
 * message: an issue's other fields hold what the failing check received and
 * whatever the schema's code set, and travel no further.
 *
 * The schema's own code writes an issue's message and may add path
 * segments, and wherever it holds a sensitive value, what it writes may
 * spell the value in a form nothing registered. An issue at, under or above
 * a sensitive position is therefore described in Zod's own words for its
 * kind instead, read from the issue's fields, which name a type, a bound, a
 * format or the schema's literals and never the value. When the schema
 * transforms values anywhere, or its own code encloses a sensitive position
 * (see {@link codeAroundMetadata}), an issue it adds may sit at any path, so
 * every issue is described this way; only an issue beside every sensitive
 * position, in a schema whose code encloses none, keeps its message. When a
 * `superRefine()`, a `.check()` or a pipe sits at or above a sensitive
 * position, an issue's fields may be its code's own too, so a described
 * issue is then `Invalid input` and nothing more. A path segment that
 * neither the input spelled nor the schema declares, an index into no array
 * the input holds, or a symbol, came from the schema's code, and is masked
 * in every issue. A schema that marks nothing keeps every message.
 *
 * @param schema - The arguments schema the parse ran
 * @param input - What the parse received
 * @param issues - The parse's issues
 * @returns The issues to format, in order
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

/**
 * Gets a nested value from an object by dot-separated path.
 */
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

/**
 * Sets a nested value in an object by dot-separated path.
 */
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
