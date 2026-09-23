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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { ReadWriteLock } from "./read_write_lock.ts";

type Mode = "shared" | "exclusive";

type Command =
  | { kind: "acquire"; mode: Mode }
  | { kind: "try" }
  | { kind: "release"; pick: number }
  | { kind: "abort"; pick: number };

const arbCommand: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant("acquire" as const),
    mode: fc.constantFrom<Mode>("shared", "exclusive"),
  }),
  fc.record({ kind: fc.constant("try" as const) }),
  fc.record({ kind: fc.constant("release" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("abort" as const), pick: fc.nat() }),
);

interface Acquirer {
  id: number;
  mode: Mode;
  controller: AbortController;
  state: "queued" | "held" | "aborted" | "released";
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function compatible(mode: Mode, lock: ReadWriteLock): boolean {
  if (lock.exclusiveHeld) return false;
  return mode === "shared" || lock.sharedHolders === 0;
}

/**
 * Drives random acquire / tryAcquire / release / abort sequences against the
 * lock and checks, after every step, the invariants its callers rely on:
 * no exclusive holder alongside any other holder, queued grants in arrival
 * order, tryAcquire never touching the queue, and no lost wakeup (a
 * compatible head waiter is always admitted — the abort-at-head case).
 */
Deno.test("ReadWriteLock property: invariants hold across random command sequences", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbCommand, { minLength: 1, maxLength: 60 }),
      async (commands) => {
        const lock = new ReadWriteLock();
        const acquirers: Acquirer[] = [];
        const grantOrder: number[] = [];
        let nextId = 0;

        const check = () => {
          assert(
            !(lock.exclusiveHeld && lock.sharedHolders > 0),
            "exclusive holder alongside shared holders",
          );
          const held = acquirers.filter((a) => a.state === "held");
          const heldExclusive = held.filter((a) => a.mode === "exclusive");
          // tryAcquire holders are tracked as exclusive acquirers too.
          assertEquals(
            lock.sharedHolders,
            held.filter((a) => a.mode === "shared").length,
          );
          assertEquals(lock.exclusiveHeld, heldExclusive.length === 1);
          assert(heldExclusive.length <= 1, "two exclusive holders");

          const queued = acquirers.filter((a) => a.state === "queued");
          assertEquals(lock.waiters, queued.length);
          if (queued.length > 0) {
            assert(
              !compatible(queued[0].mode, lock),
              "compatible head waiter was not admitted (lost wakeup)",
            );
          }
        };

        for (const command of commands) {
          switch (command.kind) {
            case "acquire": {
              const acquirer: Acquirer = {
                id: nextId++,
                mode: command.mode,
                controller: new AbortController(),
                state: "queued",
              };
              acquirers.push(acquirer);
              const pending = command.mode === "exclusive"
                ? lock.acquire(acquirer.controller.signal)
                : lock.acquireShared(acquirer.controller.signal);
              pending.then(
                () => {
                  acquirer.state = "held";
                  grantOrder.push(acquirer.id);
                },
                () => {
                  acquirer.state = "aborted";
                },
              );
              break;
            }
            case "try": {
              const waitersBefore = lock.waiters;
              const idle = !lock.exclusiveHeld && lock.sharedHolders === 0 &&
                lock.waiters === 0;
              const took = lock.tryAcquire();
              assertEquals(took, idle, "tryAcquire result");
              assertEquals(lock.waiters, waitersBefore, "tryAcquire queued");
              if (took) {
                acquirers.push({
                  id: nextId++,
                  mode: "exclusive",
                  controller: new AbortController(),
                  state: "held",
                });
              }
              break;
            }
            case "release": {
              const held = acquirers.filter((a) => a.state === "held");
              if (held.length === 0) break;
              const target = held[command.pick % held.length];
              target.state = "released";
              if (target.mode === "exclusive") lock.release();
              else lock.releaseShared();
              break;
            }
            case "abort": {
              const queued = acquirers.filter((a) => a.state === "queued");
              if (queued.length === 0) break;
              queued[command.pick % queued.length].controller.abort();
              break;
            }
          }
          await flushMicrotasks();
          check();
        }

        // Drain: releasing every holder until quiet leaves the lock idle.
        for (let guard = 0; guard < 1000; guard++) {
          const held = acquirers.filter((a) => a.state === "held");
          if (held.length === 0) break;
          for (const h of held) {
            h.state = "released";
            if (h.mode === "exclusive") lock.release();
            else lock.releaseShared();
          }
          await flushMicrotasks();
        }
        assertEquals(lock.exclusiveHeld, false);
        assertEquals(lock.sharedHolders, 0);
        assertEquals(lock.waiters, 0);

        // Acquirers are granted in arrival order. Checked after the drain so
        // waiters granted only once everything was released are included. An
        // immediate grant only happens with an empty queue, so every earlier
        // acquirer was already granted or aborted; ids follow arrival order.
        const sorted = [...grantOrder].sort((a, b) => a - b);
        assertEquals(grantOrder, sorted, "grants out of arrival order");
      },
    ),
    { numRuns: 300 },
  );
});
