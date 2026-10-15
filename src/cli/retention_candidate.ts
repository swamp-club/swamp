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

/** The repository this command opened to write, if any (swamp-club#3473). */
let candidateRepoDir: string | undefined;

/**
 * Records that this command opened `repoDir` to write, so teardown may run
 * its retention pass. Read-only commands never call it.
 */
export function noteRetentionCandidate(repoDir: string): void {
  candidateRepoDir = repoDir;
}

/** Returns the noted repository and forgets it. */
export function takeRetentionCandidate(): string | undefined {
  const repoDir = candidateRepoDir;
  candidateRepoDir = undefined;
  return repoDir;
}
