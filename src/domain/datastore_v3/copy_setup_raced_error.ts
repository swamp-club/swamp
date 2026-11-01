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
 * A checkout-local v3 copy that two commands set up at once
 * (swamp-club#4253). Swamp creates a serve-mode checkout's copy by itself on
 * first use, so a command that loses the race to write the copy's format
 * marker uses the marker the winner wrote. Only a marker it cannot read as
 * a v3 one yet (a filesystem without hard links shows it part-written for a
 * moment) refuses, as a temporary failure: a retry finds it whole.
 *
 * @module
 */

import { UserError } from "../errors.ts";

/** Error code for a copy another command is still setting up. */
export const V3_COPY_SETUP_RACED_CODE = "datastore_v3_copy_setup_raced";

/** Another command in this checkout is setting up the same local copy. */
export class V3CopySetupRacedError extends UserError {
  constructor(path: string) {
    super(
      `Another command in this checkout is setting up its local copy of the datastore at ${path}. Nothing was changed; run the command again.`,
      V3_COPY_SETUP_RACED_CODE,
    );
    this.name = "V3CopySetupRacedError";
  }
}
