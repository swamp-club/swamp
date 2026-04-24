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

import { RepoPath } from "../../domain/repo/repo_path.ts";
import type {
  RepoMarkerData,
  RepoMarkerRepository,
} from "./repo_marker_repository.ts";

/**
 * Returns a promise-memoized loader for `.swamp.yaml`. Concurrent callers
 * share a single in-flight read; the file is read at most once per loader
 * lifetime. Scope the loader per-request (one per CLI invocation, one per
 * serve request, one per `WorkflowExecutionService` instance) so that
 * edits to `.swamp.yaml` between requests are picked up.
 *
 * Rejected reads stay cached — marker parse failures are typically
 * permanent (malformed YAML), so re-reading would not recover.
 */
export function createRepoMarkerLoader(
  markerRepo: RepoMarkerRepository,
  repoDir: string,
): () => Promise<RepoMarkerData | null> {
  const markerPath = RepoPath.create(repoDir);
  let markerPromise: Promise<RepoMarkerData | null> | undefined;
  return () => {
    markerPromise ??= markerRepo.read(markerPath);
    return markerPromise;
  };
}
