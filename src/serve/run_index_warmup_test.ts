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
import { RunIndexWarmup } from "./run_index_warmup.ts";

await initializeLogging({});

Deno.test("RunIndexWarmup: reads every workflow's snapshot in the background, one at a time", async () => {
  const warmed: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const warmup = new RunIndexWarmup({
    listWorkflowIds: () => Promise.resolve(["a", "b", "c"]),
    warm: async (id) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      warmed.push(id);
      inFlight--;
    },
  });
  warmup.start();
  await warmup.finished();
  assertEquals(warmed, ["a", "b", "c"]);
  assertEquals(maxInFlight, 1);
});

Deno.test("RunIndexWarmup: a workflow that fails to load does not stop the rest", async () => {
  const warmed: string[] = [];
  const warmup = new RunIndexWarmup({
    listWorkflowIds: () => Promise.resolve(["a", "broken", "c"]),
    warm: (id) => {
      if (id === "broken") return Promise.reject(new Error("unreadable"));
      warmed.push(id);
      return Promise.resolve();
    },
  });
  warmup.start();
  await warmup.finished();
  assertEquals(warmed, ["a", "c"]);
});

Deno.test("RunIndexWarmup: a listing that fails ends the warm-up without throwing", async () => {
  let warms = 0;
  const warmup = new RunIndexWarmup({
    listWorkflowIds: () => Promise.reject(new Error("no workflows dir")),
    warm: () => {
      warms++;
      return Promise.resolve();
    },
  });
  warmup.start();
  await warmup.finished();
  assertEquals(warms, 0);
});

Deno.test("RunIndexWarmup: dispose stops after the workflow in flight and waits for it", async () => {
  const warmed: string[] = [];
  let release!: () => void;
  const warmup = new RunIndexWarmup({
    listWorkflowIds: () => Promise.resolve(["a", "b", "c"]),
    warm: async (id) => {
      if (id === "b") {
        await new Promise<void>((resolve) => release = resolve);
      }
      warmed.push(id);
    },
  });
  warmup.start();
  await waitFor(
    () => Promise.resolve(release !== undefined),
    "the warm-up to reach the second workflow",
  );
  const disposing = warmup.dispose();
  release();
  await disposing;
  assertEquals(warmed, ["a", "b"]);
});

Deno.test("RunIndexWarmup: never starts once disposed, and starts only once", async () => {
  let lists = 0;
  const deps = {
    listWorkflowIds: () => {
      lists++;
      return Promise.resolve(["a"]);
    },
    warm: () => Promise.resolve(),
  };
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

Deno.test("RunIndexWarmup: stop aborts the load in flight through its signal, and finished waits for it to end", async () => {
  const warmed: string[] = [];
  let reached = false;
  const warmup = new RunIndexWarmup({
    listWorkflowIds: () => Promise.resolve(["slow", "next"]),
    warm: (id, signal) => {
      if (id !== "slow") {
        warmed.push(id);
        return Promise.resolve();
      }
      reached = true;
      // A load that only ends when it is aborted, as a rebuild stops
      // between records.
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      );
    },
  });
  warmup.start();
  await waitFor(
    () => Promise.resolve(reached),
    "the warm-up to start the slow workflow",
  );
  warmup.stop();
  await warmup.finished();
  assertEquals(warmed, []);
});
