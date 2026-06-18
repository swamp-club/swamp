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

export const ResourceKindSchema = z.enum([
  "workflow",
  "model",
  "data",
  "access",
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
      `Invalid resource kind "${kind}": expected "workflow", "model", "data", or "access"`,
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
