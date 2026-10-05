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
  assertThrows,
} from "@std/assert";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
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
import { currentUnitOfWork, runInUnitOfWork } from "./unit_of_work_scope.ts";

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
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: push.flush },
    async (root) => {
      rootSeen = root;
      assertStrictEquals(currentUnitOfWork(), root);
      child = openRepoUnitOfWork(hook);
      await child.stage({ kind: "write", path: "/cache/data/a" });
      await child.commit();
      const abandoned = openRepoUnitOfWork(hook);
      await abandoned.stage({ kind: "remove", path: "/cache/data/b" });
      await abandoned.abandon();
      assertEquals(push.calls(), 0);
    },
  );
  assertStrictEquals(legacyUnitOfWorkParent(child!), rootSeen);
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
        await new Promise((resolve) => setTimeout(resolve, 0));
        const child = openRepoUnitOfWork(hook);
        assertStrictEquals(legacyUnitOfWorkParent(child), root);
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
      assertStrictEquals(legacyUnitOfWorkTarget(root as UnitOfWork), undefined);
      await root.stage({ kind: "bulk", reason: "filesystem" });
    },
  );
  assertEquals(push.calls(), 1);
});

Deno.test("runInRootUnitOfWork: a nested call opens a child without a flush, so only the outer root pushes", async () => {
  const { hook } = recordingHook();
  const outerPush = countingFlush();
  const innerPush = countingFlush();
  let outerRoot: RootUnitOfWork | undefined;
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: outerPush.flush },
    async (root) => {
      outerRoot = root;
      await runInRootUnitOfWork(
        { markDirty: hook },
        { flush: innerPush.flush },
        async (inner) => {
          assertStrictEquals(
            legacyUnitOfWorkParent(inner as UnitOfWork),
            root as UnitOfWork,
          );
          await inner.stage({ kind: "write", path: "/cache/data/a" });
        },
      );
    },
  );
  assertEquals(innerPush.calls(), 0);
  assertEquals(outerPush.calls(), 1);
  assertEquals(outerRoot!.staged(), [{ kind: "write", path: "/cache/data/a" }]);
});

Deno.test("useUnitOfWorkFactoryForTesting: receives the flush, parent and role production chose", async () => {
  const { hook } = recordingHook();
  const push = countingFlush();
  const seen: BoundUnitOfWorkOptions[] = [];
  const dispose = useUnitOfWorkFactoryForTesting((markDirty, options) => {
    seen.push(options);
    return createLegacyUnitOfWork(markDirty, options);
  });
  let root: RootUnitOfWork | undefined;
  try {
    await runInRootUnitOfWork(
      { markDirty: hook },
      { flush: push.flush },
      (r) => {
        root = r;
        openRepoUnitOfWork(hook);
        return Promise.resolve();
      },
    );
  } finally {
    dispose();
  }
  assertEquals(seen.map((o) => o.role), ["root", "use-case"]);
  assertStrictEquals(seen[0].flush, push.flush);
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
      const useCase = openRepoUnitOfWork(hook);
      // Work started in the use case's scope that outlives its unit.
      const { promise: go, resolve } = Promise.withResolvers<void>();
      const escaped = runInUnitOfWork(useCase, async () => {
        await go;
        const late = openRepoUnitOfWork(hook);
        assertStrictEquals(legacyUnitOfWorkParent(late), root as UnitOfWork);
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
  const innerPush = countingFlush();
  await runInRootUnitOfWork(
    { markDirty: hook },
    { flush: outerPush.flush },
    async (root) => {
      const useCase = openRepoUnitOfWork(hook);
      await useCase.commit();
      await runInUnitOfWork(useCase, () =>
        runInRootUnitOfWork(
          { markDirty: hook },
          { flush: innerPush.flush },
          (inner) => {
            assertStrictEquals(
              legacyUnitOfWorkParent(inner as UnitOfWork),
              root as UnitOfWork,
            );
            return Promise.resolve();
          },
        ));
    },
  );
  assertEquals(innerPush.calls(), 0);
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
      (root) => {
        assertStrictEquals(
          legacyUnitOfWorkParent(root as UnitOfWork),
          undefined,
        );
        return Promise.resolve();
      },
    ));
  assertEquals(push.calls(), 1);
});
