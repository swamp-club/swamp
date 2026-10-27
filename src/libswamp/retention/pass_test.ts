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
import {
  diagnosticPhases,
  findSpan,
  isChildOf,
  type ReadableSpan,
  withObservedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";
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

Deno.test("runRetentionPass: a kind whose collector skipped failed items is not complete", async () => {
  const watermarks = new MemoryWatermarks();
  const skipping: RetentionCollector = {
    kind: "data",
    collectBatch: () =>
      Promise.resolve({
        deleted: 2,
        bytesReclaimed: 0,
        more: false,
        incomplete: true,
      }),
  };
  const result = await runRetentionPass(deps([skipping], watermarks), {
    policy: RetentionPolicy.fromConfig({ data: "1d" }),
  });
  assertEquals(result.complete, false);
  assertEquals(watermarks.records.get("data")?.complete, false);
  assertEquals(watermarks.records.get("data")?.deleted, 2);
});

Deno.test("runRetentionPass: a pass stopped before a kind's first batch keeps that kind's watermark", async () => {
  const watermarks = new MemoryWatermarks();
  const previous = {
    kind: "workflowRuns" as const,
    cutoff: "2026-10-01T00:00:00.000Z",
    retention: "1d",
    lastPassAt: "2026-10-14T00:00:00.000Z",
    complete: true,
    deleted: 9,
    bytesReclaimed: 0,
  };
  await watermarks.put(previous);
  const result = await runRetentionPass(
    deps([countingCollector("workflowRuns", 3, [])], watermarks),
    {
      policy: RetentionPolicy.fromConfig({ retention: "1d" }),
      shouldBackOff: () => true,
    },
  );
  assertEquals(result.stoppedBy, "busy");
  assertEquals(watermarks.records.get("workflowRuns"), previous);
});

Deno.test("runRetentionPass: a pass stopped for shutdown skips afterPass", async () => {
  let ran = false;
  await runRetentionPass(
    {
      ...deps([countingCollector("data", 4, [])]),
      afterPass: () => {
        ran = true;
        return Promise.resolve();
      },
    },
    {
      policy: RetentionPolicy.fromConfig({ data: "1d" }),
      isStopping: () => true,
    },
  );
  assertEquals(ran, false);
});

Deno.test("runRetentionPass: a pass past its budget stops at a batch boundary and the next pass continues", async () => {
  // The clock moves a minute per batch; the budget is two and a half.
  let clockMs = NOW.getTime();
  const calls: string[] = [];
  const runs = countingCollector("workflowRuns", 10, calls);
  const outputs = countingCollector("outputs", 5, calls);
  const watermarks = new MemoryWatermarks();
  const previous: RetentionWatermark = {
    kind: "outputs",
    cutoff: "2026-10-01T00:00:00.000Z",
    retention: "1d",
    lastPassAt: "2026-10-01T00:00:00.000Z",
    complete: true,
    deleted: 7,
    bytesReclaimed: 70,
  };
  await watermarks.put(previous);
  const clockedDeps: RetentionPassDeps = {
    collectors: [runs, outputs],
    watermarks,
    runBatch: async (fn) => {
      clockMs += 60_000;
      return await fn();
    },
    now: () => new Date(clockMs),
  };
  const policy = RetentionPolicy.fromConfig({ retention: "1d" });

  const first = await runRetentionPass(clockedDeps, {
    policy,
    batchSize: 2,
    budgetMs: 150_000,
  });

  assertEquals(first.stoppedBy, "budget");
  assertEquals(first.complete, false);
  assertEquals(
    first.kinds.map((k) => [k.kind, k.deleted, k.complete]),
    [["workflowRuns", 6, false], ["outputs", 0, false]],
  );
  assertEquals(watermarks.records.get("workflowRuns")?.complete, false);
  assertEquals(watermarks.records.get("outputs"), previous);

  const second = await runRetentionPass(clockedDeps, {
    policy,
    batchSize: 2,
    budgetMs: 60 * 60_000,
  });

  assertEquals(second.complete, true);
  assertEquals(
    second.kinds.map((k) => [k.kind, k.deleted, k.complete]),
    [["workflowRuns", 4, true], ["outputs", 5, true]],
  );
});

/** The finished spans named `name`. */
function named(spans: readonly ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name);
}

Deno.test("runRetentionPass: an outputs batch exports retention_batch and batch_commit under swamp.retention.batch; other kinds none", async () => {
  await withObservedSpans(async (spans) => {
    await runRetentionPass(
      deps([
        countingCollector("workflowRuns", 1, []),
        countingCollector("outputs", 3, []),
      ]),
      {
        policy: RetentionPolicy.fromConfig({ retention: "1d" }),
        batchSize: 2,
      },
    );
    const batches = named(spans, "swamp.retention.batch");
    assertEquals(batches.length, 3);
    const runsBatch = batches[0];
    assertEquals(runsBatch.attributes["retention.kind"], "workflowRuns");
    assertEquals(runsBatch.attributes["retention.deleted"], 1);
    const phases = diagnosticPhases(spans, "retention_batch");
    assertEquals(phases.length, 2);
    assertEquals(
      phases.some((p) => isChildOf(p, runsBatch)),
      false,
      "only outputs batches carry phases",
    );
    for (const [i, phase] of phases.entries()) {
      const parent = batches[i + 1];
      assertEquals(parent.attributes["retention.kind"], "outputs");
      assert(isChildOf(phase, parent));
      assertEquals(
        phase.attributes["swamp.diagnostic.area"],
        "output_retention",
      );
      assertEquals(phase.attributes["swamp.diagnostic.batch_size"], 2);
      assertEquals(phase.attributes["swamp.outcome"], "ok");
      const commit = diagnosticPhases(spans, "batch_commit")[i];
      assert(isChildOf(commit, phase));
      assertEquals(commit.attributes["swamp.diagnostic.disposition"], "commit");
    }
    assertEquals(phases[0].attributes["swamp.diagnostic.deleted"], 2);
    assertEquals(phases[0].attributes["swamp.diagnostic.bytes_reclaimed"], 20);
    assertEquals(phases[0].attributes["swamp.diagnostic.more"], true);
    assertEquals(phases[1].attributes["swamp.diagnostic.more"], false);
    // retention.deleted keeps its meaning: what that batch removed.
    assertEquals(batches[1].attributes["retention.deleted"], 2);
    assertEquals(batches[1].attributes["retention.bytes_reclaimed"], 20);
    assertEquals(batches[1].attributes["retention.more"], true);
    assertEquals(batches[2].attributes["retention.deleted"], 1);
  });
});

Deno.test("runRetentionPass: a failed outputs batch ends retention_batch with its error, and the abandoned unit's commit stays ok", async () => {
  await withObservedSpans(async (spans) => {
    const failing: RetentionCollector = {
      kind: "outputs",
      collectBatch: () => Promise.reject(new Error("disk")),
    };
    const result = await runRetentionPass(deps([failing]), {
      policy: RetentionPolicy.fromConfig({ retention: "1d" }),
    });
    assertEquals(result.complete, false);
    const phase = findSpan(spans, "swamp.diagnostic.retention_batch");
    assertEquals(phase.attributes["swamp.outcome"], "error");
    const commit = findSpan(spans, "swamp.diagnostic.batch_commit");
    assertEquals(commit.attributes["swamp.diagnostic.disposition"], "abandon");
    assertEquals(commit.attributes["swamp.outcome"], "ok");
  });
});

Deno.test("runRetentionPass: a commit that fails after the collector ends batch_commit with the error", async () => {
  await withObservedSpans(async (spans) => {
    const failingCommit: RetentionPassDeps = {
      ...deps([countingCollector("outputs", 1, [])]),
      runBatch: async (fn) => {
        await fn();
        throw new Error("push failed");
      },
    };
    await runRetentionPass(failingCommit, {
      policy: RetentionPolicy.fromConfig({ retention: "1d" }),
    });
    const commit = findSpan(spans, "swamp.diagnostic.batch_commit");
    assertEquals(commit.attributes["swamp.diagnostic.disposition"], "commit");
    assertEquals(commit.attributes["swamp.outcome"], "error");
    assertEquals(
      findSpan(spans, "swamp.diagnostic.retention_batch").attributes[
        "swamp.outcome"
      ],
      "error",
    );
  });
});

Deno.test("runRetentionPass: a pass stopped before its outputs batch exports no partial phase", async () => {
  await withObservedSpans(async (spans) => {
    await runRetentionPass(deps([countingCollector("outputs", 1, [])]), {
      policy: RetentionPolicy.fromConfig({ retention: "1d" }),
      isStopping: () => true,
    });
    assertEquals(diagnosticPhases(spans, "retention_batch").length, 0);
  });
});

Deno.test("runRetentionPass: with tracing off an outputs batch runs unchanged", async () => {
  const result = await runRetentionPass(
    deps([countingCollector("outputs", 3, [])]),
    { policy: RetentionPolicy.fromConfig({ retention: "1d" }), batchSize: 2 },
  );
  assertEquals(result.kinds[0].deleted, 3);
  assertEquals(result.complete, true);
});

Deno.test("runRetentionPass: a runBatch that retries after a failed collect ends each batch_commit with its own disposition, before the retry starts", async () => {
  await withObservedSpans(async (spans) => {
    let calls = 0;
    let commitsEndedBeforeRetry: number | undefined;
    const flaky: RetentionCollector = {
      kind: "outputs",
      collectBatch: () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("transient"));
        commitsEndedBeforeRetry =
          diagnosticPhases(spans, "batch_commit").length;
        return Promise.resolve({ deleted: 1, bytesReclaimed: 10, more: false });
      },
    };
    const retrying: RetentionPassDeps = {
      ...deps([flaky]),
      runBatch: async (fn) => {
        try {
          return await fn();
        } catch {
          return await fn();
        }
      },
    };
    const result = await runRetentionPass(retrying, {
      policy: RetentionPolicy.fromConfig({ retention: "1d" }),
    });
    assertEquals(result.kinds[0].deleted, 1);
    const commits = diagnosticPhases(spans, "batch_commit");
    assertEquals(
      commits.map((c) => c.attributes["swamp.diagnostic.disposition"]),
      ["abandon", "commit"],
    );
    assertEquals(
      commits.map((c) => c.attributes["swamp.outcome"]),
      ["ok", "ok"],
    );
    assertEquals(commitsEndedBeforeRetry, 1);
  });
});
