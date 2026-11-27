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

import type { WhoamiCollectiveEntitlement } from "../../libswamp/auth/whoami.ts";
import { bold, dim } from "@std/fmt/colors";
import { maxOf } from "../../domain/array_extrema.ts";
import { escapeControlCharacters as esc } from "../../domain/control_characters.ts";

function runningTrial(
  trial: NonNullable<WhoamiCollectiveEntitlement["trial"]>,
): string {
  const days = trial.daysRemaining;
  const unit = days === 1 ? "day" : "days";
  // Render the server's day count as given — it is elapsed-based and so
  // timezone-independent. Recomputing from endsAt locally would reintroduce
  // exactly the zone bug the server avoided. The date is only a hint.
  const ends = trial.endsAt ? ` (ends ${esc(trial.endsAt.slice(0, 10))})` : "";
  return `trial: ${days} ${unit} left${ends}`;
}

/**
 * a collective on a plan shows the plan, a paid one its billing status; never
 * told it is on a free trial (--json keeps it); a free collective shows its
 * running trial, then covered, then an ended trial
 */
export function standing(entitlement: WhoamiCollectiveEntitlement): string {
  if (entitlement.plan !== undefined && entitlement.plan !== "free") {
    const name = esc(entitlement.planName ?? entitlement.plan);
    const status = entitlement.subscriptionStatus;
    return status ? `${name}  ${dim(esc(status))}` : name;
  }

  const trial = entitlement.trial;
  if (trial?.state === "active") return dim(runningTrial(trial));
  if (entitlement.privateExtensions === "allowed") return dim("covered");
  if (trial?.state === "expired") return dim("trial ended");
  return "";
}

export function collectiveLines(
  entitlements: WhoamiCollectiveEntitlement[],
): string[] {
  if (entitlements.length === 0) return [];
  const slugs = entitlements.map((c) => esc(c.slug));
  const slugWidth = maxOf(slugs.map((slug) => slug.length)) ?? 0;

  return entitlements.map((c, i) => {
    const said = standing(c);
    return said
      ? `  ${bold(slugs[i].padEnd(slugWidth))}  ${said}`
      : `  ${bold(slugs[i])}`;
  });
}
