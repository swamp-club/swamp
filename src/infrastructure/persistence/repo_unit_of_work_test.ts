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

import { configure, type LogRecord, reset } from "@logtape/logtape";
import {
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";
import {
  createLegacyUnitOfWork,
  legacyUnitOfWorkParent,
  legacyUnitOfWorkTarget,
} from "./legacy_unit_of_work.ts";
import {
  type BoundUnitOfWorkOptions,
  openRepoUnitOfWork,
  repoUnitOfWorkFactory,
  type RootUnitOfWork,
  runInRootUnitOfWork,
  useUnitOfWorkFactoryForTesting,
} from "./repo_unit_of_work.ts";
import {
  currentUnitOfWork,
  runInUnitOfWork,
  signalChange,
} from "./unit_of_work_scope.ts";

function recordingHook(): {
  hook: MarkDirtyHook;
  calls: (string | undefined)[];
} {
  const calls: (string | undefined)[] = [];
  return {
    hook: (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    },
    calls,
  };
}

Deno.test("repoUnitOfWorkFactory: binds each unit to the repository context's exact hook", () => {
  const { hook } = recordingHook();
  const open = repoUnitOfWorkFactory({ markDirty: hook });
  const first = open();
  const second = open();
  assertNotStrictEquals(first, second);
  assertStrictEquals(legacyUnitOfWorkTarget(first), hook);
  assertStrictEquals(legacyUnitOfWorkTarget(second), hook);
});

Deno.test("repoUnitOfWorkFactory: with no hook the unit is unbound", () => {
  const uow = repoUnitOfWorkFactory({ markDirty: undefined })();
  assertStrictEquals(legacyUnitOfWorkTarget(uow), undefined);
});

Deno.test("openRepoUnitOfWork: forwards a change staged after commit instead of rejecting", async () => {
  const { hook, calls } = recordingHook();
  const uow = openRepoUnitOfWork(hook);
  await uow.commit();
  await uow.stage({ kind: "write", path: "/cache/data/late" });
  assertEquals(calls, ["/cache/data/late"]);
});

Deno.test("useUnitOfWorkFactoryForTesting: receives the bound hook until disposed", () => {
  const { hook } = recordingHook();
  const seen: (MarkDirtyHook | undefined)[] = [];
  const dispose = useUnitOfWorkFactoryForTesting((markDirty, options) => {
    seen.push(markDirty);
    return createLegacyUnitOfWork(markDirty, options);
  });
  try {
    const uow = repoUnitOfWorkFactory({ markDirty: hook })();
    assertStrictEquals(legacyUnitOfWorkTarget(uow), hook);
  } finally {
    dispose();
  }
  repoUnitOfWorkFactory({ markDirty: hook })();
  assertEquals(seen.length, 1);
  assertStrictEquals(seen[0], hook);
});

Deno.test("useUnitOfWorkFactoryForTesting: refuses a second install while one is active", () => {
  const factory = (markDirty: MarkDirtyHook | undefined) =>
    createLegacyUnitOfWork(markDirty, { flush: undefined });
  const dispose = useUnitOfWorkFactoryForTesting(factory);
  try {
    assertThrows(
      () => useUnitOfWorkFactoryForTesting(factory),
      Error,
      "already installed",
    );
  } finally {
    dispose();
  }
  useUnitOfWorkFactoryForTesting(factory)();
});

/** A flush that counts its calls and can be made to reject. */
function countingFlush(error?: Error): {
  flush: () => Promise<void>;
  calls: () => number;
} {
  let calls = 0;
  return {
    flush: () => {
      calls++;
      return error === undefined ? Promise.resolve() : Promise.reject(error);
    },
    calls: () => calls,
  };
}

Deno.test("openRepoUnitOfWork: inside a unit bound to the same hook it opens a child", async () => {
  const { hook } = recordingHook();
  const outer = openRepoUnitOfWork(hook);
  const inner = await runInUnitOfWork(
    outer,
    () => Promise.resolve(openRepoUnitOfWork(hook)),
  );
  assertStrictEquals(legacyUnitOfWorkParent(inner), outer);
  assertStrictEquals(legacyUnitOfWorkParent(outer), undefined);
});

Deno.test("openRepoUnitOfWork: inside a unit for a different hook it opens an independent root", async () => {
  const { hook } = recordingHook();
  const other = recordingHook();
  const outer = openRepoUnitOfWork(other.hook);
  const inner = await runInUnitOfWork(
    outer,
    () => Promise.resolve(openRepoUnitOfWork(hook)),
  );
  assertStrictEquals(legacyUnitOfWorkParent(inner), undefined);
  await inner.stage({ kind: "write", path: "/cache/data/a" });
  assertEquals(outer.staged(), []);
  assertEquals(other.calls, []);
});

Deno.test("runInRootUnitOfWork: a use case's unit inside the root is a child that rolls up and never flushes", async () => {
  const { hook, calls } = recordingHook();
  const push = countingFlush();
  let child: UnitOfWork | undefined;
  let rootSeen: RootUnitOfWork | undefined;
  let rootUnit: UnitOfWork | undefined;
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: push.flush },
    async (root) => {
      rootSeen = root;
      // fn gets a view of the root; the ambient unit is the root itself.
      rootUnit = currentUnitOfWork();
      child = openRepoUnitOfWork(hook);
      await child.stage({ kind: "write", path: "/cache/data/a" });
      await child.commit();
      const abandoned = openRepoUnitOfWork(hook);
      await abandoned.stage({ kind: "remove", path: "/cache/data/b" });
      await abandoned.abandon();
      assertEquals(push.calls(), 0);
    },
  );
  assertStrictEquals(legacyUnitOfWorkParent(child!), rootUnit);
  assertEquals(calls, ["/cache/data/a", "/cache/data/b"]);
  assertEquals(rootSeen!.staged(), [
    { kind: "write", path: "/cache/data/a" },
    { kind: "remove", path: "/cache/data/b" },
  ]);
  assertEquals(push.calls(), 1);
});

Deno.test("runInRootUnitOfWork: nested use-case units roll up through each other to the root", async () => {
  const { hook } = recordingHook();
  let rootSeen: RootUnitOfWork | undefined;
  let outer: UnitOfWork | undefined;
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: undefined },
    async (root) => {
      rootSeen = root;
      outer = openRepoUnitOfWork(hook);
      await runInUnitOfWork(outer, async () => {
        const inner = openRepoUnitOfWork(hook);
        assertStrictEquals(legacyUnitOfWorkParent(inner), outer);
        await inner.stage({ kind: "bulk", reason: "nested" });
        await inner.commit();
      });
      await outer.commit();
    },
  );
  assertEquals(outer!.staged(), [{ kind: "bulk", reason: "nested" }]);
  assertEquals(rootSeen!.staged(), [{ kind: "bulk", reason: "nested" }]);
});

Deno.test("runInRootUnitOfWork: hand marks staged through the root are the identical hook calls", async () => {
  const direct = recordingHook();
  await direct.hook("data/a");
  await direct.hook("data/b");
  await direct.hook(undefined);

  const { hook, calls } = recordingHook();
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: undefined },
    async (root) => {
      await root.stage({ kind: "write", path: "data/a" });
      await root.stage({ kind: "remove", path: "data/b" });
      await root.stage({ kind: "bulk", reason: "datastore sync" });
    },
  );
  assertEquals(calls, direct.calls);
});

Deno.test("runInRootUnitOfWork: two concurrent roots stay separate", async () => {
  const { hook } = recordingHook();
  const roots: RootUnitOfWork[] = [];
  const run = (path: string) =>
    runInRootUnitOfWork(
      { markDirty: hook },
      { flush: undefined },
      async (root) => {
        roots.push(root);
        const rootUnit = currentUnitOfWork();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const child = openRepoUnitOfWork(hook);
        assertStrictEquals(legacyUnitOfWorkParent(child), rootUnit);
        await child.stage({ kind: "write", path });
        await child.commit();
      },
    );
  await Promise.all([run("/cache/data/a"), run("/cache/data/b")]);
  assertNotStrictEquals(roots[0], roots[1]);
  assertEquals(
    roots.map((root) => root.staged()).sort((x, y) =>
      JSON.stringify(x).localeCompare(JSON.stringify(y))
    ),
    [
      [{ kind: "write", path: "/cache/data/a" }],
      [{ kind: "write", path: "/cache/data/b" }],
    ],
  );
});

Deno.test("runInRootUnitOfWork: flushes once and returns fn's value on success", async () => {
  const { hook } = recordingHook();
  const push = countingFlush();
  const value = await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: push.flush },
    () => Promise.resolve(42),
  );
  assertEquals(value, 42);
  assertEquals(push.calls(), 1);
});

Deno.test("runInRootUnitOfWork: flushes once when fn throws, and rethrows fn's error", async () => {
  const { hook } = recordingHook();
  const push = countingFlush();
  const error = new Error("command failed");
  const rejected = await assertRejects(() =>
    runInRootUnitOfWork(
      { markDirty: hook },
      { flush: push.flush },
      () => Promise.reject(error),
    )
  );
  assertStrictEquals(rejected, error);
  assertEquals(push.calls(), 1);
});

Deno.test("runInRootUnitOfWork: when fn and the flush both throw, fn's error wins and onFlushError gets the flush error", async () => {
  const { hook } = recordingHook();
  const flushError = new Error("push failed");
  const push = countingFlush(flushError);
  const error = new Error("command failed");
  const reported: unknown[] = [];
  const rejected = await assertRejects(() =>
    runInRootUnitOfWork(
      { markDirty: hook },
      { flush: push.flush, onFlushError: (e) => reported.push(e) },
      () => Promise.reject(error),
    )
  );
  assertStrictEquals(rejected, error);
  assertEquals(reported.length, 1);
  assertStrictEquals(reported[0], flushError);
  assertEquals(push.calls(), 1);
});

Deno.test("runInRootUnitOfWork: when fn and the flush both throw without onFlushError, the flush error is logged at warn", async () => {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["datastore", "unit-of-work"],
        lowestLevel: "debug",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    const { hook } = recordingHook();
    const push = countingFlush(new Error("push failed"));
    const error = new Error("command failed");
    const rejected = await assertRejects(() =>
      runInRootUnitOfWork(
        { markDirty: hook },
        { flush: push.flush },
        () => Promise.reject(error),
      )
    );
    assertStrictEquals(rejected, error);
  } finally {
    await reset();
  }
  assertEquals(records.length, 1);
  assertEquals(records[0].level, "warning");
});

Deno.test("runInRootUnitOfWork: when fn resolves and the flush throws, the flush error is thrown", async () => {
  const { hook } = recordingHook();
  const flushError = new Error("push failed");
  const push = countingFlush(flushError);
  const rejected = await assertRejects(() =>
    runInRootUnitOfWork(
      { markDirty: hook },
      { flush: push.flush },
      () => Promise.resolve(),
    )
  );
  assertStrictEquals(rejected, flushError);
  assertEquals(push.calls(), 1);
});

Deno.test("runInRootUnitOfWork: with no hook the root is unbound and still flushes once", async () => {
  const push = countingFlush();
  await runInRootUnitOfWork(
    { markDirty: undefined },
    { flush: push.flush },
    async (root) => {
      assertStrictEquals(
        legacyUnitOfWorkTarget(currentUnitOfWork()!),
        undefined,
      );
      await root.stage({ kind: "bulk", reason: "filesystem" });
    },
  );
  assertEquals(push.calls(), 1);
});

Deno.test("runInRootUnitOfWork: a nested root given its own push throws instead of dropping it", async () => {
  const { hook } = recordingHook();
  const outerPush = countingFlush();
  const innerPush = countingFlush();
  let ran = false;
  const rejected = await assertRejects(() =>
    runInRootUnitOfWork(
      { markDirty: hook },
      { flush: outerPush.flush },
      () =>
        runInRootUnitOfWork(
          { markDirty: hook },
          { flush: innerPush.flush },
          () => {
            ran = true;
            return Promise.resolve();
          },
        ),
    )
  );
  assertStringIncludes(
    (rejected as Error).message,
    "a root unit of work was opened inside another for the same hook with its own push",
  );
  assertEquals(ran, false);
  assertEquals(innerPush.calls(), 0);
  assertEquals(outerPush.calls(), 1);
});

Deno.test("runInRootUnitOfWork: a nested root without a push becomes a child that never pushes", async () => {
  const { hook } = recordingHook();
  const outerPush = countingFlush();
  let outerRoot: RootUnitOfWork | undefined;
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: outerPush.flush },
    async (root) => {
      outerRoot = root;
      const rootUnit = currentUnitOfWork();
      await runInRootUnitOfWork(
        { markDirty: hook },
        { flush: undefined },
        async (inner) => {
          assertStrictEquals(
            legacyUnitOfWorkParent(currentUnitOfWork()!),
            rootUnit,
          );
          await inner.stage({ kind: "write", path: "/cache/data/a" });
          assertEquals(outerPush.calls(), 0);
        },
      );
      assertEquals(outerPush.calls(), 0);
    },
  );
  assertEquals(outerPush.calls(), 1);
  assertEquals(outerRoot!.staged(), [{ kind: "write", path: "/cache/data/a" }]);
});

Deno.test("runInRootUnitOfWork: a root without a push sends the same hook calls, at the same points, as no root (swamp-club#3056)", async () => {
  const changes: StagedChange[] = [
    { kind: "write", path: "/cache/data/a" },
    { kind: "remove", path: "/cache/data/b" },
    { kind: "bulk", reason: "probe" },
    { kind: "write", path: "/cache/data/a" },
  ];
  // Each entry is the hook calls seen once the change's signal returned, so
  // a root that batched or deferred a mark would differ.
  const run = async (inRoot: boolean) => {
    const { hook, calls } = recordingHook();
    const seen: (string | undefined)[][] = [];
    const body = async () => {
      for (const change of changes) {
        await signalChange(hook, change);
        seen.push([...calls]);
      }
    };
    if (inRoot) {
      await runInRootUnitOfWork(
        { markDirty: hook },
        { flush: undefined },
        body,
      );
    } else {
      await body();
    }
    return { seen, calls };
  };
  const bare = await run(false);
  const rooted = await run(true);
  assertEquals(rooted.seen, bare.seen);
  assertEquals(rooted.calls, bare.calls);
});

Deno.test("useUnitOfWorkFactoryForTesting: receives the flush, parent and role production chose", async () => {
  const { hook } = recordingHook();
  const push = countingFlush();
  const seen: BoundUnitOfWorkOptions[] = [];
  const dispose = useUnitOfWorkFactoryForTesting((markDirty, options) => {
    seen.push(options);
    return createLegacyUnitOfWork(markDirty, options);
  });
  let root: UnitOfWork | undefined;
  try {
    await runInRootUnitOfWork(
      { markDirty: hook },
      { flush: push.flush },
      () => {
        root = currentUnitOfWork();
        openRepoUnitOfWork(hook);
        return Promise.resolve();
      },
    );
  } finally {
    dispose();
  }
  assertEquals(seen.map((o) => o.role), ["root", "use-case"]);
  // The root wraps the caller's push to hand it the outcome; the factory's
  // flush is that push.
  assertEquals(push.calls(), 1);
  await seen[0].flush?.();
  assertEquals(push.calls(), 2);
  assertStrictEquals(seen[0].parent, undefined);
  assertStrictEquals(seen[1].flush, undefined);
  assertStrictEquals(seen[1].parent, root);
});

Deno.test("openRepoUnitOfWork: when the ambient unit has ended, the new unit rolls up into its nearest open ancestor", async () => {
  const { hook } = recordingHook();
  let rootSeen: RootUnitOfWork | undefined;
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: undefined },
    async (root) => {
      rootSeen = root;
      const rootUnit = currentUnitOfWork();
      const useCase = openRepoUnitOfWork(hook);
      // Work started in the use case's scope that outlives its unit.
      const { promise: go, resolve } = Promise.withResolvers<void>();
      const escaped = runInUnitOfWork(useCase, async () => {
        await go;
        const late = openRepoUnitOfWork(hook);
        assertStrictEquals(legacyUnitOfWorkParent(late), rootUnit);
        await late.stage({ kind: "write", path: "/cache/data/late" });
        await late.commit();
      });
      await useCase.abandon();
      resolve();
      await escaped;
    },
  );
  assertEquals(rootSeen!.staged(), [
    { kind: "write", path: "/cache/data/late" },
  ]);
});

Deno.test("runInRootUnitOfWork: under an ended ambient unit with an open ancestor it is that ancestor's child and does not flush", async () => {
  const { hook } = recordingHook();
  const outerPush = countingFlush();
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: outerPush.flush },
    async () => {
      const rootUnit = currentUnitOfWork();
      const useCase = openRepoUnitOfWork(hook);
      await useCase.commit();
      await runInUnitOfWork(useCase, () =>
        runInRootUnitOfWork(
          { markDirty: hook },
          { flush: undefined },
          () => {
            assertStrictEquals(
              legacyUnitOfWorkParent(currentUnitOfWork()!),
              rootUnit,
            );
            return Promise.resolve();
          },
        ));
    },
  );
  assertEquals(outerPush.calls(), 1);
});

Deno.test("runInRootUnitOfWork: under an ended ambient unit with no open ancestor it is a root and flushes", async () => {
  const { hook } = recordingHook();
  const push = countingFlush();
  const spent = openRepoUnitOfWork(hook);
  await spent.commit();
  await runInUnitOfWork(spent, () =>
    runInRootUnitOfWork(
      { markDirty: hook },
      { flush: push.flush },
      () => {
        assertStrictEquals(
          legacyUnitOfWorkParent(currentUnitOfWork()!),
          undefined,
        );
        return Promise.resolve();
      },
    ));
  assertEquals(push.calls(), 1);
});

/** A mark hook whose next call stays in flight until released. */
function holdingHook(): {
  hook: MarkDirtyHook;
  holdNext: () => () => void;
  settled: () => number;
} {
  let hold: Promise<void> | undefined;
  let settled = 0;
  return {
    hook: async () => {
      const held = hold;
      hold = undefined;
      await held;
      settled++;
    },
    holdNext: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      hold = promise;
      return () => resolve();
    },
    settled: () => settled,
  };
}

Deno.test("runInRootUnitOfWork: checkpoint waits for a mark in flight, including a child's, before it pushes", async () => {
  const { hook, holdNext, settled } = holdingHook();
  let settledAtCheckpoint: number | undefined;
  await runInRootUnitOfWork(
    { markDirty: hook },
    {
      flush: undefined,
      checkpoint: () => {
        settledAtCheckpoint = settled();
        return Promise.resolve();
      },
    },
    async (root) => {
      const releaseRoot = holdNext();
      const rootMark = root.stage({ kind: "bulk", reason: "root" });
      const child = openRepoUnitOfWork(hook);
      const releaseChild = holdNext();
      const childMark = child.stage({ kind: "write", path: "/cache/data/a" });
      const checkpoint = root.checkpoint();
      releaseChild();
      releaseRoot();
      await Promise.all([rootMark, childMark, checkpoint]);
      await child.commit();
    },
  );
  assertEquals(settledAtCheckpoint, 2);
});

Deno.test("runInRootUnitOfWork: two checkpoints then the end push three times, in order, and the root flushes once", async () => {
  const { hook } = recordingHook();
  const pushes: string[] = [];
  await runInRootUnitOfWork(
    { markDirty: hook },
    {
      flush: () => {
        pushes.push("flush");
        return Promise.resolve();
      },
      checkpoint: () => {
        pushes.push("checkpoint");
        return Promise.resolve();
      },
    },
    async (root) => {
      await root.stage({ kind: "bulk", reason: "first" });
      await root.checkpoint();
      assertEquals(pushes, ["checkpoint"]);
      await root.stage({ kind: "bulk", reason: "second" });
      await root.checkpoint();
      assertEquals(pushes, ["checkpoint", "checkpoint"]);
    },
  );
  assertEquals(pushes, ["checkpoint", "checkpoint", "flush"]);
});

Deno.test("runInRootUnitOfWork: checkpoint throws when the root has no checkpoint option", async () => {
  const { hook } = recordingHook();
  const push = countingFlush();
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: push.flush },
    async (root) => {
      await assertRejects(
        () => root.checkpoint(),
        Error,
        "opened without a checkpoint option",
      );
    },
  );
  assertEquals(push.calls(), 1);
});

Deno.test("runInRootUnitOfWork: checkpoint throws from a nested call, which is a child; the outer root owns it", async () => {
  const { hook } = recordingHook();
  let checkpoints = 0;
  await runInRootUnitOfWork(
    { markDirty: hook },
    {
      flush: undefined,
      checkpoint: () => {
        checkpoints++;
        return Promise.resolve();
      },
    },
    async (root) => {
      await runInRootUnitOfWork(
        { markDirty: hook },
        { flush: undefined },
        async (inner) => {
          await assertRejects(
            () => inner.checkpoint(),
            Error,
            "the outer root owns the checkpoint",
          );
        },
      );
      await root.checkpoint();
    },
  );
  assertEquals(checkpoints, 1);
});

Deno.test("runInRootUnitOfWork: a nested call given its own checkpoint throws instead of dropping it", async () => {
  const { hook } = recordingHook();
  const outerPush = countingFlush();
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: outerPush.flush },
    async () => {
      const error = await assertRejects(() =>
        runInRootUnitOfWork(
          { markDirty: hook },
          { flush: undefined, checkpoint: () => Promise.resolve() },
          () => Promise.resolve(),
        )
      );
      assertStringIncludes(String(error), "its own checkpoint");
    },
  );
  assertEquals(outerPush.calls(), 1);
});

Deno.test("runInRootUnitOfWork: checkpoint throws after the root has ended", async () => {
  const { hook } = recordingHook();
  let checkpoints = 0;
  let escaped: RootUnitOfWork | undefined;
  await runInRootUnitOfWork(
    { markDirty: hook },
    {
      flush: undefined,
      checkpoint: () => {
        checkpoints++;
        return Promise.resolve();
      },
    },
    (root) => {
      escaped = root;
      return Promise.resolve();
    },
  );
  await assertRejects(
    () => escaped!.checkpoint(),
    Error,
    "after its root unit of work ended",
  );
  assertEquals(checkpoints, 0);
});

Deno.test("runInRootUnitOfWork: a failing checkpoint rejects inside fn, the root abandons, and the flush still runs", async () => {
  const { hook } = recordingHook();
  const push = countingFlush();
  const checkpointError = new Error("checkpoint push failed");
  let caughtInFn: unknown;
  const rejected = await assertRejects(() =>
    runInRootUnitOfWork(
      { markDirty: hook },
      {
        flush: push.flush,
        checkpoint: () => Promise.reject(checkpointError),
      },
      async (root) => {
        try {
          await root.checkpoint();
        } catch (error) {
          caughtInFn = error;
          throw error;
        }
      },
    )
  );
  assertStrictEquals(caughtInFn, checkpointError);
  assertStrictEquals(rejected, checkpointError);
  assertEquals(push.calls(), 1);
});

Deno.test("runInRootUnitOfWork: the flush receives whether fn completed", async () => {
  const { hook } = recordingHook();
  const outcomes: boolean[] = [];
  const flush = (outcome: { completed: boolean }) => {
    outcomes.push(outcome.completed);
    return Promise.resolve();
  };
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush },
    () => Promise.resolve(),
  );
  await assertRejects(() =>
    runInRootUnitOfWork(
      { markDirty: hook },
      { flush },
      () => Promise.reject(new Error("command failed")),
    )
  );
  assertEquals(outcomes, [true, false]);
});

Deno.test("runInRootUnitOfWork: pushWhen completed flushes once when fn resolves", async () => {
  const { hook } = recordingHook();
  const push = countingFlush();
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: push.flush, pushWhen: "completed" },
    () => Promise.resolve(),
  );
  assertEquals(push.calls(), 1);
});

Deno.test("runInRootUnitOfWork: pushWhen completed skips the flush when fn throws, and rethrows fn's error", async () => {
  const { hook } = recordingHook();
  const push = countingFlush();
  const error = new Error("command failed");
  const rejected = await assertRejects(() =>
    runInRootUnitOfWork(
      { markDirty: hook },
      { flush: push.flush, pushWhen: "completed" },
      () => Promise.reject(error),
    )
  );
  assertStrictEquals(rejected, error);
  assertEquals(push.calls(), 0);
});

Deno.test("runInRootUnitOfWork: pushWhen completed skips the flush when fn throws after staging, and the staged marks still reached the hook", async () => {
  const { hook, calls } = recordingHook();
  const push = countingFlush();
  await assertRejects(() =>
    runInRootUnitOfWork(
      { markDirty: hook },
      { flush: push.flush, pushWhen: "completed" },
      async (root) => {
        await root.stage({ kind: "bulk", reason: "partial" });
        throw new Error("command failed after a write");
      },
    )
  );
  assertEquals(push.calls(), 0);
  assertEquals(calls.length, 1);
});

Deno.test("runInRootUnitOfWork: pushWhen always flushes on both outcomes", async () => {
  const { hook } = recordingHook();
  const push = countingFlush();
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: push.flush, pushWhen: "always" },
    () => Promise.resolve(),
  );
  await assertRejects(() =>
    runInRootUnitOfWork(
      { markDirty: hook },
      { flush: push.flush, pushWhen: "always" },
      () => Promise.reject(new Error("command failed")),
    )
  );
  assertEquals(push.calls(), 2);
});

Deno.test("runInRootUnitOfWork: pushWhen completed leaves checkpoint unaffected", async () => {
  const { hook } = recordingHook();
  const pushes: string[] = [];
  await assertRejects(() =>
    runInRootUnitOfWork(
      { markDirty: hook },
      {
        flush: () => {
          pushes.push("flush");
          return Promise.resolve();
        },
        checkpoint: () => {
          pushes.push("checkpoint");
          return Promise.resolve();
        },
        pushWhen: "completed",
      },
      async (root) => {
        await root.checkpoint();
        throw new Error("command failed after its checkpoint");
      },
    )
  );
  assertEquals(pushes, ["checkpoint"]);
});
