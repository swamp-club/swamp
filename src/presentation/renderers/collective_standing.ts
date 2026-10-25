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

/** A running trial, as days left and the date it ends. */
function runningTrial(
  trial: NonNullable<WhoamiCollectiveEntitlement["trial"]>,
): string {
  const days = trial.daysRemaining;
  const unit = days === 1 ? "day" : "days";
  // Render the server's day count as given — it is elapsed-based and so
  // timezone-independent. Recomputing from endsAt locally would reintroduce
  // exactly the zone bug the server avoided. The date is only a hint.
  const ends = trial.endsAt ? ` (ends ${trial.endsAt.slice(0, 10)})` : "";
  return `trial: ${days} ${unit} left${ends}`;
}

/**
 * One collective's standing, named as the web names it, or empty when there
 * is nothing to say.
 *
 * A collective on a plan shows the plan, and a paid one its billing status.
 * It is never told it is on a free trial — the same rule the web surface
 * applies to its trial banner; `--json` keeps the trial for billing triage.
 *
 * "Free" is not a plan, so a free collective shows where it stands instead:
 * its running trial, then "covered" when the registry allows it private
 * extensions, then an ended trial. A free collective with no running trial is
 * allowed only through another collective its owner belongs to, so "allowed"
 * here means covered — and covered outranks the ended trial, which would read
 * as a lapse. A superseded or license-ended trial arrives as `trial: null`.
 */
export function standing(entitlement: WhoamiCollectiveEntitlement): string {
  if (entitlement.plan !== undefined && entitlement.plan !== "free") {
    const name = entitlement.planName ?? entitlement.plan;
    const status = entitlement.subscriptionStatus;
    return status ? `${name}  ${dim(status)}` : name;
  }

  const trial = entitlement.trial;
  if (trial?.state === "active") return dim(runningTrial(trial));
  if (entitlement.privateExtensions === "allowed") return dim("covered");
  if (trial?.state === "expired") return dim("trial ended");
  return "";
}

/** The per-collective block: slugs aligned, then each one's standing. */
export function collectiveLines(
  entitlements: WhoamiCollectiveEntitlement[],
): string[] {
  const slugWidth = Math.max(...entitlements.map((c) => c.slug.length));

  return entitlements.map((c) => {
    const said = standing(c);
    return said
      ? `  ${bold(c.slug.padEnd(slugWidth))}  ${said}`
      : `  ${bold(c.slug)}`;
  });
}
