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
import { ReplicationGroupCommit } from "./replication_group_commit.ts";

type Action =
  | { readonly kind: "commit" }
  | { readonly kind: "settle"; readonly ok: boolean };

const arbActions = fc.array(
  fc.oneof(
    fc.constant<Action>({ kind: "commit" }),
    fc.boolean().map((ok): Action => ({ kind: "settle", ok })),
  ),
  { maxLength: 60 },
);

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * Commits land one at a time and syncs settle in any order relative to
 * them. Each sync publishes the head as it stood when it started, as
 * `syncAndPublishNow` takes its mark before syncing.
 */
async function simulate(actions: readonly Action[]) {
  let head = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const syncs: {
    readonly mark: number;
    readonly settle: (ok: boolean) => void;
  }[] = [];
  const published: number[] = [];
  const group = new ReplicationGroupCommit(() => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const mark = head;
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    syncs.push({
      mark,
      settle: (ok) => {
        inFlight--;
        if (ok) {
          published.push(mark);
          resolve(mark);
        } else {
          reject(new Error("unconfirmed"));
        }
      },
    });
    return promise;
  });
  const waiters: {
    readonly mark: number;
    state?: "resolved" | "rejected";
    publishedWhenSettled?: number;
  }[] = [];
  let settled = 0;
  const settleNext = (ok: boolean) => {
    const next = syncs[settled];
    if (next === undefined) return;
    settled++;
    next.settle(ok);
  };
  for (const action of actions) {
    if (action.kind === "commit") {
      head++;
      const waiter: (typeof waiters)[number] = { mark: head };
      waiters.push(waiter);
      group.confirm(head).then(
        () => {
          waiter.state = "resolved";
          waiter.publishedWhenSettled = Math.max(0, ...published);
        },
        () => waiter.state = "rejected",
      );
    } else {
      settleNext(action.ok);
    }
    await flush();
  }
  // Drain: every remaining sync succeeds.
  while (settled < syncs.length) {
    settleNext(true);
    await flush();
  }
  return { waiters, syncs, maxInFlight, commits: head };
}

Deno.test("ReplicationGroupCommit: never runs two syncs at once, and settles every caller", async () => {
  await fc.assert(
    fc.asyncProperty(arbActions, async (actions) => {
      const { waiters, maxInFlight } = await simulate(actions);
      assert(maxInFlight <= 1);
      for (const waiter of waiters) assert(waiter.state !== undefined);
    }),
  );
});

Deno.test("ReplicationGroupCommit: a confirmed caller's mark is covered by a published head", async () => {
  await fc.assert(
    fc.asyncProperty(arbActions, async (actions) => {
      const { waiters } = await simulate(actions);
      for (const waiter of waiters) {
        if (waiter.state === "resolved") {
          assert(waiter.publishedWhenSettled! >= waiter.mark);
        }
      }
    }),
  );
});

Deno.test("ReplicationGroupCommit: with every sync succeeding, all callers are confirmed with at most one sync per commit", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.constantFrom<Action>({ kind: "commit" }, {
          kind: "settle",
          ok: true,
        }),
        { maxLength: 60 },
      ),
      async (actions) => {
        const { waiters, syncs, commits } = await simulate(actions);
        for (const waiter of waiters) assertEquals(waiter.state, "resolved");
        assert(syncs.length <= commits);
      },
    ),
  );
});
