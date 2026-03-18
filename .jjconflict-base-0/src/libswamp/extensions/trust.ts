// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/** Default trusted collectives when none are configured in .swamp.yaml. */
export const DEFAULT_TRUSTED: string[] = ["swamp", "si"];

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
 * Resolves the full list of trusted collectives by merging explicit
 * trustedCollectives from .swamp.yaml with the user's membership collectives
 * from cached auth credentials.
 */
export function resolveTrustedCollectives(
  marker: RepoMarkerData | null,
  authCollectives?: string[],
): string[] {
  const explicit = marker?.trustedCollectives ?? DEFAULT_TRUSTED;

  // If opt-out is set, only use explicit list
  if (marker?.trustMemberCollectives === false) {
    return explicit;
  }

  // Merge membership collectives (deduplicated)
  if (authCollectives && authCollectives.length > 0) {
    return [...new Set([...explicit, ...authCollectives])];
  }

  return explicit;
}
