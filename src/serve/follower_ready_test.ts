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

import { assertEquals } from "@std/assert";
import {
  awaitFirstFollowerCatchUp,
  FOLLOWER_READY_RETRY_MS,
  FOLLOWER_READY_WAIT_MS,
} from "./follower_ready.ts";

/** A clock that moves only when the wait pauses. */
function clock() {
  let at = 0;
  const pauses: number[] = [];
  return {
    pauses,
    now: () => at,
    pause: (ms: number) => {
      pauses.push(ms);
      at += ms;
      return Promise.resolve();
    },
  };
}

Deno.test("awaitFirstFollowerCatchUp: returns once the copy holds the leader's head, retrying while the feed is not live", async () => {
  const c = clock();
  const answers = [false, false, true];
  let asked = 0;
  const outcome = await awaitFirstFollowerCatchUp({
    caughtUp: () => Promise.resolve(answers[asked++]),
    ended: () => false,
    now: c.now,
    pause: c.pause,
  });
  assertEquals(outcome, "caught-up");
  assertEquals(asked, 3);
  assertEquals(c.pauses, [FOLLOWER_READY_RETRY_MS, FOLLOWER_READY_RETRY_MS]);
});

Deno.test("awaitFirstFollowerCatchUp: gives up at the bound, so a slow restore cannot hold the node out of rotation", async () => {
  const c = clock();
  let asked = 0;
  const outcome = await awaitFirstFollowerCatchUp({
    caughtUp: () => {
      asked++;
      return Promise.resolve(false);
    },
    ended: () => false,
    now: c.now,
    pause: c.pause,
  });
  assertEquals(outcome, "timed-out");
  assertEquals(asked, FOLLOWER_READY_WAIT_MS / FOLLOWER_READY_RETRY_MS + 1);
});

Deno.test("awaitFirstFollowerCatchUp: ends as soon as the node leads or shuts down", async () => {
  const c = clock();
  let ended = false;
  let asked = 0;
  const outcome = await awaitFirstFollowerCatchUp({
    caughtUp: () => {
      asked++;
      if (asked === 2) ended = true;
      return Promise.resolve(false);
    },
    ended: () => ended,
    now: c.now,
    pause: c.pause,
  });
  assertEquals(outcome, "ended");
  assertEquals(asked, 2);
  assertEquals(c.pauses.length, 1);

  let never = 0;
  assertEquals(
    await awaitFirstFollowerCatchUp({
      caughtUp: () => {
        never++;
        return Promise.resolve(true);
      },
      ended: () => true,
    }),
    "ended",
  );
  assertEquals(never, 0);
});
