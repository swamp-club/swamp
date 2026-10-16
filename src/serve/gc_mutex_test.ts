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
import { GcMutex } from "./gc_mutex.ts";

Deno.test("GcMutex.run: collections run one at a time, in order", async () => {
  const mutex = new GcMutex();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = mutex.run(async () => {
    order.push("first:start");
    await new Promise<void>((resolve) => (releaseFirst = resolve));
    order.push("first:end");
  });
  const second = mutex.run(() => {
    order.push("second");
    return Promise.resolve();
  });
  assertEquals(mutex.held, true);
  assertEquals(await mutex.tryRun(() => Promise.resolve(1)), undefined);
  releaseFirst();
  await Promise.all([first, second]);
  assertEquals(order, ["first:start", "first:end", "second"]);
  assertEquals(mutex.held, false);
  assertEquals(await mutex.tryRun(() => Promise.resolve(1)), 1);
});

Deno.test("GcMutex.waiting: true only while a collection queues behind the one running", async () => {
  const mutex = new GcMutex();
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
  const first = mutex.run(() => gate);
  assertEquals(mutex.waiting, false);
  const second = mutex.run(() => Promise.resolve());
  assertEquals(mutex.waiting, true);
  releaseFirst();
  await Promise.all([first, second]);
  assertEquals(mutex.waiting, false);
});
