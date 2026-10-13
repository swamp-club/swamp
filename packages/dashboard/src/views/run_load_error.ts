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
 * Why a run that exists in the run list may not load. `swamp serve` reads
 * the runs its datastore holds; the local dashboard (`swamp start` /
 * `swamp dashboard`) reads only the repo it serves.
 */
export function runUnreadableHint(local: boolean): string {
  return local
    ? "Step-level detail is only available for runs recorded in this repo; a run from another checkout, or from a swamp serve with its own datastore, is not visible here."
    : "Step-level detail is only available for runs swamp serve can read; a run executed with the CLI elsewhere may not be visible here.";
}
