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
 * Roots and units on a v3 repository context go through its commit-log
 * engine (swamp-club#3279), found by the context or by its hook alone; the
 * flush still runs once the root has ended.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import {
  bindCommitLogEngine,
  type CommitLogEngine,
  type CommitLogRootRunOptions,
  repoUnitOfWorkFactory,
  runInRootUnitOfWork,
} from "./repo_unit_of_work.ts";
import { createRepositoryContext } from "./repository_factory.ts";
import { unitOfWorkBinding } from "./unit_of_work_binding.ts";
import { createLegacyUnitOfWork } from "./legacy_unit_of_work.ts";

/** A commit-log engine that records what it was asked to do. */
function fakeEngine() {
  const calls: string[] = [];
  let open = 0;
  const engine: CommitLogEngine & { calls: string[] } = {
    calls,
    openUnit(): UnitOfWork {
      calls.push("openUnit");
      return createLegacyUnitOfWork(undefined, { flush: undefined });
    },
    hasOpenUnit: () => open > 0,
    checkpointOpenUnit: () => Promise.resolve("no-unit"),
    committedBeforeThrowing: () => false,
    async runRoot<T>(
      options: CommitLogRootRunOptions<T>,
      fn: (
        root: Parameters<CommitLogEngine["runRoot"]>[1] extends
          (root: infer R) => unknown ? R : never,
      ) => Promise<T>,
    ): Promise<T> {
      calls.push(`runRoot${options.reconcileRuns ? "+reconcile" : ""}`);
      open++;
      try {
        return await fn({
          stage: () => Promise.resolve(),
          staged: () => [],
          checkpoint: () => {
            calls.push("checkpoint");
            return Promise.resolve();
          },
        });
      } finally {
        open--;
        calls.push("ended");
      }
    },
  };
  return engine;
}

Deno.test("runInRootUnitOfWork: a v3 context's root goes through its engine, and the flush runs after it ends", async () => {
  const engine = fakeEngine();
  const outcomes: boolean[] = [];
  const value = await runInRootUnitOfWork({ commitLog: engine }, {
    flush: (outcome) => {
      engine.calls.push("flush");
      outcomes.push(outcome.completed);
      return Promise.resolve();
    },
    checkpoint: () => Promise.resolve(3),
    commitLog: { reconcileRuns: true },
  }, async (root) => {
    assertEquals(await root.checkpoint(), 3);
    return "done";
  });
  assertEquals(value, "done");
  assertEquals(engine.calls, [
    "runRoot+reconcile",
    "checkpoint",
    "ended",
    "flush",
  ]);
  assertEquals(outcomes, [true]);
});

Deno.test("runInRootUnitOfWork: a v3 root that throws still flushes, unless it pushes only on success", async () => {
  for (const pushWhen of ["always", "completed"] as const) {
    const engine = fakeEngine();
    const flushed: boolean[] = [];
    await assertRejects(
      () =>
        runInRootUnitOfWork({ commitLog: engine }, {
          flush: (outcome) => {
            flushed.push(outcome.completed);
            return Promise.resolve();
          },
          pushWhen,
        }, () => Promise.reject(new Error("failed"))),
      Error,
      "failed",
    );
    assertEquals(flushed, pushWhen === "always" ? [false] : []);
  }
});

Deno.test("runInRootUnitOfWork: a v3 root nested in another with its own push is refused", async () => {
  const engine = fakeEngine();
  await runInRootUnitOfWork(
    { commitLog: engine },
    { flush: undefined },
    async () => {
      await assertRejects(
        () =>
          runInRootUnitOfWork({ commitLog: engine }, {
            flush: () => Promise.resolve(),
          }, () => Promise.resolve()),
        Error,
        "opened inside another",
      );
    },
  );
});

Deno.test("runInRootUnitOfWork: a bare hook bound to an engine opens the engine's root", async () => {
  const engine = fakeEngine();
  const hook: MarkDirtyHook = () => Promise.resolve();
  bindCommitLogEngine(hook, engine);
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: undefined },
    () => Promise.resolve(),
  );
  assertEquals(engine.calls, ["runRoot+reconcile", "ended"]);
  repoUnitOfWorkFactory({ markDirty: hook })();
  assertEquals(engine.calls.at(-1), "openUnit");
});

Deno.test("createRepositoryContext: a v3 context gets a hook of its own, marked and bound to its engine", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-context-" });
  try {
    const engine = fakeEngine();
    let runRepoOf: (() => unknown) | undefined;
    const context = createRepositoryContext({
      repoDir: dir,
      commitLog: (_hook, runRepo) => {
        runRepoOf = runRepo;
        return engine;
      },
    });
    assert(context.markDirty !== undefined);
    assert(unitOfWorkBinding.requiresUnit(context.markDirty));
    assertEquals(context.commitLog, engine);
    assertEquals(runRepoOf!(), context.workflowRunRepo);
    // A second context never shares the hook.
    const other = createRepositoryContext({
      repoDir: dir,
      commitLog: () => fakeEngine(),
    });
    assert(other.markDirty !== context.markDirty);
    // A v2 context is unchanged: no hook of its own, no engine.
    const v2 = createRepositoryContext({ repoDir: dir });
    assertEquals(v2.markDirty, undefined);
    assertEquals(v2.commitLog, undefined);
    for (const c of [context, other, v2]) c.catalogStore.close();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
