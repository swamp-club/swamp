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
import {
  type RetentionCollector,
  type RetentionPassDeps,
  runRetentionPass,
} from "./pass.ts";
import {
  type RetentionKind,
  RetentionPolicy,
} from "../../domain/retention/retention_policy.ts";
import type {
  RetentionWatermark,
  RetentionWatermarkRepository,
} from "../../domain/retention/retention_watermark.ts";

const NOW = new Date("2026-10-15T12:00:00.000Z");

class MemoryWatermarks implements RetentionWatermarkRepository {
  readonly records = new Map<RetentionKind, RetentionWatermark>();
  get(kind: RetentionKind) {
    return Promise.resolve(this.records.get(kind) ?? null);
  }
  getAll() {
    return Promise.resolve([...this.records.values()]);
  }
  put(watermark: RetentionWatermark) {
    this.records.set(watermark.kind, watermark);
    return Promise.resolve();
  }
  claimHourlyPass() {
    return Promise.resolve(true);
  }
}

/** A collector over `count` items, all older than any cutoff. */
function countingCollector(
  kind: RetentionKind,
  count: number,
  calls: string[],
): RetentionCollector {
  let remaining = count;
  return {
    kind,
    collectBatch(cutoff, limit) {
      calls.push(`${kind}@${cutoff.toISOString()}`);
      const deleted = Math.min(limit, remaining);
      remaining -= deleted;
      return Promise.resolve({
        deleted,
        bytesReclaimed: deleted * 10,
        more: remaining > 0,
      });
    },
  };
}

function deps(
  collectors: RetentionCollector[],
  watermarks = new MemoryWatermarks(),
  batches: number[] = [],
): RetentionPassDeps {
  return {
    collectors,
    watermarks,
    runBatch: async (fn) => {
      batches.push(batches.length);
      return await fn();
    },
    now: () => NOW,
  };
}

Deno.test("runRetentionPass: drains each kind in batches, in collector order", async () => {
  const calls: string[] = [];
  const batches: number[] = [];
  const watermarks = new MemoryWatermarks();
  const result = await runRetentionPass(
    deps(
      [
        countingCollector("workflowRuns", 5, calls),
        countingCollector("data", 1, calls),
      ],
      watermarks,
      batches,
    ),
    {
      policy: RetentionPolicy.fromConfig({ retention: "1d", data: "2d" }),
      batchSize: 2,
    },
  );

  assertEquals(result.complete, true);
  assertEquals(
    result.kinds.map((k) => [k.kind, k.deleted, k.cutoff, k.complete]),
    [
      ["workflowRuns", 5, "2026-10-14T12:00:00.000Z", true],
      ["data", 1, "2026-10-13T12:00:00.000Z", true],
    ],
  );
  assertEquals(calls.length, 4);
  assertEquals(batches.length, 4);
  assertEquals(watermarks.records.get("workflowRuns")?.deleted, 5);
  assertEquals(watermarks.records.get("data")?.retention, "2d");
  assertEquals(
    watermarks.records.get("data")?.lastPassAt,
    NOW.toISOString(),
  );
});

Deno.test("runRetentionPass: a kind with no retention is left alone", async () => {
  const calls: string[] = [];
  const watermarks = new MemoryWatermarks();
  const result = await runRetentionPass(
    deps([
      countingCollector("workflowRuns", 3, calls),
      countingCollector("audit", 3, calls),
    ], watermarks),
    { policy: RetentionPolicy.fromConfig({ workflowRuns: "7d" }) },
  );
  assertEquals(result.kinds.map((k) => k.kind), ["workflowRuns"]);
  assertEquals(calls.every((c) => c.startsWith("workflowRuns")), true);
  assertEquals(watermarks.records.has("audit"), false);
});

Deno.test("runRetentionPass: stops at a batch boundary when stopping, leaving the started kind incomplete and unreached kinds untouched", async () => {
  const calls: string[] = [];
  let stopping = false;
  const watermarks = new MemoryWatermarks();
  const collector = countingCollector("outputs", 10, calls);
  const stopAfterFirst: RetentionCollector = {
    kind: "outputs",
    async collectBatch(cutoff, limit) {
      const batch = await collector.collectBatch(cutoff, limit);
      stopping = true;
      return batch;
    },
  };
  const result = await runRetentionPass(
    deps([stopAfterFirst, countingCollector("data", 1, calls)], watermarks),
    {
      policy: RetentionPolicy.fromConfig({ retention: "1d" }),
      batchSize: 3,
      isStopping: () => stopping,
    },
  );
  assertEquals(result.complete, false);
  assertEquals(result.stoppedBy, "stopping");
  assertEquals(calls.length, 1);
  assertEquals(watermarks.records.get("outputs")?.complete, false);
  assertEquals(watermarks.records.get("outputs")?.deleted, 3);
  // A kind the pass never reached keeps its previous watermark (none here).
  assertEquals(watermarks.records.has("data"), false);
});

Deno.test("runRetentionPass: backs off when busy before the first batch", async () => {
  const calls: string[] = [];
  const result = await runRetentionPass(
    deps([countingCollector("workflowRuns", 3, calls)]),
    {
      policy: RetentionPolicy.fromConfig({ retention: "1d" }),
      shouldBackOff: () => true,
    },
  );
  assertEquals(result.stoppedBy, "busy");
  assertEquals(calls, []);
});

Deno.test("runRetentionPass: a failing collector does not stop the other kinds", async () => {
  const calls: string[] = [];
  const watermarks = new MemoryWatermarks();
  const failing: RetentionCollector = {
    kind: "workflowRuns",
    collectBatch: () => Promise.reject(new Error("disk on fire")),
  };
  const result = await runRetentionPass(
    deps([failing, countingCollector("outputs", 2, calls)], watermarks),
    { policy: RetentionPolicy.fromConfig({ retention: "1d" }) },
  );
  assertEquals(result.complete, false);
  assertEquals(watermarks.records.get("workflowRuns")?.complete, false);
  assertEquals(watermarks.records.get("outputs")?.complete, true);
});

Deno.test("runRetentionPass: runs afterPass with the result", async () => {
  const calls: string[] = [];
  let seen: number | undefined;
  const result = await runRetentionPass(
    {
      ...deps([countingCollector("data", 4, calls)]),
      afterPass: (r) => {
        seen = r.kinds[0].deleted;
        return Promise.resolve();
      },
    },
    { policy: RetentionPolicy.fromConfig({ data: "1d" }) },
  );
  assertEquals(result.complete, true);
  assertEquals(seen, 4);
});
