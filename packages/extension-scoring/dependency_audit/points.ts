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
 * only an outage clears on a re-run; canonical is a v2 archive whose source
 * breaks the canonical shipped form, origin is code from outside npm and JSR
 * that no registry audit covers
 */
export type NotAuditedFix =
  | "outage"
  | "name"
  | "specifier"
  | "canonical"
  | "origin"
  | "unexpected"
  | "other";

export const NOT_AUDITED_FIX: Readonly<Record<NotAuditedFix, string>> = {
  outage: "Re-run when OSV, npm and JSR are reachable.",
  name: "Correct the package name in the import.",
  specifier: "Change the specifier to a version the registry publishes.",
  canonical:
    "Push again with `swamp extension push`, which writes every npm: and jsr: import exact and lists it in dependency-audit.json.",
  origin: "Replace it with an npm: or jsr: package.",
  unexpected: "Re-run; if it fails again, report it.",
  other: "Resolve the reason above, then re-run.",
};

export const DEPENDENCY_TRUST_MAX_POINTS = 2;

/**
 * none while any dependency is blocked or not audited (unaudited is unknown,
 * not partly trusted); one when any specifier is loose, however many; otherwise
 * both
 */
export function dependencyTrustEarnedPoints(counts: {
  blockerCount: number;
  notAuditedCount: number;
  looseCount: number;
}): number {
  if (counts.blockerCount > 0 || counts.notAuditedCount > 0) return 0;
  return counts.looseCount > 0
    ? DEPENDENCY_TRUST_MAX_POINTS - 1
    : DEPENDENCY_TRUST_MAX_POINTS;
}
