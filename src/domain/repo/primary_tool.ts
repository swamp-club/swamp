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

/**
 * Resolves the primary AI tool for a repository.
 *
 * A swamp repo can be enrolled for multiple AI tools (`marker.tools`). Some
 * commands still operate on a single tool — audit recording, extension skills
 * directory resolution, the doctor checks. Those callers use this helper to
 * pick the conventional one.
 *
 * The rule: the first entry in `marker.tools`, or `"claude"` when the marker
 * is missing or has no enrolled tools. `"none"` is a CLI sentinel that means
 * "no tools enrolled" (represented as `tools: []`); it never appears inside
 * `tools` and is therefore never returned.
 */
export function resolvePrimaryTool(marker: RepoMarkerData | null): string {
  return marker?.tools?.[0] ?? "claude";
}
