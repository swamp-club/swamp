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
  FOLLOWER_READY_STALL_LOG_MS,
  FOLLOWER_READY_WAIT_MS,
} from "./follower_ready.ts";

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

Deno.test("awaitFirstFollowerCatchUp: keeps waiting past the bound, saying so at the bound and then every stall interval", async () => {
  const c = clock();
  let asked = 0;
  const stalls: number[] = [];
  const answersUntil = FOLLOWER_READY_WAIT_MS + 2 * FOLLOWER_READY_STALL_LOG_MS;
  const outcome = await awaitFirstFollowerCatchUp({
    caughtUp: () => {
      asked++;
      return Promise.resolve(c.now() >= answersUntil);
    },
    ended: () => false,
    stalled: (waited) => stalls.push(waited),
    now: c.now,
    pause: c.pause,
  });
  assertEquals(outcome, "caught-up");
  assertEquals(stalls, [
    FOLLOWER_READY_WAIT_MS,
    FOLLOWER_READY_WAIT_MS + FOLLOWER_READY_STALL_LOG_MS,
  ]);
  assertEquals(asked, answersUntil / FOLLOWER_READY_RETRY_MS + 1);
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
