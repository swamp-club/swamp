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
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { RunIndexWarmup, type RunIndexWarmupDeps } from "./run_index_warmup.ts";

await initializeLogging({});

/** Deps for a warm-up over `ids`, each with one run, under a 10-run cap. */
function warmupDeps(
  ids: string[],
  overrides: Partial<RunIndexWarmupDeps> = {},
): RunIndexWarmupDeps {
  return {
    listWorkflowIds: () => Promise.resolve(ids),
    countRunRecords: () => Promise.resolve(1),
    maxRuns: 10,
    warm: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("RunIndexWarmup: reads every workflow's snapshot in the background, one at a time", async () => {
  const warmed: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const warmup = new RunIndexWarmup(warmupDeps(["a", "b", "c"], {
    warm: async (id) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      warmed.push(id);
      inFlight--;
    },
  }));
  warmup.start();
  await warmup.finished();
  assertEquals(warmed, ["a", "b", "c"]);
  assertEquals(maxInFlight, 1);
});

Deno.test("RunIndexWarmup: a workflow that fails to load does not stop the rest", async () => {
  const warmed: string[] = [];
  const warmup = new RunIndexWarmup(warmupDeps(["a", "broken", "c"], {
    warm: (id) => {
      if (id === "broken") return Promise.reject(new Error("unreadable"));
      warmed.push(id);
      return Promise.resolve();
    },
  }));
  warmup.start();
  await warmup.finished();
  assertEquals(warmed, ["a", "c"]);
});

Deno.test("RunIndexWarmup: a listing that fails ends the warm-up without throwing", async () => {
  let warms = 0;
  const warmup = new RunIndexWarmup(warmupDeps([], {
    listWorkflowIds: () => Promise.reject(new Error("no workflows dir")),
    warm: () => {
      warms++;
      return Promise.resolve();
    },
  }));
  warmup.start();
  await warmup.finished();
  assertEquals(warms, 0);
});

Deno.test("RunIndexWarmup: dispose resolves while the workflow in flight is still loading, and warms no more", async () => {
  const warmed: string[] = [];
  const { promise: loaded, resolve: release } = Promise.withResolvers<void>();
  let reached = false;
  const warmup = new RunIndexWarmup(warmupDeps(["a", "b", "c"], {
    warm: async (id) => {
      if (id === "b") {
        reached = true;
        await loaded;
      }
      warmed.push(id);
    },
  }));
  try {
    warmup.start();
    await waitFor(
      () => Promise.resolve(reached),
      "the warm-up to reach the second workflow",
    );
    await warmup.dispose();
    assertEquals(warmed, ["a"]);
  } finally {
    release();
  }
  await loaded;
  // b's load ended on its own after the warm-up let go of it; c never ran.
  await waitFor(
    () => Promise.resolve(warmed.length === 2),
    "the released load to end",
  );
  assertEquals(warmed, ["a", "b"]);
});

Deno.test("RunIndexWarmup: never starts once disposed, and starts only once", async () => {
  let lists = 0;
  const deps = warmupDeps([], {
    listWorkflowIds: () => {
      lists++;
      return Promise.resolve(["a"]);
    },
  });
  const disposed = new RunIndexWarmup(deps);
  await disposed.dispose();
  disposed.start();
  await disposed.finished();
  assertEquals(lists, 0);

  const twice = new RunIndexWarmup(deps);
  twice.start();
  twice.start();
  await twice.finished();
  assertEquals(lists, 1);
});

Deno.test("RunIndexWarmup: stop passes its signal to the load in flight", async () => {
  let aborted = false;
  let reached = false;
  const warmup = new RunIndexWarmup(warmupDeps(["slow", "next"], {
    warm: (id, signal) => {
      if (id !== "slow") return Promise.resolve();
      reached = true;
      // A load that only ends when it is aborted, as a rebuild stops
      // between records.
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true })
      );
    },
  }));
  warmup.start();
  await waitFor(
    () => Promise.resolve(reached),
    "the warm-up to start the slow workflow",
  );
  await warmup.dispose();
  assertEquals(aborted, true);
});

Deno.test("RunIndexWarmup: finished does not wait for a load that ignores the signal", async () => {
  // A plain index read, a load a request started, or a repair queued behind
  // another reader: none of them watches the warm-up's signal
  // (swamp-club#3468).
  const warmed: string[] = [];
  const { promise: loaded, resolve: release } = Promise.withResolvers<void>();
  let reached = false;
  const warmup = new RunIndexWarmup(warmupDeps(["shared", "next"], {
    warm: (id) => {
      if (id === "shared") {
        reached = true;
        return loaded;
      }
      warmed.push(id);
      return Promise.resolve();
    },
  }));
  try {
    warmup.start();
    await waitFor(
      () => Promise.resolve(reached),
      "the warm-up to join the shared load",
    );
    warmup.stop();
    await warmup.finished();
    assertEquals(warmed, []);
  } finally {
    release();
  }
});

Deno.test("RunIndexWarmup: a load that fails after the warm-up let go of it is not reported", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    const { promise: loaded, reject: fail } = Promise.withResolvers<void>();
    let reached = false;
    const warmup = new RunIndexWarmup(warmupDeps(["slow"], {
      warm: () => {
        reached = true;
        return loaded;
      },
    }));
    warmup.start();
    await waitFor(
      () => Promise.resolve(reached),
      "the warm-up to start the slow workflow",
    );
    await warmup.dispose();
    // Rejects with nothing in the test awaiting it; one macrotask lets the
    // runtime report it if the warm-up left it unhandled.
    fail(new Error("unreadable"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(unhandled, []);
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

Deno.test("RunIndexWarmup: skips a workflow with more runs than the cache keeps", async () => {
  const warmed: string[] = [];
  const counts: Record<string, number> = { small: 10, huge: 11, last: 3 };
  const warmup = new RunIndexWarmup(warmupDeps(["small", "huge", "last"], {
    countRunRecords: (id) => Promise.resolve(counts[id]),
    warm: (id) => {
      warmed.push(id);
      return Promise.resolve();
    },
  }));
  warmup.start();
  await warmup.finished();
  assertEquals(warmed, ["small", "last"]);
});

Deno.test("RunIndexWarmup: a stop while counting a workflow's runs loads nothing", async () => {
  const { promise: counted, resolve: count } = Promise.withResolvers<number>();
  let reached = false;
  let warms = 0;
  const warmup = new RunIndexWarmup(warmupDeps(["a", "b"], {
    countRunRecords: () => {
      reached = true;
      return counted;
    },
    warm: () => {
      warms++;
      return Promise.resolve();
    },
  }));
  try {
    warmup.start();
    await waitFor(
      () => Promise.resolve(reached),
      "the warm-up to count the first workflow",
    );
    await warmup.dispose();
  } finally {
    count(1);
  }
  await counted;
  assertEquals(warms, 0);
});

Deno.test("RunIndexWarmup: a workflow whose runs cannot be counted is skipped", async () => {
  const warmed: string[] = [];
  const warmup = new RunIndexWarmup(warmupDeps(["broken", "b"], {
    countRunRecords: (id) =>
      id === "broken"
        ? Promise.reject(new Error("permission denied"))
        : Promise.resolve(1),
    warm: (id) => {
      warmed.push(id);
      return Promise.resolve();
    },
  }));
  warmup.start();
  await warmup.finished();
  assertEquals(warmed, ["b"]);
});
