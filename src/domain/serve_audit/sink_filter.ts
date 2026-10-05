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

import {
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  type AuditCategory,
  type AuditEvent,
  type AuditOutcome,
} from "./audit_event.ts";
import { type AuditEventTier, classifyTier } from "./audit_policy.ts";

export interface SinkFilterConfig {
  readonly categories?: readonly AuditCategory[];
  readonly tier?: AuditEventTier | "all";
  readonly outcomes?: readonly AuditOutcome[];
}

export function matchesSinkFilter(
  event: AuditEvent,
  filter: SinkFilterConfig,
): boolean {
  if (
    filter.categories &&
    filter.categories.length > 0 &&
    !filter.categories.includes(event.category)
  ) {
    return false;
  }

  if (filter.tier && filter.tier !== "all") {
    const eventTier = classifyTier(event.action, event.category);
    if (eventTier !== filter.tier) return false;
  }

  if (
    filter.outcomes &&
    filter.outcomes.length > 0 &&
    !filter.outcomes.includes(event.outcome)
  ) {
    return false;
  }

  return true;
}

export function parseSinkFilter(
  raw: Record<string, unknown>,
): SinkFilterConfig {
  const filter = raw.filter as Record<string, unknown> | undefined;
  if (!filter) return { tier: "management" };

  return {
    categories: filter.categories as AuditCategory[] | undefined,
    tier: filter.tier as AuditEventTier | "all" | undefined,
    outcomes: filter.outcomes as AuditOutcome[] | undefined,
  };
}

const FILTER_KEYS: readonly string[] = ["categories", "tier", "outcomes"];
const FILTER_TIERS: readonly string[] = ["management", "data", "all"];

function addListProblems(
  problems: string[],
  value: unknown,
  field: string,
  allowed: readonly string[],
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    problems.push(`${field} must be a list, got ${JSON.stringify(value)}`);
    return;
  }
  for (const entry of value) {
    if (typeof entry === "string" && allowed.includes(entry)) continue;
    problems.push(
      `${field} has unknown value ${JSON.stringify(entry)} (expected one of ${
        allowed.join(", ")
      })`,
    );
  }
}

/**
 * Describes what is wrong with a sink entry's `filter` block, one message per
 * problem; empty when it is valid or absent. parseSinkFilter still reads the
 * block as written, so a bad value filters exactly as it always has.
 */
export function validateSinkFilter(raw: Record<string, unknown>): string[] {
  const filter = raw.filter;
  if (filter === undefined || filter === null) return [];
  if (typeof filter !== "object" || Array.isArray(filter)) {
    return [`filter must be a mapping, got ${JSON.stringify(filter)}`];
  }
  const block = filter as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(block)) {
    if (!FILTER_KEYS.includes(key)) {
      problems.push(
        `filter has unknown key ${key} (expected ${FILTER_KEYS.join(", ")})`,
      );
    }
  }
  addListProblems(
    problems,
    block.categories,
    "filter.categories",
    AUDIT_CATEGORIES,
  );
  if (
    block.tier !== undefined && block.tier !== null &&
    (typeof block.tier !== "string" || !FILTER_TIERS.includes(block.tier))
  ) {
    problems.push(
      `filter.tier has unknown value ${
        JSON.stringify(block.tier)
      } (expected one of ${FILTER_TIERS.join(", ")})`,
    );
  }
  addListProblems(problems, block.outcomes, "filter.outcomes", AUDIT_OUTCOMES);
  return problems;
}
