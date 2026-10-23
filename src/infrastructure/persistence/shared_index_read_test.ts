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
import { SharedIndexRead } from "./shared_index_read.ts";

Deno.test("SharedIndexRead: cancelling before the loader starts still releases its registration", async () => {
  let started = false;
  let released = 0;
  const read = new SharedIndexRead(() => {
    started = true;
    return Promise.resolve(1);
  }, () => released++);
  const abort = new AbortController();
  const waiting = read.get(abort.signal);
  const rejected = assertRejects(() => waiting, DOMException, "stopped");
  abort.abort(new DOMException("stopped", "AbortError"));
  await rejected;
  // The owner still releases the registration even though the loader never ran.
  assertEquals(read.signal.aborted, true);
  assertEquals(released, 1);
  assertEquals(started, false);
});

Deno.test("SharedIndexRead: a late loader failure after every reader cancels is observed and releases ownership", async () => {
  const ready = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<number>();
  const released = Promise.withResolvers<void>();
  const read = new SharedIndexRead(() => {
    ready.resolve();
    return finish.promise;
  }, () => released.resolve());
  const abort = new AbortController();
  const waiting = read.get(abort.signal);
  const rejected = assertRejects(() => waiting, DOMException, "stopped");
  await ready.promise;
  abort.abort(new DOMException("stopped", "AbortError"));
  await rejected;
  finish.reject(new Error("late disk failure"));
  await released.promise;
  assertEquals(read.signal.aborted, true);
});
