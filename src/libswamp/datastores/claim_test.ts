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

import { assertEquals, assertRejects } from "@std/assert";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  DATASTORE_CLAIMED_CODE,
  DatastoreClaimedError,
  DatastoreOwner,
} from "../../domain/datastore_v3/datastore_owner.ts";
import { UserError } from "../../domain/errors.ts";
import {
  datastoreClaim,
  type DatastoreClaimCommitLog,
  type DatastoreClaimEvent,
} from "./claim.ts";
import { datastoreRelease, type DatastoreReleaseEvent } from "./release.ts";

const NOW = new Date("2026-10-28T12:00:00.000Z");

/** A commit log in memory, recording what the claim did to it. */
function memoryLog(
  owner?: DatastoreOwner,
): DatastoreClaimCommitLog & { calls: string[]; current?: DatastoreOwner } {
  const log = {
    calls: [] as string[],
    current: owner,
    owner: () => log.current,
    catchUp: () => {
      log.calls.push("catchUp");
      return Promise.resolve();
    },
    highWaterCursor: () => 7,
    claim: (next: DatastoreOwner) => {
      log.calls.push(`claim ${next.address}`);
      log.current = next;
      return Promise.resolve();
    },
    release: () => {
      log.calls.push("release");
      log.current = undefined;
      return Promise.resolve();
    },
  };
  return log;
}

function owner(address: string): DatastoreOwner {
  return DatastoreOwner.create({
    address,
    claimedAt: "2026-10-01T00:00:00.000Z",
    claimedAtCursor: 3,
  });
}

Deno.test("datastoreClaim: catches up, then records the normalized address at the log's high-water mark", async () => {
  const log = memoryLog();
  const events = await collect<DatastoreClaimEvent>(
    datastoreClaim(
      createLibSwampContext(),
      { commitLog: log, now: () => NOW },
      {
        address: "HTTPS://Swamp.Example.com:443/",
      },
    ),
  );
  assertEquals(log.calls, ["catchUp", "claim https://swamp.example.com"]);
  assertEquals(events, [
    { kind: "catching_up" },
    {
      kind: "completed",
      data: {
        address: "https://swamp.example.com",
        claimedAt: NOW.toISOString(),
        claimedAtCursor: 7,
        alreadyClaimed: false,
      },
    },
  ]);
});

Deno.test("datastoreClaim: a claim for the owner's address changes nothing and reports the existing claim", async () => {
  const log = memoryLog(owner("https://swamp.example.com"));
  const events = await collect<DatastoreClaimEvent>(
    datastoreClaim(createLibSwampContext(), { commitLog: log }, {
      address: "https://swamp.example.com/",
    }),
  );
  assertEquals(log.calls, []);
  assertEquals(events, [{
    kind: "completed",
    data: {
      address: "https://swamp.example.com",
      claimedAt: "2026-10-01T00:00:00.000Z",
      claimedAtCursor: 3,
      alreadyClaimed: true,
    },
  }]);
});

Deno.test("datastoreClaim: a claim for another address is refused with datastore_claimed and changes nothing", async () => {
  const log = memoryLog(owner("https://swamp.example.com"));
  const error = await assertRejects(
    () =>
      collect(
        datastoreClaim(createLibSwampContext(), { commitLog: log }, {
          address: "https://other.example.com",
        }),
      ),
    DatastoreClaimedError,
    "swamp datastore release",
  );
  assertEquals(error.code, DATASTORE_CLAIMED_CODE);
  assertEquals(log.calls, []);
});

Deno.test("datastoreClaim: refuses a v2 datastore and an address that is not a URL before touching the log", async () => {
  await assertRejects(
    () =>
      collect(
        datastoreClaim(createLibSwampContext(), {}, {
          address: "https://swamp.example.com",
        }),
      ),
    UserError,
    "only to v3 datastores",
  );
  const log = memoryLog();
  await assertRejects(
    () =>
      collect(
        datastoreClaim(createLibSwampContext(), { commitLog: log }, {
          address: "swamp.example.com",
        }),
      ),
    UserError,
    "not a valid",
  );
  assertEquals(log.calls, []);
});

Deno.test("datastoreRelease: removes the claim and reports whose it was; an unclaimed datastore is left as it is", async () => {
  const log = memoryLog(owner("https://swamp.example.com"));
  assertEquals(
    await collect<DatastoreReleaseEvent>(
      datastoreRelease(createLibSwampContext(), { commitLog: log }),
    ),
    [{
      kind: "completed",
      data: {
        released: true,
        address: "https://swamp.example.com",
        claimedAt: "2026-10-01T00:00:00.000Z",
      },
    }],
  );
  assertEquals(log.calls, ["release"]);
  assertEquals(
    await collect<DatastoreReleaseEvent>(
      datastoreRelease(createLibSwampContext(), { commitLog: log }),
    ),
    [{ kind: "completed", data: { released: false } }],
  );
  assertEquals(log.calls, ["release"]);
  await assertRejects(
    () => collect(datastoreRelease(createLibSwampContext(), {})),
    UserError,
    "only to v3 datastores",
  );
});
