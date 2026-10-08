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
import { normalizeModelTypeName } from "../models/control_plane_types.ts";
import { ModelType } from "../models/model_type.ts";

export const ResourceKindSchema = z.enum([
  "workflow",
  "model",
  "data",
  "access",
  "vault",
]);

export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const ResourceSelectorSchema = z.object({
  kind: ResourceKindSchema,
  pattern: z.string().min(1),
});

export type ResourceSelector = z.infer<typeof ResourceSelectorSchema>;

export function parseResourceSelector(value: string): ResourceSelector {
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid resource selector "${value}": expected "<kind>:<pattern>" (e.g. "workflow:@acme/*")`,
    );
  }
  const kind = value.slice(0, colonIndex);
  const pattern = value.slice(colonIndex + 1);
  if (pattern.length === 0) {
    throw new Error(
      `Invalid resource selector "${value}": pattern cannot be empty`,
    );
  }
  const parsed = ResourceKindSchema.safeParse(kind);
  if (!parsed.success) {
    throw new Error(
      `Invalid resource kind "${kind}": expected "workflow", "model", "data", "access", or "vault"`,
    );
  }
  const starIndex = pattern.indexOf("*");
  if (starIndex !== -1 && starIndex !== pattern.length - 1) {
    throw new Error(
      `Invalid resource selector "${value}": wildcard * is only supported at the end of a pattern`,
    );
  }
  return { kind: parsed.data, pattern };
}

export function resourceSelectorToString(selector: ResourceSelector): string {
  return `${selector.kind}:${selector.pattern}`;
}

/**
 * Tests whether a resource name matches this selector's pattern.
 * Patterns support a trailing `*` as a suffix wildcard:
 * - `@acme/*` matches `@acme/deploy`, `@acme/build`
 * - `@acme/deploy` matches only `@acme/deploy` (exact)
 * - `*` matches everything
 */
export function resourceSelectorMatches(
  selector: ResourceSelector,
  resourceName: string,
): boolean {
  const { pattern } = selector;
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return resourceName.startsWith(prefix);
  }
  return pattern === resourceName;
}

/** A trailing separator that ModelType normalization would trim. */
const TRAILING_TYPE_SEPARATOR = /(\/|\.|::|\s)$/;

/**
 * The pattern written in the normalized model type spelling: lowercase, with
 * `::`, `.` and whitespace folded to `/` and a leading `@` kept, as
 * `ModelType` stores a type. A trailing `*` stays, and so does a separator
 * before it, so `AWS::*` gives `aws/*` and never the wider `aws*`. Null when
 * the pattern names no type once normalized (`::*`).
 */
export function canonicalTypePattern(pattern: string): string | null {
  if (pattern === "*") return "*";
  const wildcard = pattern.endsWith("*");
  const prefix = wildcard ? pattern.slice(0, -1) : pattern;
  let normalized: string;
  try {
    normalized = ModelType.create(prefix).normalized;
  } catch {
    return null;
  }
  if (!wildcard) return normalized;
  return TRAILING_TYPE_SEPARATOR.test(prefix)
    ? `${normalized}/*`
    : `${normalized}*`;
}

/**
 * Whether a model type matches a canonical type pattern when every leading
 * `@` and `/` is ignored on both sides, as `normalizeModelTypeName` compares
 * types (swamp-club#3129): `acme/*` and `@acme/*` both cover `@acme/deploy`
 * and `acme/deploy`. A pattern that is empty once stripped (`@*`) is matched
 * as written, so it never grows to cover every type.
 */
export function typePatternMatchesIgnoringAt(
  canonicalPattern: string,
  modelType: string,
): boolean {
  if (canonicalPattern === "*") return true;
  const type = normalizeModelTypeName(modelType);
  if (type === null) return false;
  const wildcard = canonicalPattern.endsWith("*");
  const prefix = (wildcard ? canonicalPattern.slice(0, -1) : canonicalPattern)
    .replace(/^[@/]+/, "");
  if (prefix.length === 0) {
    return resourceSelectorMatches(
      { kind: "model", pattern: canonicalPattern },
      modelType,
    );
  }
  return wildcard ? type.startsWith(prefix) : type === prefix;
}
