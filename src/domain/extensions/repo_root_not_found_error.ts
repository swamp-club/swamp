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
 * Thrown by {@link findRepoRoot} when no ancestor directory of the start
 * path contains a `.swamp/` marker. Callers should treat this as
 * "not inside a swamp repository" and fall back to whatever cold-start
 * behaviour they support.
 */
export class RepoRootNotFoundError extends Error {
  constructor(start: string) {
    super(
      `No .swamp/ directory found in any ancestor of "${start}". ` +
        `findRepoRoot walks lexically (no realpath) and terminates at the ` +
        `filesystem root without a match.`,
    );
    this.name = "RepoRootNotFoundError";
  }
}
