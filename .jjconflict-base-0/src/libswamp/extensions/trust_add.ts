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
import { alreadyExists, validationFailed } from "../errors.ts";
import { DEFAULT_TRUSTED, type TrustModifyEvent } from "./trust.ts";

const COLLECTIVE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Dependencies for the trust add operation, injected for testability. */
export interface TrustAddDeps {
  readMarker: () => Promise<RepoMarkerData | null>;
  writeMarker: (data: RepoMarkerData) => Promise<void>;
}

/** Wires real infrastructure into TrustAddDeps. */
export function createTrustAddDeps(repoDir: string): TrustAddDeps {
  const markerRepo = new RepoMarkerRepository();
  const repoPath = RepoPath.create(repoDir);

  return {
    readMarker: () => markerRepo.read(repoPath),
    writeMarker: (data) => markerRepo.write(repoPath, data),
  };
}

/** Adds a collective to the trusted list in .swamp.yaml. */
export async function* trustAdd(
  _ctx: LibSwampContext,
  deps: TrustAddDeps,
  collective: string,
): AsyncIterable<TrustModifyEvent> {
  yield { kind: "resolving" };

  if (!COLLECTIVE_NAME_RE.test(collective)) {
    yield {
      kind: "error",
      error: validationFailed(
        `Invalid collective name '${collective}'. Must match [a-z0-9][a-z0-9_-]*.`,
      ),
    };
    return;
  }

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

  const current = marker.trustedCollectives ?? DEFAULT_TRUSTED;

  if (current.includes(collective)) {
    yield {
      kind: "error",
      error: alreadyExists("Trusted collective", collective),
    };
    return;
  }

  const updated = [...current, collective];
  marker.trustedCollectives = updated;
  await deps.writeMarker(marker);

  yield {
    kind: "completed",
    data: {
      action: "added",
      collective,
      trustedCollectives: updated,
    },
  };
}
