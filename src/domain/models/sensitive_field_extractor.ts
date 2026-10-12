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
import { freeRoots, isBlankConstant } from "../expressions/cel_grammar.ts";
import {
  isExpressionsOnly,
  scanExpressions,
} from "../expressions/expression_scanner.ts";
import {
  extractFieldsWithMetadata,
  type FieldMetadata,
  findValuesWithMetadata,
} from "./zod_field_metadata.ts";

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
function isLiteralSecret(value: unknown): boolean {
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
 * `.catchall()` keys and union members. See `findValuesWithMetadata` for
 * what the walk does not reach. The redaction primitives in this
 * module read the schema alone and still see object-nested fields only.
 *
 * @param schema - The global-arguments Zod schema for the model type
 * @param args - The supplied global-argument values
 * @returns Paths of sensitive fields holding a literal secret
 */
export function findLiteralSensitiveGlobalArgs(
  schema: z.ZodTypeAny | undefined,
  args: Record<string, unknown> | undefined,
): string[] {
  if (!schema || !args) {
    return [];
  }
  return findValuesWithMetadata(schema, args, isSensitive)
    .filter(({ value }) => isLiteralSecret(value))
    .map(({ path }) => path);
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

/**
 * Returns the last key a path names, unquoted: `apiKey` for
 * `credentials.apiKey`, `api key` for `credentials["api key"]`.
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
      key = JSON.parse(path.slice(i + 1, end + 1));
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
 * When two such keys come out the same, the later one gets a numeric suffix.
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
  const elementKeys = new Set<string>();
  return leakedPaths.map((path) => {
    const meta = fieldsByPath.get(path);
    const vaultName = meta?.vaultName ?? DEFAULT_REMEDIATION_VAULT;
    let vaultKey = meta?.vaultKey ?? lastKeyOf(path);
    if (elementPaths.has(path)) {
      const base = vaultKeyForElementPath(path);
      vaultKey = base;
      for (let n = 2; elementKeys.has(vaultKey); n++) {
        vaultKey = `${base}-${n}`;
      }
      elementKeys.add(vaultKey);
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
 * untouched. Nested sensitive fields are handled because `extractSensitiveFields`
 * walks the schema recursively and returns dot-separated paths.
 *
 * @param schema - A Zod schema (typically a global-arguments or method-argument schema)
 * @param data - The data object to redact
 * @returns A deep clone of `data` with sensitive fields set to `"***"`
 */
export function redactSensitiveValues(
  schema: z.ZodTypeAny,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const fields = extractSensitiveFields(schema);
  if (fields.length === 0) {
    return data;
  }

  const redacted = structuredClone(data);
  for (const field of fields) {
    if (getNestedValue(redacted, field.path) !== undefined) {
      setNestedValue(redacted, field.path, "***");
    }
  }
  return redacted;
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

/**
 * Recursively collects all string values from a value tree into `out`.
 * Handles strings, arrays, and plain objects (records/maps).
 */
function collectSecretStrings(value: unknown, out: string[]): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      collectSecretStrings(element, out);
    }
    return;
  }
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectSecretStrings(v, out);
    }
  }
}

/**
 * Extracts the runtime secret values from a data object based on its Zod schema.
 *
 * For each field marked `{ sensitive: true }` in the schema:
 * - String values are collected directly.
 * - Array values have each string element collected individually.
 * - Undefined or null values are skipped.
 * - Object values are skipped (nested object fields are found via recursion).
 *
 * Used to register sensitive argument values with SecretRedactor before
 * method execution so they are scrubbed from log files and result resources.
 *
 * @param schema - A Zod schema (typically a method argument schema)
 * @param data - The resolved data object to extract values from
 * @returns Array of secret string values to register with SecretRedactor
 */
export function extractSensitiveFieldValues(
  schema: z.ZodTypeAny,
  data: Record<string, unknown>,
): string[] {
  const fields = extractSensitiveFields(schema);
  const secrets: string[] = [];

  for (const field of fields) {
    collectSecretStrings(getNestedValue(data, field.path), secrets);
  }

  return secrets;
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
