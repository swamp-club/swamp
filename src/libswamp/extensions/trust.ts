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
 * only the first-party swamp collective is trusted by default; every other
 * collective, even one the user belongs to, must be trusted explicitly before
 * its extensions auto-resolve.
 */
export const DEFAULT_TRUSTED: string[] = ["swamp"];

export interface TrustModifyData {
  action: "added" | "removed";
  collective: string;
  trustedCollectives: string[];
}

export type TrustModifyEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: TrustModifyData }
  | { kind: "error"; error: SwampError };

/**
 * membership collectives from cached auth are trusted only when
 * trustMemberCollectives is true; otherwise only the explicit list resolves, so
 * a compromised member collective cannot silently auto-resolve into a repo.
 */
export function resolveTrustedCollectives(
  marker: RepoMarkerData | null,
  authCollectives?: string[],
): string[] {
  const explicit = marker?.trustedCollectives ?? DEFAULT_TRUSTED;

  if (
    marker?.trustMemberCollectives === true &&
    authCollectives &&
    authCollectives.length > 0
  ) {
    return [...new Set([...explicit, ...authCollectives])];
  }

  return explicit;
}
