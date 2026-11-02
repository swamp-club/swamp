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

export interface DatastoreReleaseData {
  released: boolean;
  address?: string;
  claimedAt?: string;
}

export type DatastoreReleaseEvent =
  | { kind: "completed"; data: DatastoreReleaseData }
  | { kind: "error"; error: SwampError };

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
      // A row that cannot be read is removed all the same: release is the
      // way out of a claim, whatever state it is in.
      let owner;
      let unreadable = false;
      try {
        owner = log.owner();
      } catch {
        unreadable = true;
      }
      if (owner === undefined && !unreadable) {
        await log.confirm();
        yield { kind: "completed" as const, data: { released: false } };
        return;
      }
      await log.release();
      if (owner === undefined) {
        yield { kind: "completed" as const, data: { released: true } };
        return;
      }
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
