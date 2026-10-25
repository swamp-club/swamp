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

/**
 * What serve's datastore API costs the commit store (swamp-club#3915):
 *
 * - a burst of {@link BURST} concurrent appends to one partition, with group
 *   commit (one fsync for the burst) and without (one per append);
 * - one solo append, which group commit leaves as it was;
 * - the txnIds a busy cached partition holds after {@link BUSY_COMMITS}
 *   appends, with the bound (re-restored from each snapshot) and without,
 *   printed once.
 *
 * Each A/A pair runs the same case on its own store twice, so a gap between
 * them is noise. Run with:
 *
 * ```
 * deno bench -A scripts/bench_v3_serve_datastore_api.ts
 * ```
 */

import { join } from "@std/path";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import {
  modelCommit,
  modelPartition,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  DEFAULT_SNAPSHOT_INTERVAL,
  SqliteCommitStore,
  type SqliteCommitStoreOptions,
} from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";

/** Appends per burst. */
const BURST = 32;
/** Appends to the busy partition whose txnIds are counted. */
const BUSY_COMMITS = 5_000;

const dir = await Deno.makeTempDir({ prefix: "swamp-v3-serve-api-bench-" });

/** A store on its own file, appending to one partition in seq order. */
function writer(name: string, options: SqliteCommitStoreOptions = {}) {
  const store = SqliteCommitStore.open(join(dir, `${name}.db`), options);
  let seq = 0;
  return {
    store,
    /** The next `count` commits, built outside the timed part. */
    async next(count: number): Promise<Commit[]> {
      const commits: Commit[] = [];
      for (let i = 0; i < count; i++) {
        seq++;
        commits.push(
          modelCommit(seq, [await savePut("a", seq), versionOp("a", seq)], {
            fence: 1,
            txnId: `${name}-${seq}`,
          }),
        );
      }
      return commits;
    },
  };
}

const groupedA = writer("grouped-a");
const groupedControl = writer("grouped-control");
const ungrouped = writer("ungrouped", { groupCommit: false });
const soloA = writer("solo-a");
const soloControl = writer("solo-control");

async function burst(
  target: ReturnType<typeof writer>,
  b: Deno.BenchContext,
): Promise<void> {
  const commits = await target.next(BURST);
  b.start();
  await Promise.all(commits.map((commit) => target.store.append(commit)));
  b.end();
}

async function solo(
  target: ReturnType<typeof writer>,
  b: Deno.BenchContext,
): Promise<void> {
  const [commit] = await target.next(1);
  b.start();
  await target.store.append(commit);
  b.end();
}

Deno.bench(`burst of ${BURST} appends, grouped (A)`, {
  group: "burst",
  baseline: true,
}, async (b) => {
  await burst(groupedA, b);
});

Deno.bench(`burst of ${BURST} appends, grouped (A/A control)`, {
  group: "burst",
}, async (b) => {
  await burst(groupedControl, b);
});

Deno.bench(`burst of ${BURST} appends, ungrouped`, {
  group: "burst",
}, async (b) => {
  await burst(ungrouped, b);
});

Deno.bench("solo append (A)", { group: "solo", baseline: true }, async (b) => {
  await solo(soloA, b);
});

Deno.bench("solo append (A/A control)", { group: "solo" }, async (b) => {
  await solo(soloControl, b);
});

/** The txnIds the busy partition holds after {@link BUSY_COMMITS} appends. */
async function busyTxnIds(boundTxnIds: boolean): Promise<number | undefined> {
  const busy = writer(`busy-${boundTxnIds}`, { boundTxnIds });
  for (let done = 0; done < BUSY_COMMITS; done += BURST) {
    const commits = await busy.next(Math.min(BURST, BUSY_COMMITS - done));
    await Promise.all(commits.map((commit) => busy.store.append(commit)));
  }
  const count = busy.store.cachedTxnIdCount("", modelPartition());
  await busy.store.close();
  return count;
}

console.log(
  `txnIds held by a cached partition after ${BUSY_COMMITS} appends ` +
    `(snapshot interval ${DEFAULT_SNAPSHOT_INTERVAL}): bounded ${await busyTxnIds(
      true,
    )}, unbounded ${await busyTxnIds(false)}`,
);

globalThis.addEventListener("unload", () => {
  Deno.removeSync(dir, { recursive: true });
});
