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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Semaphore } from "./semaphore.ts";

Deno.test("Semaphore: throws on limit < 1", () => {
  assertThrows(() => new Semaphore(0), Error, "at least 1");
  assertThrows(() => new Semaphore(-1), Error, "at least 1");
});

Deno.test("Semaphore: acquire within limit resolves immediately", async () => {
  const sem = new Semaphore(2);
  await sem.acquire();
  await sem.acquire();
});

Deno.test("Semaphore: acquire beyond limit blocks until release", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();

  let acquired = false;
  const pending = sem.acquire().then(() => {
    acquired = true;
  });

  // Yield to let microtasks run — still blocked
  await Promise.resolve();
  assertEquals(acquired, false);

  sem.release();
  await pending;
  assertEquals(acquired, true);
});

Deno.test("Semaphore: tracks max concurrency correctly", async () => {
  const sem = new Semaphore(3);
  let active = 0;
  let maxActive = 0;

  const work = async () => {
    await sem.acquire();
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    sem.release();
  };

  await Promise.all(Array.from({ length: 10 }, () => work()));
  assertEquals(maxActive, 3);
});

Deno.test("Semaphore: acquire with pre-aborted signal rejects", async () => {
  const sem = new Semaphore(1);
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () => sem.acquire(controller.signal),
    DOMException,
  );
});

Deno.test("Semaphore: acquire aborted while waiting rejects", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();

  const controller = new AbortController();
  const pending = sem.acquire(controller.signal);

  controller.abort();
  await assertRejects(
    () => pending,
    DOMException,
  );

  sem.release();
});

Deno.test("Semaphore: release after abort does not double-count", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();

  const controller = new AbortController();
  const p = sem.acquire(controller.signal).catch(() => {});
  controller.abort();
  await p;

  sem.release();

  // Only one permit should be available now
  await sem.acquire();
  let acquired = false;
  const pending = sem.acquire().then(() => {
    acquired = true;
  });
  await Promise.resolve();
  assertEquals(acquired, false);
  sem.release();
  await pending;
});
