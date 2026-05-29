// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { containsExpression } from "../expressions/expression_parser.ts";

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
 * Internal Zod v4 definition structure for schema introspection.
 */
interface ZodDef {
  type: string;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  shape?: Record<string, z.ZodTypeAny>;
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
 * Checks metadata on a schema at multiple levels (before and after unwrapping).
 * Handles both `.meta().optional()` and `.optional().meta()` orderings.
 */
function getSensitiveMetadata(
  schema: z.ZodTypeAny,
): SensitiveMetadata | undefined {
  // Check metadata on the outer schema (handles `.optional().meta()`)
  const outerMeta = z.globalRegistry.get(schema) as
    | SensitiveMetadata
    | undefined;
  if (outerMeta?.sensitive) {
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
        | SensitiveMetadata
        | undefined;
      if (innerMeta?.sensitive) {
        return innerMeta;
      }
      current = def.innerType;
    } else if (schemaType === "effects" && def.schema) {
      const innerMeta = z.globalRegistry.get(def.schema) as
        | SensitiveMetadata
        | undefined;
      if (innerMeta?.sensitive) {
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
  const unwrapped = unwrapSchema(schema);
  const schemaType = getSchemaType(unwrapped);

  if (schemaType !== "object") {
    return [];
  }

  const def = getSchemaDef(unwrapped);
  if (!def.shape) {
    return [];
  }

  const results: SensitiveFieldInfo[] = [];

  for (const [key, fieldSchema] of Object.entries(def.shape)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;

    // Check if this field has sensitive metadata
    const meta = getSensitiveMetadata(fieldSchema);
    if (meta?.sensitive) {
      results.push({
        path: fieldPath,
        vaultName: meta.vaultName,
        vaultKey: meta.vaultKey,
      });
    }

    // Recurse into nested objects
    const unwrappedField = unwrapSchema(fieldSchema);
    if (getSchemaType(unwrappedField) === "object") {
      results.push(...extractSensitiveFields(unwrappedField, fieldPath));
    }
  }

  return results;
}

/**
 * Determines whether a string is composed solely of CEL template expressions
 * (one or more `${{ ... }}`) with only whitespace around or between them.
 *
 * Such a value carries no cleartext secret — the secret is resolved at runtime
 * from a vault/env reference. A string mixing a literal with an expression
 * (e.g. `prefix-${{ vault.get(...) }}`) is NOT expression-only: the literal
 * portion would still be persisted in cleartext.
 */
function isExpressionOnly(value: string): boolean {
  if (!containsExpression(value)) {
    return false;
  }
  return value.replace(/\$\{\{.+?\}\}/g, "").trim() === "";
}

/**
 * Reports whether a value supplied for a sensitive field is a literal secret
 * that would be persisted in cleartext.
 *
 * - `undefined`/`null` and empty/whitespace-only strings carry no secret.
 * - A string that is composed solely of `${{ ... }}` expressions (e.g. a
 *   `vault.get(...)` reference) is resolved at runtime and is safe.
 * - Any other present value — a non-expression string, a string mixing literal
 *   text with an expression, or any number/boolean/array/object — is treated as
 *   a literal secret. Non-string values cannot be expression references, so they
 *   are always literals; this fails closed rather than risk leaking a typed
 *   secret.
 */
function isLiteralSecret(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      return false;
    }
    return !isExpressionOnly(value);
  }
  return true;
}

/**
 * Returns the dot-paths of global-argument fields marked `{ sensitive: true }`
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
 * Sensitive fields nested inside non-object schemas (e.g. records/unions) are
 * not detected — `extractSensitiveFields` only walks object shapes — so callers
 * should treat this as a best-effort guard, consistent with the redaction
 * primitives in this module.
 *
 * @param schema - The global-arguments Zod schema for the model type
 * @param args - The supplied global-argument values
 * @returns Dot-paths of sensitive fields holding a literal secret
 */
export function findLiteralSensitiveGlobalArgs(
  schema: z.ZodTypeAny | undefined,
  args: Record<string, unknown> | undefined,
): string[] {
  if (!schema || !args) {
    return [];
  }
  const fields = extractSensitiveFields(schema);
  if (fields.length === 0) {
    return [];
  }

  const offending: string[] = [];
  for (const field of fields) {
    if (isLiteralSecret(getNestedValue(args, field.path))) {
      offending.push(field.path);
    }
  }
  return offending;
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
    `${subject} marked sensitive and cannot be set to a literal value — ` +
    `it would be stored in cleartext in the definition YAML. Store the secret ` +
    `in a vault and reference it with a vault.get expression, e.g. ` +
    `--global-arg "apiKey=\${{ vault.get('my-vault', 'api-key') }}".`
  );
}

/** Machine-readable error code for a rejected literal sensitive global argument. */
export const LITERAL_SENSITIVE_GLOBAL_ARG_CODE = "literal_sensitive_global_arg";

/**
 * Value-free remediation guidance for a single sensitive global argument found
 * holding a cleartext literal. Carries only the field path and the vault
 * coordinates to migrate the secret to — never the secret value itself.
 */
export interface SensitiveArgRemediation {
  /** Dot-path of the offending sensitive global argument. */
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
 * @param leakedPaths - Dot-paths returned by `findLiteralSensitiveGlobalArgs`
 * @param schema - The global-arguments schema, read for vault metadata overrides
 * @returns One remediation per leaked path, in input order
 */
export function buildSensitiveArgRemediations(
  leakedPaths: string[],
  schema?: z.ZodTypeAny,
): SensitiveArgRemediation[] {
  const fieldsByPath = new Map<string, SensitiveFieldInfo>();
  if (schema) {
    for (const field of extractSensitiveFields(schema)) {
      fieldsByPath.set(field.path, field);
    }
  }
  return leakedPaths.map((path) => {
    const meta = fieldsByPath.get(path);
    const vaultName = meta?.vaultName ?? DEFAULT_REMEDIATION_VAULT;
    const vaultKey = meta?.vaultKey ?? path.split(".").at(-1) ?? path;
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
    const value = getNestedValue(data, field.path);
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      secrets.push(value);
    } else if (Array.isArray(value)) {
      for (const element of value) {
        if (typeof element === "string") {
          secrets.push(element);
        }
      }
    }
    // Object values are skipped — nested fields are found by extractSensitiveFields recursion
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
