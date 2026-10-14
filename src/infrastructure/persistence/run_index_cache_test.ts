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

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { RunIndexSnapshot } from "../../domain/workflows/run_index_snapshot.ts";
import type { WorkflowRunSummary } from "../../domain/workflows/workflow_run_summary.ts";
import {
  type LoadedRunIndex,
  RunIndexCache,
  type RunIndexStamp,
} from "./run_index_cache.ts";

const NOW = Date.UTC(2026, 5, 1);
const OLD = NOW - 60_000;

function snapshotOf(count: number): RunIndexSnapshot {
  return RunIndexSnapshot.of(
    Array.from({ length: count }, (_, i): WorkflowRunSummary => ({
      id: `run-${i}`,
      workflowId: "wf",
      workflowName: "wf",
      status: "succeeded",
      startedAt: new Date(OLD + i),
      tags: {},
      inputs: {},
    })),
  );
}

function stampAt(
  indexMtime: number,
  dirMtime: number,
  size = 10,
): RunIndexStamp {
  return {
    index: { mtimeMs: indexMtime, size, ctimeMs: indexMtime, ino: 1 },
    dirMtimeMs: dirMtime,
  };
}

/** A cache over stamps the test sets, counting loads. */
function harness(
  options: { maxRuns?: number; now?: number } = {},
) {
  const stamps = new Map<string, RunIndexStamp | undefined>();
  let loads = 0;
  const cache = new RunIndexCache({
    stamp: (id) => Promise.resolve(stamps.get(id)),
    maxRuns: options.maxRuns,
    now: () => options.now ?? NOW,
  });
  const load = (
    snapshot: RunIndexSnapshot,
    fromIndex = true,
  ) =>
  (): Promise<LoadedRunIndex> => {
    loads++;
    return Promise.resolve({ snapshot, fromIndex });
  };
  return {
    cache,
    stamps,
    load,
    get loads() {
      return loads;
    },
  };
}

Deno.test("RunIndexCache: reuses a snapshot while its stamp is unchanged", async () => {
  const h = harness();
  h.stamps.set("wf", stampAt(OLD, OLD));
  const snapshot = snapshotOf(3);
  const first = await h.cache.get("wf", h.load(snapshot));
  const second = await h.cache.get("wf", h.load(snapshotOf(1)));
  assertStrictEquals(first, snapshot);
  assertStrictEquals(second, snapshot);
  assertEquals(h.loads, 1);
  assertEquals(h.cache.runs, 3);
});

Deno.test("RunIndexCache: a changed index file or records directory reloads", async () => {
  const h = harness();
  h.stamps.set("wf", stampAt(OLD, OLD));
  await h.cache.get("wf", h.load(snapshotOf(1)));

  h.stamps.set("wf", stampAt(OLD, OLD, 11));
  await h.cache.get("wf", h.load(snapshotOf(2)));
  assertEquals(h.loads, 2);

  h.stamps.set("wf", stampAt(OLD, OLD + 1, 11));
  const fresh = snapshotOf(3);
  assertStrictEquals(await h.cache.get("wf", h.load(fresh)), fresh);
  assertEquals(h.loads, 3);
  assertEquals(h.cache.runs, 3);
});

Deno.test("RunIndexCache: does not keep a snapshot whose stat is too recent or in the future", async () => {
  for (const mtime of [NOW - 500, NOW + 60_000]) {
    const indexRacy = harness();
    indexRacy.stamps.set("wf", stampAt(mtime, OLD));
    await indexRacy.cache.get("wf", indexRacy.load(snapshotOf(1)));
    await indexRacy.cache.get("wf", indexRacy.load(snapshotOf(1)));
    assertEquals(indexRacy.loads, 2);

    const dirRacy = harness();
    dirRacy.stamps.set("wf", stampAt(OLD, mtime));
    await dirRacy.cache.get("wf", dirRacy.load(snapshotOf(1)));
    await dirRacy.cache.get("wf", dirRacy.load(snapshotOf(1)));
    assertEquals(dirRacy.loads, 2);
  }
});

Deno.test("RunIndexCache: keeps nothing without an mtime, or for a snapshot not built from the index", async () => {
  const noMtime = harness();
  noMtime.stamps.set("wf", undefined);
  await noMtime.cache.get("wf", noMtime.load(snapshotOf(1)));
  await noMtime.cache.get("wf", noMtime.load(snapshotOf(1)));
  assertEquals(noMtime.loads, 2);

  const fallback = harness();
  fallback.stamps.set("wf", stampAt(OLD, OLD));
  await fallback.cache.get("wf", fallback.load(snapshotOf(1), false));
  await fallback.cache.get("wf", fallback.load(snapshotOf(1), false));
  assertEquals(fallback.loads, 2);
  assertEquals(fallback.cache.runs, 0);
});

Deno.test("RunIndexCache: does not keep a snapshot when the stamp moved during the load", async () => {
  const h = harness();
  h.stamps.set("wf", stampAt(OLD, OLD));
  await h.cache.get("wf", () => {
    h.stamps.set("wf", stampAt(OLD + 1, OLD + 1));
    return Promise.resolve({ snapshot: snapshotOf(1), fromIndex: true });
  });
  await h.cache.get("wf", h.load(snapshotOf(1)));
  // The second read loads again, then keeps what it built.
  await h.cache.get("wf", h.load(snapshotOf(1)));
  assertEquals(h.loads, 1);
});

Deno.test("RunIndexCache: evicts the least recently used workflows past the cap, and never keeps one over it", async () => {
  const h = harness({ maxRuns: 5 });
  for (const id of ["a", "b", "c"]) h.stamps.set(id, stampAt(OLD, OLD));
  await h.cache.get("a", h.load(snapshotOf(2)));
  await h.cache.get("b", h.load(snapshotOf(2)));
  // Touch a so b is the least recently used.
  await h.cache.get("a", h.load(snapshotOf(2)));
  await h.cache.get("c", h.load(snapshotOf(2)));
  assertEquals(h.cache.runs, 4);
  assertEquals(h.loads, 3);

  await h.cache.get("a", h.load(snapshotOf(2)));
  await h.cache.get("b", h.load(snapshotOf(2)));
  assertEquals(h.loads, 4);

  h.stamps.set("big", stampAt(OLD, OLD));
  await h.cache.get("big", h.load(snapshotOf(6)));
  await h.cache.get("big", h.load(snapshotOf(6)));
  assertEquals(h.loads, 6);
  assertEquals(h.cache.runs <= 5, true);
});

Deno.test("RunIndexCache: a failed load leaves no entry behind", async () => {
  const h = harness();
  h.stamps.set("wf", stampAt(OLD, OLD));
  await h.cache.get("wf", h.load(snapshotOf(2)));
  h.stamps.set("wf", stampAt(OLD + 1, OLD));
  await assertRejects(() =>
    h.cache.get("wf", () => Promise.reject(new Error("boom")))
  );
  assertEquals(h.cache.runs, 0);
  // The old stamp coming back does not revive the dropped snapshot.
  h.stamps.set("wf", stampAt(OLD, OLD));
  await h.cache.get("wf", h.load(snapshotOf(1)));
  assertEquals(h.loads, 2);
});

Deno.test("RunIndexCache.delete: drops a workflow's snapshot", async () => {
  const h = harness();
  h.stamps.set("wf", stampAt(OLD, OLD));
  await h.cache.get("wf", h.load(snapshotOf(2)));
  h.cache.delete("wf");
  assertEquals(h.cache.runs, 0);
  await h.cache.get("wf", h.load(snapshotOf(2)));
  assertEquals(h.loads, 2);
});

Deno.test("RunIndexCache: overlapping loads of one workflow count its runs once", async () => {
  const h = harness();
  h.stamps.set("wf", stampAt(OLD, OLD));
  const releases: Array<() => void> = [];
  const deferred = (snapshot: RunIndexSnapshot) => () =>
    new Promise<LoadedRunIndex>((resolve) =>
      releases.push(() => resolve({ snapshot, fromIndex: true }))
    );
  const first = h.cache.get("wf", deferred(snapshotOf(3)));
  const second = h.cache.get("wf", deferred(snapshotOf(3)));
  await waitFor(
    () => Promise.resolve(releases.length === 2),
    "both reads to start loading",
  );
  releases[0]();
  await first;
  releases[1]();
  const kept = await second;
  assertEquals(h.cache.runs, 3);
  assertStrictEquals(await h.cache.get("wf", h.load(snapshotOf(1))), kept);
  h.cache.delete("wf");
  assertEquals(h.cache.runs, 0);
});
