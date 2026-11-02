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
import { canonicalResourceKind } from "../terminology/behavior_aliases.ts";
import { wordedError, wordedText } from "../behavior_wording.ts";

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

/**
 * the kind behavior is read as model, its exact synonym, so stored grants and
 * comparisons see one spelling; any other unlisted kind is refused so a
 * misspelled deny fails loudly instead of matching nothing
 */
export function parseResourceSelector(value: string): ResourceSelector {
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid resource selector "${value}": expected "<kind>:<pattern>" (e.g. "workflow:@acme/*")`,
    );
  }
  const kind = canonicalResourceKind(value.slice(0, colonIndex));
  const pattern = value.slice(colonIndex + 1);
  if (pattern.length === 0) {
    throw new Error(
      `Invalid resource selector "${value}": pattern cannot be empty`,
    );
  }
  const parsed = ResourceKindSchema.safeParse(kind);
  if (!parsed.success) {
    const worded = wordedText((w) =>
      `Invalid resource kind "${kind}": expected "workflow", "${w.noun}", "data", "access", or "vault"`
    );
    throw wordedError(worded);
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
 * canonical spelling of a selector, or value unchanged when it does not parse,
 * so whoever parses it next reports the error
 */
export function canonicalResourceSelectorString(value: string): string {
  try {
    return resourceSelectorToString(parseResourceSelector(value));
  } catch {
    return value;
  }
}

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

/**
 * a pattern without a / or :: once a leading @ is set aside (prod-*, web.prod)
 * may be written for model names, which match only as written
 */
export function namesTypePath(pattern: string): boolean {
  const body = pattern.replace(/\*$/, "").replace(/^[@/]+/, "");
  return body.includes("/") || body.includes("::");
}

const TRAILING_TYPE_SEPARATOR = /(\/|\.|::|\s)$/;

/**
 * a trailing * stays, and so does a separator before it, so AWS::* gives aws/*
 * and never the wider aws*; null when the pattern names no type once normalized
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
 * only a pattern naming a type path ignores the @; any other (a*, prod-*, @*)
 * matches as written, so a prefix written for model names never grows to cover
 * extension types
 */
export function typePatternMatchesIgnoringAt(
  canonicalPattern: string,
  modelType: string,
): boolean {
  if (canonicalPattern === "*") return true;
  const wildcard = canonicalPattern.endsWith("*");
  const prefix = (wildcard ? canonicalPattern.slice(0, -1) : canonicalPattern)
    .replace(/^[@/]+/, "");
  if (!prefix.includes("/")) {
    return resourceSelectorMatches(
      { kind: "model", pattern: canonicalPattern },
      modelType,
    );
  }
  const type = normalizeModelTypeName(modelType);
  if (type === null) return false;
  return wildcard ? type.startsWith(prefix) : type === prefix;
}
