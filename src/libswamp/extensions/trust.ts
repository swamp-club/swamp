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

import type { RepoMarkerData } from "../../infrastructure/persistence/repo_marker_repository.ts";
import type { SwampError } from "../errors.ts";

/**
 * Default trusted collectives when none are configured in .swamp.yaml. Only
 * the first-party `swamp` collective is trusted by default. Every other
 * collective — including ones the user is a member of — must be trusted
 * explicitly via `swamp extension trust add <collective>` before its
 * extensions will auto-resolve (swamp-club#465).
 */
export const DEFAULT_TRUSTED: string[] = ["swamp"];

/** Result data for trust add/rm operations. */
export interface TrustModifyData {
  action: "added" | "removed";
  collective: string;
  trustedCollectives: string[];
}

/** Shared event type for trust add and rm operations. */
export type TrustModifyEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: TrustModifyData }
  | { kind: "error"; error: SwampError };

/**
 * Resolves the full list of trusted collectives.
 *
 * The explicit `trustedCollectives` list from .swamp.yaml (defaulting to
 * {@link DEFAULT_TRUSTED}) is always trusted. Membership collectives from
 * cached auth are NOT trusted by default — a user must opt in by setting
 * `trustMemberCollectives: true`, which trusts every collective they belong
 * to (swamp-club#465). Without that opt-in, only the explicit list resolves,
 * so a compromised member collective cannot silently auto-resolve into a repo.
 */
export function resolveTrustedCollectives(
  marker: RepoMarkerData | null,
  authCollectives?: string[],
): string[] {
  const explicit = marker?.trustedCollectives ?? DEFAULT_TRUSTED;

  // Membership collectives are trusted only when explicitly opted in.
  if (
    marker?.trustMemberCollectives === true &&
    authCollectives &&
    authCollectives.length > 0
  ) {
    return [...new Set([...explicit, ...authCollectives])];
  }

  return explicit;
}
