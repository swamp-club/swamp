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

import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";

/**
 * Resolves the drivers directory path.
 * Priority: SWAMP_DRIVERS_DIR env var > .swamp.yaml config > default "extensions/drivers"
 */
export function resolveDriversDir(marker: RepoMarkerData | null): string {
  // Environment variable takes highest priority
  const envDriversDir = Deno.env.get("SWAMP_DRIVERS_DIR");
  if (envDriversDir) {
    return envDriversDir;
  }

  // Then .swamp.yaml config
  if (marker?.driversDir) {
    return marker.driversDir;
  }

  // Default
  return "extensions/drivers";
}
