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
import {
  DatastoreClaimedError,
  DatastoreOwner,
} from "../../domain/datastore_v3/datastore_owner.ts";
import { UserError } from "../../domain/errors.ts";

/** The result of `swamp datastore claim`. */
export interface DatastoreClaimData {
  /** The owner's normalized address. */
  address: string;
  /** When the claim was written. */
  claimedAt: string;
  /** The log's high-water mark when the claim was written. */
  claimedAtCursor: number;
  /** True when the datastore was already claimed for this address. */
  alreadyClaimed: boolean;
}

export type DatastoreClaimEvent =
  | { kind: "catching_up" }
  | { kind: "completed"; data: DatastoreClaimData }
  | { kind: "error"; error: SwampError };

/**
 * A v3 datastore's commit log, held under this process's writer lease, as
 * the claim and the release see it.
 */
export interface DatastoreClaimCommitLog {
  /** The datastore's owner, or undefined while none claimed it. */
  owner(): DatastoreOwner | undefined;
  /** Applies every commit not yet applied, on every partition. */
  catchUp(signal: AbortSignal): Promise<void>;
  /** The log's high-water mark. */
  highWaterCursor(): number;
  /** Writes `owner` as the datastore's owner, under the writer fence. */
  claim(owner: DatastoreOwner): Promise<void>;
  /** Removes the claim, under the writer fence. */
  release(): Promise<void>;
  /**
   * Confirms the claim as it stands is replicated, for a claim or release
   * that changed nothing: an earlier attempt may have written it without
   * confirming it.
   */
  confirm(): Promise<void>;
}

/** Dependencies for {@link datastoreClaim} and `datastoreRelease`. */
export interface DatastoreClaimDeps {
  /** The commit log; undefined on a v2 datastore, which has none. */
  commitLog?: DatastoreClaimCommitLog;
  /** The clock; `new Date()` unless given. */
  now?: () => Date;
}

/** Input for {@link datastoreClaim}. */
export interface DatastoreClaimInput {
  /** The address clients put in serverAddress. */
  address: string;
}

/** The refusal for a claim or release of a datastore that is not v3. */
export function notV3Error(command: "claim" | "release"): UserError {
  return new UserError(
    `'swamp datastore ${command}' applies only to v3 datastores: a v2 ` +
      "datastore has no commit log to claim. Nothing was changed.",
  );
}

/**
 * Makes serve at `input.address` the owner of a v3 datastore
 * (swamp-club#4063): catches the commit log up, then records the owner and
 * the log position it took over at. From then on a direct writer is
 * refused and writes go through serve. Claiming again for the same address
 * changes nothing; another address is refused until the claim is released.
 *
 * @throws DatastoreClaimedError when another address owns the datastore
 * @throws UserError on a v2 datastore or an address that is not a URL
 */
export async function* datastoreClaim(
  ctx: LibSwampContext,
  deps: DatastoreClaimDeps,
  input: DatastoreClaimInput,
): AsyncIterable<DatastoreClaimEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.claim",
    {},
    (async function* () {
      const log = deps.commitLog;
      if (log === undefined) throw notV3Error("claim");
      const now = (deps.now ?? (() => new Date()))();
      // Validated before anything is read or written.
      const candidate = DatastoreOwner.create({
        address: input.address,
        claimedAt: now.toISOString(),
        claimedAtCursor: 0,
      });
      const existing = log.owner();
      if (existing !== undefined) {
        if (!existing.isAddress(candidate.address)) {
          throw new DatastoreClaimedError(
            existing,
            undefined,
            "Release the claim with 'swamp datastore release' before " +
              "claiming it for another address.",
          );
        }
        await log.confirm();
        yield {
          kind: "completed" as const,
          data: { ...ownerData(existing), alreadyClaimed: true },
        };
        return;
      }
      yield { kind: "catching_up" as const };
      await log.catchUp(ctx.signal);
      const owner = DatastoreOwner.create({
        address: candidate.address,
        claimedAt: candidate.claimedAt,
        claimedAtCursor: log.highWaterCursor(),
      });
      await log.claim(owner);
      yield {
        kind: "completed" as const,
        data: { ...ownerData(owner), alreadyClaimed: false },
      };
    })(),
  );
}

function ownerData(
  owner: DatastoreOwner,
): Omit<DatastoreClaimData, "alreadyClaimed"> {
  return {
    address: owner.address,
    claimedAt: owner.claimedAt,
    claimedAtCursor: owner.claimedAtCursor,
  };
}
