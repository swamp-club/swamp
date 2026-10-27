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
  type PrunableToken,
  type PrunableWorker,
  workerPrune,
  type WorkerPruneDeps,
  type WorkerPruneEvent,
  type WorkerPruneResult,
} from "./prune.ts";
import { createLibSwampContext } from "../context.ts";
import type { ModelDeleteEvent } from "../models/delete.ts";
import type { ModelMethodRunEvent } from "../models/run.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  diagnosticPhases,
  findSpan,
  isChildOf,
  type ReadableSpan,
  withCapturedSpans,
  withObservedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeWorker(
  overrides: Partial<PrunableWorker> = {},
): PrunableWorker {
  return {
    name: "worker-pool-abc",
    definitionName: "worker-worker-pool-abc",
    status: "disconnected",
    tokenName: "pool",
    disconnectedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
    ...overrides,
  };
}

function makeToken(
  overrides: Partial<PrunableToken> = {},
): PrunableToken {
  return {
    name: "pool",
    bindings: [{ machineId: "machine-abc" }],
    ...overrides,
  };
}

function successDeleteStream(): AsyncIterable<ModelDeleteEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        kind: "completed" as const,
        data: {
          id: "id",
          name: "n",
          type: "swamp/worker",
          inputPath: "/p",
          resourceDeleted: false,
          outputsDeleted: 0,
          evaluatedInputDeleted: true,
          dataDeleted: true,
          expiredDataAutoCollected: 0,
        },
      };
    },
  };
}

function successPruneStream(): AsyncIterable<ModelMethodRunEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        kind: "completed" as const,
        run: {
          modelId: "id",
          modelName: "n",
          modelType: "swamp/enrollment-token",
          methodName: "prune_bindings",
          outputId: "id",
          status: "succeeded" as const,
          duration: 1,
          dataArtifacts: [],
          logFile: "/log",
        },
      };
    },
  };
}

function makeDeps(
  workers: PrunableWorker[] = [],
  tokens: PrunableToken[] = [],
  overrides: Partial<WorkerPruneDeps> = {},
): WorkerPruneDeps {
  return {
    listWorkers: () => Promise.resolve(workers),
    listTokens: () => Promise.resolve(tokens),
    deleteWorker: () => successDeleteStream(),
    pruneBindings: () => successPruneStream(),
    now: () => NOW,
    ...overrides,
  };
}

async function collectEvents(
  gen: AsyncGenerator<WorkerPruneEvent>,
): Promise<WorkerPruneEvent[]> {
  const events: WorkerPruneEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function findResult(
  events: WorkerPruneEvent[],
): WorkerPruneResult | undefined {
  const completed = events.find((e) => e.kind === "completed");
  return completed?.kind === "completed" ? completed.result : undefined;
}

Deno.test("workerPrune: no disconnected workers yields zero counts", async () => {
  const deps = makeDeps([
    makeWorker({ status: "idle" }),
  ]);
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 0);
  assertEquals(result?.workersFailed, 0);
});

Deno.test("workerPrune: all within grace period yields zero counts", async () => {
  const deps = makeDeps([
    makeWorker({ disconnectedAt: new Date(NOW - HOUR_MS).toISOString() }),
  ]);
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 0);
});

Deno.test("workerPrune: dry run does not delete", async () => {
  const deleted: string[] = [];
  const deps = makeDeps(
    [makeWorker()],
    [makeToken()],
    {
      deleteWorker: (name) => {
        deleted.push(name);
        return successDeleteStream();
      },
    },
  );
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: true }),
  );
  assertEquals(deleted.length, 0);
  const preview = events.find((e) => e.kind === "previewing");
  assertEquals(
    preview?.kind === "previewing" ? preview.workers.length : 0,
    1,
  );
});

Deno.test("workerPrune: deletes stale worker and prunes bindings", async () => {
  const deleted: string[] = [];
  const pruned: Array<{ token: string; ids: string[] }> = [];
  const deps = makeDeps(
    [makeWorker()],
    [makeToken()],
    {
      deleteWorker: (name) => {
        deleted.push(name);
        return successDeleteStream();
      },
      pruneBindings: (token, ids) => {
        pruned.push({ token, ids });
        return successPruneStream();
      },
      resolveStaleBindings: (token, _remaining) => {
        return Promise.resolve(token.bindings.map((b) => b.machineId));
      },
    },
  );
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 1);
  assertEquals(result?.bindingsPruned, 1);
  assertEquals(result?.tokensCleaned, 1);
  assertEquals(deleted, ["worker-worker-pool-abc"]);
  assertEquals(pruned, [{ token: "pool", ids: ["machine-abc"] }]);
});

Deno.test("workerPrune: partial delete failure continues to next worker", async () => {
  let callCount = 0;
  const deps = makeDeps(
    [
      makeWorker({ name: "w1", definitionName: "worker-w1" }),
      makeWorker({ name: "w2", definitionName: "worker-w2" }),
    ],
    [],
    {
      deleteWorker: () => {
        callCount++;
        if (callCount === 1) {
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                kind: "error" as const,
                error: { code: "test_fail", message: "boom" },
              };
            },
          };
        }
        return successDeleteStream();
      },
    },
  );
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 1);
  assertEquals(result?.workersFailed, 1);
  assertEquals(
    events.some((e) => e.kind === "worker_delete_failed"),
    true,
  );
});

Deno.test("workerPrune: mixed prunable and non-prunable workers", async () => {
  const deleted: string[] = [];
  const deps = makeDeps(
    [
      makeWorker({
        name: "stale",
        definitionName: "worker-stale",
      }),
      makeWorker({
        name: "recent",
        definitionName: "worker-recent",
        status: "disconnected",
        disconnectedAt: new Date(NOW - HOUR_MS).toISOString(),
      }),
      makeWorker({
        name: "idle",
        definitionName: "worker-idle",
        status: "idle",
      }),
    ],
    [],
    {
      deleteWorker: (name) => {
        deleted.push(name);
        return successDeleteStream();
      },
    },
  );
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 1);
  assertEquals(deleted, ["worker-stale"]);
});

Deno.test("workerPrune: skips binding prune when resolveStaleBindings is not provided", async () => {
  const pruned: string[] = [];
  const deps = makeDeps(
    [makeWorker()],
    [makeToken()],
    {
      pruneBindings: (token) => {
        pruned.push(token);
        return successPruneStream();
      },
      // no resolveStaleBindings → bindings skipped
    },
  );
  const ctx = createLibSwampContext();
  const events = await collectEvents(
    workerPrune(ctx, deps, { gracePeriodMs: DAY_MS, dryRun: false }),
  );
  const result = findResult(events);
  assertEquals(result?.workersDeleted, 1);
  assertEquals(result?.bindingsPruned, 0);
  assertEquals(pruned.length, 0);
});

// ── Diagnostic phases (swamp-club#4003) ─────────────────────────────

/** A delete stream under its own swamp.model.delete span, as modelDelete has. */
function spannedDeleteStream(): AsyncIterable<ModelDeleteEvent> {
  return withGeneratorSpan(
    "swamp.model.delete",
    {},
    (async function* () {
      yield* successDeleteStream();
    })(),
  );
}

function phase(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  return findSpan(spans, `swamp.diagnostic.${name}`);
}

function attr(span: ReadableSpan, key: string): unknown {
  return span.attributes[`swamp.diagnostic.${key}`];
}

const STAGE_FIXTURE = [
  makeWorker({ name: "pool-a", definitionName: "worker-pool-a" }),
  makeWorker({ name: "pool-b", definitionName: "worker-pool-b" }),
  makeWorker({ name: "pool-c", status: "idle" }),
  makeWorker({
    name: "pool-d",
    disconnectedAt: new Date(NOW - HOUR_MS).toISOString(),
  }),
  makeWorker({ name: "pool-e", disconnectedAt: undefined }),
];

Deno.test("workerPrune: exports each stage as a worker_delete phase with its counts", async () => {
  await withObservedSpans(async (spans) => {
    const deps = makeDeps(STAGE_FIXTURE, [makeToken()], {
      deleteWorker: () => spannedDeleteStream(),
      resolveStaleBindings: () => Promise.resolve(["machine-abc"]),
    });
    await collectEvents(
      workerPrune(createLibSwampContext(), deps, {
        gracePeriodMs: DAY_MS,
        dryRun: false,
      }),
    );

    const prune = findSpan(spans, "swamp.worker.prune");
    const pass = phase(spans, "prune_pass");
    assert(isChildOf(pass, prune));
    for (const stage of ["worker_listing", "eligibility", "delete_loop"]) {
      assert(isChildOf(phase(spans, stage), pass), stage);
    }
    const cleanup = phase(spans, "binding_cleanup");
    assert(isChildOf(cleanup, pass));
    for (
      const span of spans.filter((s) => s.name.startsWith("swamp.diagnostic."))
    ) {
      assertEquals(span.attributes["swamp.diagnostic.area"], "worker_delete");
      assertEquals(span.attributes["swamp.outcome"], "ok");
    }

    assertEquals(attr(phase(spans, "worker_listing"), "workers"), 5);
    const eligibility = phase(spans, "eligibility");
    assertEquals(attr(eligibility, "considered"), 5);
    assertEquals(attr(eligibility, "eligible"), 2);
    assertEquals(attr(eligibility, "skipped_not_disconnected"), 1);
    assertEquals(attr(eligibility, "skipped_within_grace"), 1);
    assertEquals(attr(eligibility, "skipped_no_disconnect_time"), 1);

    const loop = phase(spans, "delete_loop");
    assertEquals(attr(loop, "sequential"), true);
    assertEquals(attr(loop, "batch_size"), 2);
    assertEquals(attr(loop, "attempted"), 2);
    assertEquals(attr(loop, "deleted"), 2);
    assertEquals(attr(loop, "failed"), undefined);
    assertEquals(attr(loop, "result"), "completed");
    const deletes = spans.filter((s) => s.name === "swamp.model.delete");
    assertEquals(deletes.length, 2);
    for (const del of deletes) assert(isChildOf(del, loop));

    // Cleanup is the loop's sibling, not part of it, and ended after it.
    assert(!isChildOf(cleanup, loop));
    assert(spans.indexOf(loop) < spans.indexOf(cleanup));
    assertEquals(attr(cleanup, "affected_tokens"), 1);
    assertEquals(attr(cleanup, "tokens_checked"), 1);
    assertEquals(attr(cleanup, "bindings_pruned"), 1);
    assertEquals(attr(cleanup, "tokens_cleaned"), 1);
    assertEquals(attr(cleanup, "result"), "completed");
    for (
      const work of [
        "token_list",
        "worker_relist",
        "stale_resolve",
        "binding_prune",
      ]
    ) {
      assertEquals(typeof attr(cleanup, `${work}_work_ms`), "number", work);
    }

    assertEquals(attr(pass, "workers_deleted"), 2);
    assertEquals(attr(pass, "workers_failed"), 0);
    assertEquals(attr(pass, "bindings_pruned"), 1);
    assertEquals(attr(pass, "result"), "completed");
  });
});

Deno.test("workerPrune: a failed worker delete leaves the loop and pass partial", async () => {
  await withObservedSpans(async (spans) => {
    let call = 0;
    const deps = makeDeps(STAGE_FIXTURE, [], {
      deleteWorker: () => {
        call++;
        if (call === 1) {
          return (async function* (): AsyncGenerator<ModelDeleteEvent> {
            yield {
              kind: "error",
              error: { code: "validation_failed", message: "referenced" },
            };
          })();
        }
        return successDeleteStream();
      },
    });
    await collectEvents(
      workerPrune(createLibSwampContext(), deps, {
        gracePeriodMs: DAY_MS,
        dryRun: false,
      }),
    );
    const loop = phase(spans, "delete_loop");
    assertEquals(attr(loop, "failed"), 1);
    assertEquals(attr(loop, "deleted"), 1);
    assertEquals(attr(loop, "result"), "partial");
    assertEquals(loop.attributes["swamp.outcome"], "ok");
    assertEquals(attr(phase(spans, "prune_pass"), "result"), "partial");
    // No resolver: cleanup is reported skipped, not silently absent.
    assertEquals(attr(phase(spans, "binding_cleanup"), "result"), "skipped");
  });
});

Deno.test("workerPrune: a consumer that stops mid-loop ends the open phases cancelled", async () => {
  await withObservedSpans(async (spans) => {
    const deps = makeDeps(STAGE_FIXTURE, [makeToken()]);
    for await (
      const event of workerPrune(createLibSwampContext(), deps, {
        gracePeriodMs: DAY_MS,
        dryRun: false,
      })
    ) {
      if (event.kind === "worker_deleted") break;
    }
    const loop = phase(spans, "delete_loop");
    assertEquals(loop.attributes["swamp.outcome"], "cancelled");
    assertEquals(attr(loop, "attempted"), 1);
    assertEquals(attr(loop, "deleted"), 1);
    assertEquals(
      phase(spans, "prune_pass").attributes["swamp.outcome"],
      "cancelled",
    );
    assertEquals(phase(spans, "eligibility").attributes["swamp.outcome"], "ok");
    assertEquals(diagnosticPhases(spans, "binding_cleanup").length, 0);
  });
});

Deno.test("workerPrune: a failed listing ends the listing and the pass as errors", async () => {
  await withObservedSpans(async (spans) => {
    const deps = makeDeps([], [], {
      listWorkers: () => Promise.reject(new Error("datastore down")),
    });
    const events = await collectEvents(
      workerPrune(createLibSwampContext(), deps, {
        gracePeriodMs: DAY_MS,
        dryRun: false,
      }),
    );
    assertEquals(events.map((e) => e.kind), ["error"]);
    assertEquals(
      phase(spans, "worker_listing").attributes["swamp.outcome"],
      "error",
    );
    assertEquals(
      phase(spans, "prune_pass").attributes["swamp.outcome"],
      "error",
    );
    assertEquals(diagnosticPhases(spans, "eligibility").length, 0);
  });
});

Deno.test("workerPrune: a dry run or an empty selection is reported, with no delete loop", async () => {
  await withObservedSpans(async (spans) => {
    const ctx = createLibSwampContext();
    await collectEvents(
      workerPrune(ctx, makeDeps(STAGE_FIXTURE), {
        gracePeriodMs: DAY_MS,
        dryRun: true,
      }),
    );
    await collectEvents(
      workerPrune(ctx, makeDeps([makeWorker({ status: "idle" })]), {
        gracePeriodMs: DAY_MS,
        dryRun: false,
      }),
    );
    const passes = diagnosticPhases(spans, "prune_pass");
    assertEquals(passes.map((p) => attr(p, "result")), [
      "skipped",
      "no_change",
    ]);
    assertEquals(diagnosticPhases(spans, "delete_loop").length, 0);
    assertEquals(diagnosticPhases(spans, "binding_cleanup").length, 0);
  });
});

Deno.test("workerPrune: binding cleanup is skipped when the worker list cannot be re-read", async () => {
  await withObservedSpans(async (spans) => {
    let listed = 0;
    const deps = makeDeps([], [makeToken()], {
      listWorkers: () => {
        listed++;
        return listed === 1
          ? Promise.resolve([makeWorker()])
          : Promise.reject(new Error("gone"));
      },
      resolveStaleBindings: () => Promise.resolve(["machine-abc"]),
    });
    await collectEvents(
      workerPrune(createLibSwampContext(), deps, {
        gracePeriodMs: DAY_MS,
        dryRun: false,
      }),
    );
    const cleanup = phase(spans, "binding_cleanup");
    assertEquals(attr(cleanup, "result"), "skipped");
    assertEquals(attr(cleanup, "bindings_pruned"), 0);
    assertEquals(cleanup.attributes["swamp.outcome"], "ok");
  });
});

Deno.test("workerPrune: phases record whether the caller's cancel was seen", async () => {
  await withObservedSpans(async (spans) => {
    const controller = new AbortController();
    const deps = makeDeps(STAGE_FIXTURE, [], {
      deleteWorker: () => {
        controller.abort();
        return successDeleteStream();
      },
    });
    await collectEvents(
      workerPrune(createLibSwampContext(), deps, {
        gracePeriodMs: DAY_MS,
        dryRun: false,
        signal: controller.signal,
      }),
    );
    assertEquals(attr(phase(spans, "eligibility"), "cancel_observed"), false);
    assertEquals(attr(phase(spans, "delete_loop"), "cancel_observed"), true);
    // Observed only: the prune still deleted every eligible worker.
    assertEquals(attr(phase(spans, "delete_loop"), "deleted"), 2);
  });
});

Deno.test("workerPrune: no phases are exported without the execution observer", async () => {
  await withCapturedSpans(async (spans) => {
    const events = await collectEvents(
      workerPrune(createLibSwampContext(), makeDeps(STAGE_FIXTURE), {
        gracePeriodMs: DAY_MS,
        dryRun: false,
      }),
    );
    assertEquals(findResult(events)?.workersDeleted, 2);
    findSpan(spans, "swamp.worker.prune");
    assertEquals(
      spans.filter((s) => s.name.startsWith("swamp.diagnostic.")).length,
      0,
    );
  });
});
