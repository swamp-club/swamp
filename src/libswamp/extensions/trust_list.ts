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
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { DEFAULT_TRUSTED, resolveTrustedCollectives } from "./trust.ts";

export interface TrustListData {
  explicit: string[];
  membership: string[];
  resolved: string[];
  trustMemberCollectives: boolean;
}

export type TrustListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: TrustListData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the trust list operation, injected for testability. */
export interface TrustListDeps {
  readMarker: () => Promise<RepoMarkerData | null>;
  loadAuthCollectives: () => Promise<string[] | undefined>;
}

/** Wires real infrastructure into TrustListDeps. */
export function createTrustListDeps(repoDir: string): TrustListDeps {
  const markerRepo = new RepoMarkerRepository();
  const authRepo = new AuthRepository();
  const repoPath = RepoPath.create(repoDir);

  return {
    readMarker: () => markerRepo.read(repoPath),
    loadAuthCollectives: async () => {
      try {
        const creds = await authRepo.load();
        return creds?.collectives;
      } catch {
        return undefined;
      }
    },
  };
}

/** Lists trusted collectives, merging explicit config with membership. */
export async function* trustList(
  _ctx: LibSwampContext,
  deps: TrustListDeps,
): AsyncIterable<TrustListEvent> {
  yield { kind: "resolving" };

  const marker = await deps.readMarker();
  const authCollectives = await deps.loadAuthCollectives();

  const explicit = marker?.trustedCollectives ?? DEFAULT_TRUSTED;
  // Membership collectives are trusted only when explicitly opted in
  // (swamp-club#465); the default is no membership trust.
  const trustMemberCollectives = marker?.trustMemberCollectives === true;
  const resolved = resolveTrustedCollectives(marker, authCollectives);

  const membership = trustMemberCollectives && authCollectives
    ? authCollectives.filter((c) => !explicit.includes(c))
    : [];

  yield {
    kind: "completed",
    data: {
      explicit,
      membership,
      resolved,
      trustMemberCollectives,
    },
  };
}
