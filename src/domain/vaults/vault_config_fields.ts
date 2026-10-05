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

/**
 * A vault type's config fields, and how a config that does not satisfy
 * them is explained to the user.
 *
 * The fields come from one of two places: the type's Zod `configSchema`
 * once its extension is installed, or the field list the registry
 * publishes for the extension before it is installed. Both are written by
 * the extension author, so every name and description is sanitized before
 * it reaches a terminal (swamp-club#3003).
 */

import type { z } from "zod";

/** One field of a vault type's provider config. */
export interface VaultConfigField {
  readonly name: string;
  /** The Zod base type, e.g. "string" or "number"; "unknown" when unclear. */
  readonly type: string;
  readonly description?: string;
  /** Whether the schema rejects a config that leaves the field out. */
  readonly required: boolean;
}

export const MAX_CONFIG_FIELD_NAME_LENGTH = 64;
export const MAX_CONFIG_FIELD_DESCRIPTION_LENGTH = 160;
const MAX_CONFIG_FIELD_TYPE_LENGTH = 32;
const MAX_ISSUE_MESSAGE_LENGTH = 200;

// deno-lint-ignore no-control-regex
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// deno-lint-ignore no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Makes author-controlled text safe to print: strips ANSI escape sequences
 * and control characters, collapses whitespace, and caps the length.
 */
export function sanitizeFieldText(text: string, maxLength: number): string {
  const cleaned = text
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Builds a sanitized field from raw (author-supplied) parts. */
export function vaultConfigField(raw: {
  name: string;
  type: string;
  description?: string;
  required: boolean;
}): VaultConfigField {
  const description = raw.description
    ? sanitizeFieldText(raw.description, MAX_CONFIG_FIELD_DESCRIPTION_LENGTH)
    : "";
  return {
    name: sanitizeFieldText(raw.name, MAX_CONFIG_FIELD_NAME_LENGTH),
    type: sanitizeFieldText(raw.type, MAX_CONFIG_FIELD_TYPE_LENGTH) ||
      "unknown",
    ...(description ? { description } : {}),
    required: raw.required,
  };
}

/**
 * Zod wrapper types that sit between a field and its base type. A field
 * wrapped in any of these accepts undefined (or substitutes a value), so
 * the base type is what the user should supply.
 */
const WRAPPER_TYPES = new Set([
  "optional",
  "nullable",
  "default",
  "catch",
  "readonly",
  "prefault",
  "nonoptional",
]);

/**
 * The parts of a Zod schema read here, duck-typed because an extension may
 * bundle its own zod (see `isZodSchemaLike` in `zod_compat.ts`). Zod v4
 * exposes `def.type` and `def.innerType`; v3 exposes `_def.typeName` and
 * `_def.innerType`.
 */
interface SchemaLike {
  description?: unknown;
  safeParse?: (value: unknown) => { success: boolean };
  def?: { type?: unknown; innerType?: unknown };
  _def?: { typeName?: unknown; innerType?: unknown };
  shape?: unknown;
}

function schemaBaseType(schema: SchemaLike): string {
  let current: SchemaLike | undefined = schema;
  for (let depth = 0; current && depth < 8; depth++) {
    const v4Type = current.def?.type;
    const v3Type = current._def?.typeName;
    const type = typeof v4Type === "string"
      ? v4Type
      : typeof v3Type === "string"
      ? v3Type.replace(/^Zod/, "").toLowerCase()
      : undefined;
    if (!type) return "unknown";
    if (!WRAPPER_TYPES.has(type)) return type;
    current = (current.def?.innerType ?? current._def?.innerType) as
      | SchemaLike
      | undefined;
  }
  return "unknown";
}

/**
 * Reads the fields of an object schema. A schema that is not an object
 * (or whose shape cannot be read) yields no fields, which callers treat
 * as "unknown", never as "nothing required".
 */
export function describeVaultConfigFields(
  schema: z.ZodTypeAny,
): VaultConfigField[] {
  const shape = (schema as unknown as SchemaLike).shape;
  if (!shape || typeof shape !== "object") return [];
  return Object.entries(shape as Record<string, unknown>).map(
    ([name, field]) => {
      const f = field as SchemaLike;
      let required = true;
      try {
        required = !f.safeParse?.(undefined).success;
      } catch {
        // A schema that throws on undefined is treated as required.
      }
      return vaultConfigField({
        name,
        type: schemaBaseType(f),
        description: typeof f.description === "string"
          ? f.description
          : undefined,
        required,
      });
    },
  );
}

/** Whether `config` supplies a value for the field (an own key, not undefined). */
function hasValue(config: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(config, name) && config[name] !== undefined;
}

/** The required fields that `config` leaves out. */
export function findMissingRequiredFields(
  fields: readonly VaultConfigField[],
  config: Record<string, unknown>,
): VaultConfigField[] {
  return fields.filter((f) => f.required && !hasValue(config, f.name));
}

const SECRET_LIKE_NAME_RE =
  /secret|token|password|passwd|api[_-]?key|private[_-]?key|credential/i;

/**
 * Whether a config field, judged by its name, is likely to hold a
 * credential. Vault config is meant to hold connection details, not
 * secrets (the vaults directory is tracked in git), but a few registry
 * extensions do take an API key or token there. A field that looks like
 * one is read without echo and never repeated in a hint.
 */
export function isSecretLikeFieldName(name: string): boolean {
  return SECRET_LIKE_NAME_RE.test(name);
}

/**
 * A `--config` value the user can copy: what they already supplied plus a
 * placeholder per missing field, e.g. `{"region":"eu","op_vault":"<op_vault>"}`.
 * The hint is presented as a command to run, so it must not drop anything
 * the user passed; a value under a secret-looking key is replaced by a
 * placeholder so the hint never repeats a credential.
 */
export function exampleConfigFor(
  missing: readonly VaultConfigField[],
  supplied: Record<string, unknown> = {},
): string {
  const kept = Object.entries(supplied).map(([key, value]) =>
    [key, isSecretLikeFieldName(key) ? `<${key}>` : value] as const
  );
  return JSON.stringify({
    ...Object.fromEntries(kept),
    ...Object.fromEntries(missing.map((f) => [f.name, `<${f.name}>`])),
  });
}

/**
 * Quotes a value for a POSIX shell so a hint can be pasted as a command:
 * wraps it in single quotes and escapes any single quote inside as '\\''.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The parts of a Zod issue this module reads. */
export interface VaultConfigIssue {
  readonly code: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
  readonly expected?: string;
  readonly keys?: readonly string[];
}

/**
 * Produces the sentence that tells the user how to try again, given an
 * example config for the missing fields. Returns "" for no hint.
 */
export type RerunHint = (
  exampleConfig: string,
  missing: readonly VaultConfigField[],
) => string;

export interface ExplainVaultConfigIssuesInput {
  readonly vaultType: string;
  /** Named when the config is one already stored for a vault. */
  readonly vaultName?: string;
  readonly config: Record<string, unknown>;
  readonly issues: readonly VaultConfigIssue[];
  readonly fields: readonly VaultConfigField[];
  readonly rerunHint?: RerunHint;
}

function describeField(field: VaultConfigField): string {
  return field.description
    ? `'${field.name}' (${field.description})`
    : `'${field.name}'`;
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function formatProblems(input: {
  vaultType: string;
  vaultName?: string;
  problems: readonly string[];
  hint?: string;
}): string {
  const prefix = `Invalid config for vault type '${input.vaultType}'` +
    (input.vaultName ? ` (vault '${input.vaultName}')` : "") + ":";
  const hint = input.hint?.trim() ?? "";
  if (input.problems.length <= 1) {
    const problem = input.problems[0] ??
      "the config does not match the type's schema";
    return `${prefix} ${problem}.${hint ? ` ${hint}` : ""}`;
  }
  const lines = input.problems.map((p) => `  - ${p}`);
  return [prefix, ...lines, ...(hint ? [hint] : [])].join("\n");
}

/**
 * Turns a schema failure into a short message: each missing required
 * field by name (with its description), each wrong-typed field with the
 * expected type, each unknown key with the accepted fields, then the
 * re-run hint. Keeps the "Invalid config for vault type" prefix every
 * caller has always produced.
 */
export function explainVaultConfigIssues(
  input: ExplainVaultConfigIssuesInput,
): string {
  const byName = new Map(input.fields.map((f) => [f.name, f]));
  const accepted = input.fields.map((f) => f.name).join(", ");
  const missing: VaultConfigField[] = [];
  const problems: string[] = [];

  for (const issue of input.issues) {
    const path = issue.path.map(String);
    const key = path[0];
    const topLevel = path.length === 1;
    if (
      issue.code === "invalid_type" && topLevel &&
      !hasValue(input.config, key)
    ) {
      if (missing.some((f) => f.name === key)) continue;
      const field = byName.get(key) ?? vaultConfigField({
        name: key,
        type: issue.expected ?? "unknown",
        required: true,
      });
      missing.push(field);
      problems.push(`missing required field ${describeField(field)}`);
    } else if (issue.code === "invalid_type" && topLevel) {
      const expected = issue.expected
        ? sanitizeFieldText(issue.expected, MAX_CONFIG_FIELD_TYPE_LENGTH)
        : "another type";
      problems.push(
        `field '${
          sanitizeFieldText(key, MAX_CONFIG_FIELD_NAME_LENGTH)
        }' expects ${expected}, got ${valueKind(input.config[key])}`,
      );
    } else if (issue.code === "unrecognized_keys") {
      const keys = (issue.keys ?? []).map((k) =>
        `'${sanitizeFieldText(k, MAX_CONFIG_FIELD_NAME_LENGTH)}'`
      );
      const plural = keys.length === 1 ? "" : "s";
      problems.push(
        `unknown field${plural} ${keys.join(", ")}` +
          (accepted ? `; accepted fields: ${accepted}` : ""),
      );
    } else {
      const where = path.length > 0
        ? `field '${
          sanitizeFieldText(path.join("."), MAX_CONFIG_FIELD_NAME_LENGTH)
        }': `
        : "";
      problems.push(
        `${where}${sanitizeFieldText(issue.message, MAX_ISSUE_MESSAGE_LENGTH)}`,
      );
    }
  }

  return formatProblems({
    vaultType: input.vaultType,
    vaultName: input.vaultName,
    problems,
    hint: input.rerunHint?.(
      exampleConfigFor(missing, input.config),
      missing,
    ),
  });
}
