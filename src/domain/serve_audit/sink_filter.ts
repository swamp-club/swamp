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

import type { AuditCategory, AuditEvent, AuditOutcome } from "./audit_event.ts";
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
