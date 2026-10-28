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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { type DatastoreClaimDeps, notV3Error } from "./claim.ts";

/** The result of `swamp datastore release`. */
export interface DatastoreReleaseData {
  /** False when the datastore was not claimed: nothing was changed. */
  released: boolean;
  /** The address of the owner the release removed. */
  address?: string;
  /** When the removed claim was written. */
  claimedAt?: string;
}

export type DatastoreReleaseEvent =
  | { kind: "completed"; data: DatastoreReleaseData }
  | { kind: "error"; error: SwampError };

/**
 * Removes the claim on a v3 datastore (swamp-club#4063), so direct writers
 * write it again. Releasing an unclaimed datastore changes nothing.
 *
 * @throws UserError on a v2 datastore
 */
export async function* datastoreRelease(
  _ctx: LibSwampContext,
  deps: Pick<DatastoreClaimDeps, "commitLog">,
): AsyncIterable<DatastoreReleaseEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.release",
    {},
    (async function* () {
      const log = deps.commitLog;
      if (log === undefined) throw notV3Error("release");
      const owner = log.owner();
      if (owner === undefined) {
        yield { kind: "completed" as const, data: { released: false } };
        return;
      }
      await log.release();
      yield {
        kind: "completed" as const,
        data: {
          released: true,
          address: owner.address,
          claimedAt: owner.claimedAt,
        },
      };
    })(),
  );
}
