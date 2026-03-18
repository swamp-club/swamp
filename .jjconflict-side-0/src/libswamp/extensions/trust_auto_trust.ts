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
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import type { LibSwampContext } from "../context.ts";
import { type SwampError, validationFailed } from "../errors.ts";

export interface TrustAutoTrustData {
  trustMemberCollectives: boolean;
}

export type TrustAutoTrustEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: TrustAutoTrustData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the trust auto-trust operation, injected for testability. */
export interface TrustAutoTrustDeps {
  readMarker: () => Promise<RepoMarkerData | null>;
  writeMarker: (data: RepoMarkerData) => Promise<void>;
}

/** Wires real infrastructure into TrustAutoTrustDeps. */
export function createTrustAutoTrustDeps(repoDir: string): TrustAutoTrustDeps {
  const markerRepo = new RepoMarkerRepository();
  const repoPath = RepoPath.create(repoDir);

  return {
    readMarker: () => markerRepo.read(repoPath),
    writeMarker: (data) => markerRepo.write(repoPath, data),
  };
}

/** Sets whether membership collectives are automatically trusted. */
export async function* trustAutoTrust(
  _ctx: LibSwampContext,
  deps: TrustAutoTrustDeps,
  enabled: boolean,
): AsyncIterable<TrustAutoTrustEvent> {
  yield { kind: "resolving" };

  const marker = await deps.readMarker();
  if (!marker) {
    yield {
      kind: "error",
      error: validationFailed(
        "Not a swamp repository. Run 'swamp init' first.",
      ),
    };
    return;
  }

  marker.trustMemberCollectives = enabled;
  await deps.writeMarker(marker);

  yield {
    kind: "completed",
    data: { trustMemberCollectives: enabled },
  };
}
