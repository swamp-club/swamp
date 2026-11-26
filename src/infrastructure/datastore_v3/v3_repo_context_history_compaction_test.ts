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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import type { CompactionProgress } from "../../domain/datastore_v3/commit_store.ts";
import type { HistoryCompactionRun } from "../../domain/datastore_v3/compaction_policy.ts";
import { initializeV3Datastore, type V3Datastore } from "./v3_datastore.ts";
import {
  closeV3Datastores,
  compactHistoryReporting,
  v3CompactionBlocker,
  V3MaintenanceBusyError,
  V3MaintenanceNotLeadingError,
  V3MaintenanceTimer,
} from "./v3_repo_context.ts";
import { acquireV3WriterLock } from "./v3_writer_lock.ts";

type Run = (
  signal: AbortSignal,
  onBatch?: (totals: CompactionProgress) => void,
) => Promise<HistoryCompactionRun>;

function historyHandle(datastorePath: string, run: Run) {
  const calls = { runs: 0 };
  const handle = {
    datastorePath,
    storage: {},
    readModel: { syncUnsyncedFiles: () => Promise.resolve(0) },
    compactIfDue: () => Promise.resolve(undefined),
    collectChunks: () => Promise.resolve({ deleted: 0, damaged: [] }),
    compactHistoryNow: (
      signal: AbortSignal,
      onBatch?: (totals: CompactionProgress) => void,
    ) => {
      calls.runs++;
      return run(signal, onBatch);
    },
    commitStore: { compactionPoint: () => Promise.resolve(42) },
  } as unknown as V3Datastore;
  return { handle, calls };
}

const REPORT = {
  point: 600,
  compacted: 600,
  batches: 3,
  released: 4,
  partitions: 2,
};

const folded: Run = () => Promise.resolve({ due: true, report: REPORT });

/** folds one batch, then waits for its signal and throws its reason */
const foldsThenWaits: Run = (signal, onBatch) => {
  onBatch?.({
    point: 250,
    compacted: 250,
    batches: 1,
    released: 1,
    partitions: 1,
  });
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
};

async function withHeldDatastore(
  fn: (datastorePath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-compact-now-" });
  try {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const release = await acquireV3WriterLock(datastorePath);
    try {
      await fn(datastorePath);
    } finally {
      await release();
    }
  } finally {
    await closeV3Datastores().catch(() => {});
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("compactHistoryReporting: a run not due reports the policy's floor, and a fold reports its report", async () => {
  const notDue = historyHandle("/fake", () =>
    Promise.resolve({
      due: false,
      eligibleCommits: 120,
      minCommits: 500,
      retainCommits: 2500,
    }));
  assertEquals(await compactHistoryReporting(notDue.handle, 60_000), {
    outcome: "not_due",
    eligibleCommits: 120,
    minCommits: 500,
    retainCommits: 2500,
  });
  const done = historyHandle("/fake", folded);
  assertEquals(await compactHistoryReporting(done.handle, 60_000), {
    outcome: "compacted",
    compacted: 600,
    batches: 3,
    released: 4,
    partitions: 2,
    compactedThrough: 600,
  });
});

Deno.test("compactHistoryReporting: a spent budget is timed_out with the batches folded so far", async () => {
  const { handle } = historyHandle("/fake", foldsThenWaits);
  assertEquals(await compactHistoryReporting(handle, 20), {
    outcome: "timed_out",
    budgetMs: 20,
    compacted: 250,
    batches: 1,
    released: 1,
    partitions: 1,
    compactedThrough: 250,
  });
});

Deno.test("compactHistoryReporting: a budget spent before any batch reports the store's point", async () => {
  const { handle } = historyHandle(
    "/fake",
    (signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      ),
  );
  const outcome = await compactHistoryReporting(handle, 20);
  assertEquals(outcome.outcome, "timed_out");
  assert(outcome.outcome === "timed_out");
  assertEquals(outcome.compacted, 0);
  assertEquals(outcome.compactedThrough, 42);
});

Deno.test("compactHistoryReporting: a stop rethrows its abort, and any other failure propagates", async () => {
  const stop = new AbortController();
  const { handle } = historyHandle("/fake", foldsThenWaits);
  const stopped = compactHistoryReporting(handle, 60_000, stop.signal);
  stop.abort(new Error("serve is shutting down"));
  await assertRejects(() => stopped, Error, "serve is shutting down");

  const failing = historyHandle(
    "/fake",
    () => Promise.reject(new Error("fenced")),
  );
  await assertRejects(
    () => compactHistoryReporting(failing.handle, 60_000),
    Error,
    "fenced",
  );
});

Deno.test("v3CompactionBlocker: a process holding no writer lease may not compact; one holding it may", async () => {
  assertEquals(
    await v3CompactionBlocker(historyHandle("/not-held", folded).handle),
    "no_writer_hold",
  );
  await withHeldDatastore(async (datastorePath) => {
    assertEquals(
      await v3CompactionBlocker(historyHandle(datastorePath, folded).handle),
      undefined,
    );
  });
});

Deno.test("V3MaintenanceTimer.compactNow: refused when not started, and when started without the writer lease (ADV-1)", async () => {
  const notStarted = historyHandle("/not-held", folded);
  const timer = new V3MaintenanceTimer(notStarted.handle, 60_000);
  await assertRejects(
    () => timer.compactNow(60_000, new AbortController().signal),
    V3MaintenanceNotLeadingError,
  );
  timer.start();
  try {
    await assertRejects(
      () => timer.compactNow(60_000, new AbortController().signal),
      V3MaintenanceNotLeadingError,
    );
  } finally {
    await timer.stop();
  }
  assertEquals(notStarted.calls.runs, 0);

  await withHeldDatastore(async (datastorePath) => {
    const held = historyHandle(datastorePath, folded);
    const stopped = new V3MaintenanceTimer(held.handle, 60_000);
    stopped.start();
    await stopped.stop();
    await assertRejects(
      () => stopped.compactNow(60_000, new AbortController().signal),
      V3MaintenanceNotLeadingError,
      undefined,
      "a stopped timer's signal no longer aborts",
    );
    assertEquals(held.calls.runs, 0);
  });
});

Deno.test("V3MaintenanceTimer.compactNow: a leader's run waits for the work in flight, then compacts", async () => {
  await withHeldDatastore(async (datastorePath) => {
    const { handle, calls } = historyHandle(datastorePath, folded);
    const timer = new V3MaintenanceTimer(handle, 60_000);
    timer.start();
    await timer.runExclusive(() => Promise.resolve());
    try {
      let release!: () => void;
      const inFlight = timer.runExclusive(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const asked = timer.compactNow(60_000, new AbortController().signal);
      await Promise.resolve();
      assertEquals(calls.runs, 0, "it waits for the work in flight");
      release();
      await inFlight;
      assertEquals((await asked).outcome, "compacted");
      assertEquals(calls.runs, 1);
    } finally {
      await timer.stop();
    }
  });
});

Deno.test("V3MaintenanceTimer.compactNow: work in flight past the wait answers busy and runs nothing (ADV-4)", async () => {
  await withHeldDatastore(async (datastorePath) => {
    const { handle, calls } = historyHandle(datastorePath, folded);
    const timer = new V3MaintenanceTimer(handle, 60_000);
    timer.start();
    await timer.runExclusive(() => Promise.resolve());
    try {
      let release!: () => void;
      const inFlight = timer.runExclusive(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      await assertRejects(
        () => timer.compactNow(60_000, new AbortController().signal, 10),
        V3MaintenanceBusyError,
      );
      assertEquals(calls.runs, 0);
      release();
      await inFlight;
    } finally {
      await timer.stop();
    }
  });
});

Deno.test("V3MaintenanceTimer.compactNow: stop() mid-run aborts it rather than reporting a fold (ADV-2)", async () => {
  await withHeldDatastore(async (datastorePath) => {
    const { handle, calls } = historyHandle(datastorePath, foldsThenWaits);
    const timer = new V3MaintenanceTimer(handle, 60_000);
    timer.start();
    const asked = timer.compactNow(60_000, new AbortController().signal);
    await waitFor(() => calls.runs === 1, "the compaction to start");
    await timer.stop();
    await assertRejects(() => asked);
  });
});

Deno.test("V3MaintenanceTimer.compactNow: beside a retention pass's exclusive run, both finish (ADV-3)", async () => {
  await withHeldDatastore(async (datastorePath) => {
    const { handle } = historyHandle(datastorePath, folded);
    const timer = new V3MaintenanceTimer(handle, 60_000);
    timer.start();
    await timer.runExclusive(() => Promise.resolve());
    try {
      const order: string[] = [];
      let release!: () => void;
      const retention = timer.runExclusive(async () => {
        await new Promise<void>((resolve) => (release = resolve));
        order.push("retention");
      });
      const asked = timer.compactNow(60_000, new AbortController().signal)
        .then((outcome) => {
          order.push("compaction");
          return outcome;
        });
      await Promise.resolve();
      release();
      await retention;
      assertEquals((await asked).outcome, "compacted");
      assertEquals(order, ["retention", "compaction"]);
    } finally {
      await timer.stop();
    }
  });
});

Deno.test("V3MaintenanceTimer.compactNow: a retention pass arriving during a compaction waits for it, and both finish (ADV-3)", async () => {
  await withHeldDatastore(async (datastorePath) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const { handle, calls } = historyHandle(datastorePath, async () => {
      await gate;
      order.push("compaction");
      return { due: true, report: REPORT };
    });
    const timer = new V3MaintenanceTimer(handle, 60_000);
    timer.start();
    try {
      const asked = timer.compactNow(60_000, new AbortController().signal);
      await waitFor(() => calls.runs === 1, "the compaction to start");
      const retention = timer.runExclusive(() => {
        order.push("retention");
        return Promise.resolve();
      });
      release();
      assertEquals((await asked).outcome, "compacted");
      await retention;
      assertEquals(order, ["compaction", "retention"]);
    } finally {
      await timer.stop();
    }
  });
});
