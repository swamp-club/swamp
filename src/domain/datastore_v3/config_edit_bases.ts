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

import type { PutExpect } from "./op.ts";

/**
 * The version of each managed-config record a user's edit started from
 * (swamp-club#4097): the version the checkout held before another writer's
 * commit replaced it, which the user last saw by `get`, an editor or an
 * earlier command. A user's edit of the record expects this version, not
 * the one a catch-up wrote under it, so an edit of what another member
 * already changed is refused rather than saved over theirs.
 *
 * - The first version recorded for a record wins: a later catch-up never
 *   moves the base past a version the user did not see.
 * - It holds across commands until the user loads the definition again or
 *   the checkout commits the record, so retrying a refused edit unchanged
 *   is refused again.
 *
 * The v3 read model keeps them in its state.
 */
export interface ConfigEditBases {
  /** The version the user started from, when another writer replaced it. */
  baseOf(
    namespace: string,
    partition: string,
    key: string,
  ): PutExpect | undefined;
  /** Notes that the checkout committed `key`: it keeps no base from now on. */
  committed(namespace: string, partition: string, key: string): void;
}
