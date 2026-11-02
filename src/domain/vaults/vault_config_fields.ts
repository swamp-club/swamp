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
 * fields come from the Zod configSchema once installed, or the registry's field
 * list before; both are author-written, so every name and description is
 * sanitized before it reaches a terminal
 */

import type { z } from "zod";

export interface VaultConfigField {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
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
 * duck-typed because an extension may bundle its own zod: v4 exposes def.type
 * and def.innerType, v3 exposes _def.typeName and _def.innerType
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
 * a schema that is not an object, or whose shape cannot be read, yields no
 * fields, which callers treat as unknown, never as nothing required
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

function hasValue(config: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(config, name) && config[name] !== undefined;
}

export function findMissingRequiredFields(
  fields: readonly VaultConfigField[],
  config: Record<string, unknown>,
): VaultConfigField[] {
  return fields.filter((f) => f.required && !hasValue(config, f.name));
}

const SECRET_LIKE_NAME_RE =
  /secret|token|password|passwd|api[_-]?key|private[_-]?key|credential/i;

/**
 * vault config holds connection details, not secrets (it is tracked in git),
 * but some extensions take a key or token; a secret-looking field is read
 * without echo and never repeated in a hint
 */
export function isSecretLikeFieldName(name: string): boolean {
  return SECRET_LIKE_NAME_RE.test(name);
}

/**
 * the hint is shown as a command to run, so it keeps everything the user
 * passed; a value under a secret-looking key becomes a placeholder so the hint
 * never repeats a credential
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

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface VaultConfigIssue {
  readonly code: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
  readonly expected?: string;
  readonly keys?: readonly string[];
}

export type RerunHint = (
  exampleConfig: string,
  missing: readonly VaultConfigField[],
) => string;

export interface ExplainVaultConfigIssuesInput {
  readonly vaultType: string;
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
