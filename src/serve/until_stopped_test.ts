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
import { assertEquals, assertStrictEquals } from "@std/assert";
import { STOPPED, stoppedBy, untilStopped } from "./until_stopped.ts";

Deno.test("untilStopped: settles as the work does when it finishes first", async () => {
  const abort = new AbortController();
  const { stopped, release } = stoppedBy(abort.signal);
  try {
    assertEquals(await untilStopped(Promise.resolve(7), stopped), 7);
  } finally {
    release();
  }
});

Deno.test("untilStopped: settles STOPPED once the signal aborts and lets the work go", async () => {
  const abort = new AbortController();
  const { stopped, release } = stoppedBy(abort.signal);
  const work = Promise.withResolvers<number>();
  try {
    const result = untilStopped(work.promise, stopped);
    abort.abort();
    assertStrictEquals(await result, STOPPED);
    // A failure after the stop is no longer wanted: it must not surface as an
    // unhandled rejection.
    work.reject(new Error("rebuild aborted"));
    await work.promise.catch(() => {});
  } finally {
    release();
  }
});

Deno.test("stoppedBy: an already aborted signal resolves STOPPED at once", async () => {
  const abort = new AbortController();
  abort.abort();
  const { stopped, release } = stoppedBy(abort.signal);
  try {
    const never = new Promise<number>(() => {});
    assertStrictEquals(await untilStopped(never, stopped), STOPPED);
  } finally {
    release();
  }
});
