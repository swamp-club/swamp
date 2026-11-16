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
import type { BaseIndexEntry } from "../../domain/datastore_v3/commit_store.ts";
import type {
  PartitionBaseInstall,
  PartitionInstallOutcome,
} from "./sqlite_commit_store.ts";
import {
  FOLLOW_COMPACTION_THRESHOLD,
  followEachWithin,
  ServeCompactionFollower,
  type ServeCompactionFollowerOptions,
  WHOLE_INSTALL_MAX_ROWS,
} from "./serve_compaction_follow.ts";
import type { ServePartitionBase } from "./serve_datastore_client.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { V3WriterBusyError } from "./v3_writer_lock.ts";

interface Fixture {
  feature?: () => boolean;
  foldable?: number;
  partitions: BaseIndexEntry[];
  positions?: Map<string, { compacted: number; source?: number }>;
  /** milliseconds the fake clock advances per install */
  installMs?: number;
  busy?: boolean;
  reads?: Map<string, ServePartitionBase | "gone" | "too-large">;
  /** pages a hot partition's whole base comes in */
  pages?: number;
  /** milliseconds the fake clock advances per staged page */
  pageMs?: number;
  /** milliseconds the fake clock advances per partition fetch */
  fetchMs?: number;
  /** the staged swap throws, as a refused install does */
  swapRefused?: boolean;
}

function entry(
  partition: string,
  rows: number,
  options: Partial<BaseIndexEntry> = {},
): BaseIndexEntry {
  return {
    partition,
    seq: 10,
    rows,
    horizon: 0,
    contested: false,
    ...options,
  };
}

function follower(fixture: Fixture) {
  let now = 0;
  const installs: PartitionBaseInstall[] = [];
  const asked: { partition: string; since?: number }[] = [];
  let released = 0;
  let staging:
    | {
      partition: string;
      seq: number;
      next?: string;
      complete: boolean;
      rows: number;
    }
    | undefined;
  const swapped: string[] = [];
  const options: ServeCompactionFollowerOptions = {
    client: {
      takesBaseDifference: fixture.feature ?? (() => true),
      baseIndex: () =>
        Promise.resolve({ point: 10, partitions: fixture.partitions }),
      basePartition: (partition, since) => {
        asked.push({ partition, ...(since === undefined ? {} : { since }) });
        now += fixture.fetchMs ?? 0;
        return Promise.resolve(
          fixture.reads?.get(partition) ??
            { seq: 10, horizon: 0, entries: [], removed: [] },
        );
      },
      basePartitionPage: (_partition, after) => {
        const page = after === undefined ? 1 : Number(after);
        now += fixture.pageMs ?? 1;
        return Promise.resolve({
          seq: 10,
          entries: [],
          next: page < (fixture.pages ?? 1) ? String(page + 1) : undefined,
        });
      },
    },
    commitStore: {
      foldableCommits: () =>
        Promise.resolve(fixture.foldable ?? FOLLOW_COMPACTION_THRESHOLD),
      basePositions: () => Promise.resolve(fixture.positions ?? new Map()),
      installPartitionBase: (
        install,
      ): Promise<PartitionInstallOutcome> => {
        installs.push(install);
        now += fixture.installMs ?? 1;
        return Promise.resolve({
          kind: "installed",
          rows: 1,
          commitsRemoved: 1,
        });
      },
      stagedPartition: () =>
        Promise.resolve(
          staging === undefined ? undefined : { namespace: "", ...staging },
        ),
      stagePartitionPage: (page) => {
        staging = {
          partition: page.partition,
          seq: page.seq,
          ...(page.next === undefined ? {} : { next: page.next }),
          complete: page.next === undefined,
          rows: (staging?.rows ?? 0) + 1,
        };
        return Promise.resolve();
      },
      clearStagedPartition: () => {
        staging = undefined;
        return Promise.resolve();
      },
      installStagedPartition: () => {
        if (fixture.swapRefused) {
          return Promise.reject(new Error("chunk counts drifted"));
        }
        swapped.push(staging!.partition);
        staging = undefined;
        return Promise.resolve({
          kind: "installed" as const,
          rows: 1,
          commitsRemoved: 0,
        });
      },
    },
    copyDir: "unused",
    namespace: "",
    tryLockCopy: () =>
      fixture.busy
        ? Promise.reject(
          new V3WriterBusyError("copy", new LockTimeoutError("copy", null, 0)),
        )
        : Promise.resolve(() => {
          released++;
          return Promise.resolve();
        }),
    clock: () => now,
  };
  return {
    follower: new ServeCompactionFollower(options),
    installs,
    asked,
    released: () => released,
    swapped,
    staging: () => staging,
  };
}

Deno.test("ServeCompactionFollower.follow: does nothing against a serve that does not name base-difference", async () => {
  const { follower: f, installs } = follower({
    feature: () => false,
    partitions: [entry("p", 1)],
  });
  assertEquals((await f.follow(1_000, () => 0)).outcome, "no-feature");
  assertEquals(installs, []);
});

Deno.test("ServeCompactionFollower.follow: does nothing below the foldable-commit threshold", async () => {
  const { follower: f, installs } = follower({
    foldable: FOLLOW_COMPACTION_THRESHOLD - 1,
    partitions: [entry("p", 1)],
  });
  assertEquals((await f.follow(1_000, () => 0)).outcome, "below-threshold");
  assertEquals(installs, []);
});

Deno.test("ServeCompactionFollower.follow: skips when another process holds the copy", async () => {
  const { follower: f, installs } = follower({
    busy: true,
    partitions: [entry("p", 1)],
  });
  assertEquals((await f.follow(1_000, () => 0)).outcome, "busy");
  assertEquals(installs, []);
});

Deno.test("ServeCompactionFollower.follow: installs small partitions whole and hot ones by difference from their serve seq, and releases the lock", async () => {
  const hot = WHOLE_INSTALL_MAX_ROWS + 1;
  const { follower: f, installs, asked, released } = follower({
    partitions: [
      entry("small", 4),
      entry("hot", hot),
      entry("current", 4, { seq: 5 }),
    ],
    positions: new Map([
      ["hot", { compacted: 7, source: 7 }],
      ["current", { compacted: 5, source: 5 }],
    ]),
  });
  const report = await f.follow(1_000, () => 42);
  assertEquals(report.installed, 2);
  assertEquals(
    installs.map((i) => [i.partition, i.mode, i.readModelCursor]),
    [["small", "whole", 42], ["hot", "difference", 42]],
  );
  assertEquals(asked, [{ partition: "small" }, { partition: "hot", since: 7 }]);
  assertEquals(released(), 1);
});

Deno.test("ServeCompactionFollower.follow: never installs a contested partition, and stages a hot partition with no serve-sourced base before swapping it in whole", async () => {
  const hot = WHOLE_INSTALL_MAX_ROWS + 1;
  const { follower: f, installs, swapped } = follower({
    partitions: [
      entry("hot-no-source", hot),
      entry("contested", 4, { contested: true }),
      entry("hot-past-horizon", hot, { horizon: 9 }),
    ],
    positions: new Map([["hot-past-horizon", { compacted: 7, source: 7 }]]),
    pages: 3,
  });
  const report = await f.follow(1_000, () => 0);
  assertEquals(installs, []);
  assertEquals(swapped, ["hot-no-source"]);
  assertEquals([report.staged, report.bootstrapped], [3, 1]);
  // the contested one, and the hot one waiting its turn to be staged
  assertEquals(report.deferred, 2);
});

Deno.test("ServeCompactionFollower.follow: a hot partition's staging resumes in the next command where the budget left it", async () => {
  const hot = WHOLE_INSTALL_MAX_ROWS + 1;
  const run = follower({
    partitions: [entry("hot", hot)],
    pages: 40,
    pageMs: 60,
  });
  const first = await run.follower.follow(200, () => 0);
  assertEquals(first.bootstrapped, 0);
  assertEquals(run.staging()?.complete, false);
  let total = first.staged;
  for (let i = 0; i < 10 && run.swapped.length === 0; i++) {
    total += (await run.follower.follow(1_000, () => 0)).staged;
  }
  assertEquals(run.swapped, ["hot"]);
  assertEquals(total, 40);
});

Deno.test("ServeCompactionFollower.follow: stops between partitions when the budget is spent, deferring the rest", async () => {
  const { follower: f, installs } = follower({
    partitions: [entry("a", 1), entry("b", 1), entry("c", 1), entry("d", 1)],
    installMs: 300,
  });
  const report = await f.follow(1_000, () => 0);
  assertEquals(installs.length, report.installed);
  assertEquals(report.installed + report.deferred, 4);
  assertEquals(report.installed < 4, true);
});

Deno.test("ServeCompactionFollower.follow: stops when a takeover to an older serve withdraws the feature mid-run", async () => {
  let calls = 0;
  const { follower: f, installs } = follower({
    // the first check opens the run, the next allows one partition
    feature: () => ++calls <= 2,
    partitions: [entry("a", 1), entry("b", 1), entry("c", 1)],
  });
  const report = await f.follow(1_000, () => 0);
  assertEquals(installs.length, 1);
  assertEquals(report.deferred, 2);
});

Deno.test("ServeCompactionFollower.follow: a partition whose difference serve forgot, or that is too large, is staged instead, never deferred for good", async () => {
  const hot = WHOLE_INSTALL_MAX_ROWS + 1;
  const { follower: f, installs, swapped } = follower({
    partitions: [entry("gone", hot), entry("big", hot)],
    positions: new Map([
      ["gone", { compacted: 7, source: 7 }],
      ["big", { compacted: 7, source: 7 }],
    ]),
    reads: new Map<string, ServePartitionBase | "gone" | "too-large">([
      ["gone", "gone"],
      ["big", "too-large"],
    ]),
  });
  const report = await f.follow(1_000, () => 0);
  assertEquals(installs, []);
  // one staged at a time: the other waits its turn
  assertEquals(swapped, ["gone"]);
  assertEquals(report.deferred, 1);
});

Deno.test("ServeCompactionFollower.follow: a write that no longer fits once its fetch has taken its time is left for the next command", async () => {
  const hot = WHOLE_INSTALL_MAX_ROWS + 1;
  const removed = Array.from({ length: 2_000 }, (_, i) => ({
    section: "record" as const,
    key: `k${i}`,
  }));
  const { follower: f, installs } = follower({
    partitions: [entry("hot", hot)],
    positions: new Map([["hot", { compacted: 7, source: 7 }]]),
    reads: new Map([["hot", { seq: 10, horizon: 0, entries: [], removed }]]),
    fetchMs: 900,
  });
  const report = await f.follow(1_000, () => 0);
  assertEquals(installs, []);
  assertEquals(report.deferred, 1);
});

Deno.test("ServeCompactionFollower.follow: a difference too large for any one command's budget is staged instead", async () => {
  const hot = WHOLE_INSTALL_MAX_ROWS + 1;
  const removed = Array.from({ length: 40_000 }, (_, i) => ({
    section: "record" as const,
    key: `k${i}`,
  }));
  const { follower: f, installs, swapped } = follower({
    partitions: [entry("hot", hot)],
    positions: new Map([["hot", { compacted: 7, source: 7 }]]),
    reads: new Map([["hot", { seq: 10, horizon: 0, entries: [], removed }]]),
  });
  await f.follow(1_000, () => 0);
  assertEquals(installs, []);
  assertEquals(swapped, ["hot"]);
});

Deno.test("ServeCompactionFollower.follow: a staged swap that is refused clears its staging, so it never blocks the next partition", async () => {
  const hot = WHOLE_INSTALL_MAX_ROWS + 1;
  const run = follower({
    partitions: [entry("hot", hot)],
    swapRefused: true,
  });
  const report = await run.follower.follow(1_000, () => 0);
  assertEquals(report.refused, 1);
  assertEquals(run.staging(), undefined);
});

Deno.test("followEachWithin: shares one budget across serve-mode copies, skips the rest, and goes on past a failing one", async () => {
  let now = 0;
  const calls: [string, number][] = [];
  const handle = (path: string, spend: number, fail = false) => ({
    datastorePath: path,
    followServeCompaction: (budget: number) => {
      calls.push([path, budget]);
      now += spend;
      return fail ? Promise.reject(new Error("boom")) : Promise.resolve();
    },
  });
  const errors: string[] = [];
  await followEachWithin(
    [
      handle("solo", 0),
      handle("offline", 0),
      handle("failing", 300, true),
      handle("first", 400),
      { datastorePath: "no-serve-client" },
      handle("second", 400),
      handle("after-budget", 0),
    ],
    1_000,
    {
      followsServe: (path) => path !== "solo",
      offline: (path) => path === "offline",
      clock: () => now,
      onError: (path) => errors.push(path),
    },
  );
  assertEquals(calls, [["failing", 1_000], ["first", 700], ["second", 300]]);
  assertEquals(errors, ["failing"]);
});
