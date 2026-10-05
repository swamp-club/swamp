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
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";
import { assertUnitOfWorkContract } from "../testing/unit_of_work_contract.ts";
import {
  createLegacyUnitOfWork,
  legacyParentFor,
  legacyUnitOfWorkParent,
  legacyUnitOfWorkSettled,
  legacyUnitOfWorkTarget,
} from "./legacy_unit_of_work.ts";

/**
 * A mark hook that records its arguments, and can reject the next call or
 * hold it open until released.
 */
function recordingHook(): {
  hook: MarkDirtyHook;
  calls: (string | undefined)[];
  failNext: (error: Error) => void;
  holdNext: () => () => void;
  pending: () => number;
} {
  const calls: (string | undefined)[] = [];
  let failure: Error | undefined;
  let hold: Promise<void> | undefined;
  let pending = 0;
  const hook: MarkDirtyHook = async (relPath?: string) => {
    calls.push(relPath);
    const error = failure;
    const held = hold;
    failure = undefined;
    hold = undefined;
    if (error) throw error;
    pending++;
    try {
      await held;
    } finally {
      pending--;
    }
  };
  const holdNext = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    hold = promise;
    return () => resolve();
  };
  return {
    hook,
    calls,
    failNext: (error) => (failure = error),
    holdNext,
    pending: () => pending,
  };
}

Deno.test("createLegacyUnitOfWork: meets the unit of work contract", async () => {
  await assertUnitOfWorkContract(() => {
    const { hook, calls, failNext, holdNext, pending } = recordingHook();
    const listeners = {
      commit: [] as Array<() => Promise<void>>,
      abandon: [] as Array<() => Promise<void>>,
    };
    // A legacy unit flushes on either ending; the wrapper tells the flush
    // which one is running.
    let ending: "commit" | "abandon" = "commit";
    const real = createLegacyUnitOfWork(hook, {
      flush: async () => {
        for (const listener of listeners[ending]) await listener();
      },
    });
    const unit: UnitOfWork = {
      stage: (change) => real.stage(change),
      commit: () => {
        ending = "commit";
        return real.commit();
      },
      abandon: () => {
        ending = "abandon";
        return real.abandon();
      },
      staged: () => real.staged(),
    };
    return {
      unit,
      forwarded: () => calls,
      failNext,
      holdNext,
      pendingForwards: pending,
      onCommit: (listener) => listeners.commit.push(listener),
      onAbandon: (listener) => listeners.abandon.push(listener),
    };
  });
});

Deno.test("createLegacyUnitOfWork: write, remove and bulk mark the path, the path and nothing, in order", async () => {
  const { hook, calls } = recordingHook();
  const unit = createLegacyUnitOfWork(hook, { flush: undefined });

  await unit.stage({ kind: "write", path: "/cache/data/a" });
  await unit.stage({ kind: "remove", path: "/cache/data/b" });
  await unit.stage({ kind: "bulk", reason: "rename tombstone" });
  await unit.stage({ kind: "write", path: "/cache/data/a" });

  assertEquals(calls, [
    "/cache/data/a",
    "/cache/data/b",
    undefined,
    "/cache/data/a",
  ]);
});

Deno.test("createLegacyUnitOfWork: with no hook, sends nothing and still records the changes", async () => {
  const unit = createLegacyUnitOfWork(undefined, { flush: undefined });

  await unit.stage({ kind: "write", path: "/repo/.swamp/data/a" });
  await unit.stage({ kind: "bulk", reason: "gc" });

  assertEquals(unit.staged(), [
    { kind: "write", path: "/repo/.swamp/data/a" },
    { kind: "bulk", reason: "gc" },
  ]);
});

Deno.test("createLegacyUnitOfWork: a hook rejection rejects stage with the same error and keeps the change", async () => {
  const { hook, failNext } = recordingHook();
  const unit = createLegacyUnitOfWork(hook, { flush: undefined });
  const error = new Error("remote unreachable");
  failNext(error);

  const rejected = await assertRejects(() =>
    unit.stage({ kind: "remove", path: "/cache/data/a" })
  );

  assertStrictEquals(rejected, error);
  assertEquals(unit.staged(), [{ kind: "remove", path: "/cache/data/a" }]);
});

Deno.test("createLegacyUnitOfWork: commit calls flush once", async () => {
  let flushes = 0;
  const unit = createLegacyUnitOfWork(undefined, {
    flush: () => {
      flushes++;
      return Promise.resolve();
    },
  });

  await unit.commit();

  assertEquals(flushes, 1);
});

Deno.test("createLegacyUnitOfWork: commit resolves without flush", async () => {
  const { hook, calls } = recordingHook();
  const unit = createLegacyUnitOfWork(hook, { flush: undefined });
  await unit.stage({ kind: "write", path: "/cache/data/a" });

  await unit.commit();

  assertEquals(calls, ["/cache/data/a"]);
});

Deno.test("createLegacyUnitOfWork: commit flushes only after a mark in flight settles", async () => {
  const { hook, holdNext } = recordingHook();
  const release = holdNext();
  let marked = false;
  let markedAtFlush: boolean | undefined;
  const unit = createLegacyUnitOfWork(hook, {
    flush: () => {
      markedAtFlush = marked;
      return Promise.resolve();
    },
  });

  const stage = unit.stage({ kind: "write", path: "/cache/data/a" }).then(
    () => {
      marked = true;
    },
  );
  const commit = unit.commit();
  release();
  await stage;
  await commit;

  assertEquals(markedAtFlush, true);
});

Deno.test("createLegacyUnitOfWork: commit still flushes after a mark in flight rejects", async () => {
  const { hook, failNext } = recordingHook();
  const error = new Error("remote unreachable");
  failNext(error);
  let flushes = 0;
  const unit = createLegacyUnitOfWork(hook, {
    flush: () => {
      flushes++;
      return Promise.resolve();
    },
  });

  const stage = unit.stage({ kind: "write", path: "/cache/data/a" });
  const commit = unit.commit();

  assertStrictEquals(await assertRejects(() => stage), error);
  await commit;
  assertEquals(flushes, 1);
});

Deno.test("createLegacyUnitOfWork: staging or committing after commit rejects", async () => {
  const { hook, calls } = recordingHook();
  const unit = createLegacyUnitOfWork(hook, { flush: undefined });
  await unit.commit();

  await assertRejects(
    () => unit.stage({ kind: "write", path: "/cache/data/a" }),
    Error,
    "unit of work already committed",
  );
  await assertRejects(
    () => unit.commit(),
    Error,
    "unit of work already committed",
  );
  assertEquals(calls, []);
  assertEquals(unit.staged(), []);
});

Deno.test("createLegacyUnitOfWork: afterCommit reject is the default and rejects a late stage", async () => {
  const { hook, calls } = recordingHook();
  const unit = createLegacyUnitOfWork(hook, {
    flush: undefined,
    afterCommit: "reject",
  });
  await unit.commit();

  await assertRejects(
    () => unit.stage({ kind: "write", path: "/cache/data/a" }),
    Error,
    "unit of work already committed",
  );
  assertEquals(calls, []);
});

Deno.test("createLegacyUnitOfWork: afterCommit forward marks a late change once through the hook and logs it", async () => {
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
    const { hook, calls } = recordingHook();
    const unit = createLegacyUnitOfWork(hook, {
      flush: undefined,
      afterCommit: "forward",
    });
    await unit.stage({ kind: "write", path: "/cache/data/a" });
    await unit.commit();

    await unit.stage({ kind: "write", path: "/cache/data/late" });
    await unit.stage({ kind: "remove", path: "/cache/data/gone" });
    await unit.stage({ kind: "bulk", reason: "rename tombstone" });

    assertEquals(calls, [
      "/cache/data/a",
      "/cache/data/late",
      "/cache/data/gone",
      undefined,
    ]);
    assertEquals(unit.staged(), [{ kind: "write", path: "/cache/data/a" }]);
    assertEquals(records.length, 3);
    assertEquals(records.every((r) => r.level === "debug"), true);
    assertEquals(
      records.map((r) => r.message.filter((_, i) => i % 2 === 1)),
      [
        ["write", "/cache/data/late"],
        ["remove", "/cache/data/gone"],
        ["bulk", "rename tombstone"],
      ],
    );
  } finally {
    await reset();
  }
});

Deno.test("createLegacyUnitOfWork: afterCommit forward never rejects without a hook, and still refuses a second commit", async () => {
  const unit = createLegacyUnitOfWork(undefined, {
    flush: undefined,
    afterCommit: "forward",
  });
  await unit.commit();

  await unit.stage({ kind: "write", path: "/cache/data/late" });
  assertEquals(unit.staged(), []);
  await assertRejects(
    () => unit.commit(),
    Error,
    "unit of work already committed",
  );
});

Deno.test("createLegacyUnitOfWork: afterCommit forward rejects a late stage with the hook's own error", async () => {
  const { hook, failNext } = recordingHook();
  const unit = createLegacyUnitOfWork(hook, {
    flush: undefined,
    afterCommit: "forward",
  });
  await unit.commit();
  const error = new Error("remote down");
  failNext(error);

  const rejected = await assertRejects(() =>
    unit.stage({ kind: "write", path: "/cache/data/late" })
  );
  assertStrictEquals(rejected, error);
});

Deno.test("createLegacyUnitOfWork: a failed flush rejects commit and spends the unit", async () => {
  const error = new Error("push failed");
  let flushes = 0;
  const unit = createLegacyUnitOfWork(undefined, {
    flush: () => {
      flushes++;
      return Promise.reject(error);
    },
  });

  const rejected = await assertRejects(() => unit.commit());

  assertStrictEquals(rejected, error);
  await assertRejects(
    () => unit.commit(),
    Error,
    "unit of work already committed",
  );
  assertEquals(flushes, 1);
});

Deno.test("createLegacyUnitOfWork: staged() returns frozen copies", async () => {
  const unit = createLegacyUnitOfWork(undefined, { flush: undefined });
  const change = { kind: "write" as const, path: "/cache/data/a" };
  await unit.stage(change);

  const staged = unit.staged() as StagedChange[];
  assertThrows(() => staged.push({ kind: "bulk", reason: "tamper" }));
  assertThrows(() => {
    (staged[0] as { path: string }).path = "/cache/data/tamper";
  });
  change.path = "/cache/data/changed";

  assertEquals(unit.staged(), [{ kind: "write", path: "/cache/data/a" }]);
});

Deno.test("legacyUnitOfWorkTarget: is the exact hook the unit was created with", () => {
  const { hook } = recordingHook();
  const other = recordingHook().hook;
  const uow = createLegacyUnitOfWork(hook, { flush: undefined });
  assertStrictEquals(legacyUnitOfWorkTarget(uow), hook);
  assertEquals(legacyUnitOfWorkTarget(uow) === other, false);
});

Deno.test("legacyUnitOfWorkTarget: is undefined for a unit created without a hook", () => {
  const uow = createLegacyUnitOfWork(undefined, { flush: undefined });
  assertStrictEquals(legacyUnitOfWorkTarget(uow), undefined);
});

Deno.test("legacyUnitOfWorkTarget: is undefined for a unit of work built any other way", () => {
  const staged: StagedChange[] = [];
  const uow = {
    stage: (change: StagedChange) => {
      staged.push(change);
      return Promise.resolve();
    },
    commit: () => Promise.resolve(),
    abandon: () => Promise.resolve(),
    staged: () => staged,
  };
  assertStrictEquals(legacyUnitOfWorkTarget(uow), undefined);
});

Deno.test("createLegacyUnitOfWork: abandon with a flush flushes once", async () => {
  const { hook, calls } = recordingHook();
  let flushes = 0;
  const unit = createLegacyUnitOfWork(hook, {
    flush: () => {
      flushes++;
      return Promise.resolve();
    },
  });
  await unit.stage({ kind: "write", path: "/cache/data/a" });
  await unit.abandon();
  assertEquals(flushes, 1);
  assertEquals(calls, ["/cache/data/a"]);
  await assertRejects(
    () => unit.abandon(),
    Error,
    "unit of work already abandoned",
  );
  assertEquals(flushes, 1);
});

Deno.test("createLegacyUnitOfWork: abandon without a flush sends nothing more", async () => {
  const { hook, calls } = recordingHook();
  const unit = createLegacyUnitOfWork(hook, { flush: undefined });
  await unit.stage({ kind: "bulk", reason: "test" });
  await unit.abandon();
  assertEquals(calls, [undefined]);
  assertEquals(unit.staged(), [{ kind: "bulk", reason: "test" }]);
});

Deno.test("createLegacyUnitOfWork: afterCommit forward sends a change staged after abandon to the hook", async () => {
  const { hook, calls } = recordingHook();
  const unit = createLegacyUnitOfWork(hook, {
    flush: undefined,
    afterCommit: "forward",
  });
  await unit.abandon();
  await unit.stage({ kind: "write", path: "/cache/data/late" });
  assertEquals(calls, ["/cache/data/late"]);
  assertEquals(unit.staged(), []);
});

Deno.test("createLegacyUnitOfWork: a child forwards at once and records in itself and every open ancestor", async () => {
  const { hook, calls } = recordingHook();
  const root = createLegacyUnitOfWork(hook, { flush: undefined });
  const child = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: root,
  });
  const grandchild = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: child,
  });
  assertStrictEquals(legacyUnitOfWorkParent(root), undefined);
  assertStrictEquals(legacyUnitOfWorkParent(child), root);
  assertStrictEquals(legacyUnitOfWorkParent(grandchild), child);

  await root.stage({ kind: "write", path: "/cache/data/r" });
  await child.stage({ kind: "remove", path: "/cache/data/c" });
  await grandchild.stage({ kind: "bulk", reason: "nested" });
  await child.stage({ kind: "write", path: "/cache/data/c2" });

  assertEquals(calls, [
    "/cache/data/r",
    "/cache/data/c",
    undefined,
    "/cache/data/c2",
  ]);
  assertEquals(grandchild.staged(), [{ kind: "bulk", reason: "nested" }]);
  assertEquals(child.staged(), [
    { kind: "remove", path: "/cache/data/c" },
    { kind: "bulk", reason: "nested" },
    { kind: "write", path: "/cache/data/c2" },
  ]);
  assertEquals(root.staged(), [
    { kind: "write", path: "/cache/data/r" },
    { kind: "remove", path: "/cache/data/c" },
    { kind: "bulk", reason: "nested" },
    { kind: "write", path: "/cache/data/c2" },
  ]);
});

Deno.test("createLegacyUnitOfWork: a child's commit and abandon only spend it; the root flushes", async () => {
  const { hook } = recordingHook();
  let flushes = 0;
  const root = createLegacyUnitOfWork(hook, {
    flush: () => {
      flushes++;
      return Promise.resolve();
    },
  });
  const committed = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: root,
  });
  const abandoned = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: root,
  });
  await committed.stage({ kind: "write", path: "/cache/data/a" });
  await committed.commit();
  await abandoned.abandon();
  assertEquals(flushes, 0);
  await root.commit();
  assertEquals(flushes, 1);
});

Deno.test("createLegacyUnitOfWork: a child cannot be given a flush", () => {
  const { hook } = recordingHook();
  const root = createLegacyUnitOfWork(hook, { flush: undefined });
  assertThrows(
    () =>
      createLegacyUnitOfWork(hook, {
        flush: () => Promise.resolve(),
        parent: root,
      }),
    Error,
    "a child unit of work cannot flush",
  );
});

Deno.test("createLegacyUnitOfWork: a parent that is spent, bound to another hook, or not legacy makes a root", async () => {
  const { hook } = recordingHook();
  const other = recordingHook();
  const spent = createLegacyUnitOfWork(hook, { flush: undefined });
  await spent.commit();
  const otherHook = createLegacyUnitOfWork(other.hook, { flush: undefined });
  const foreign: UnitOfWork = {
    stage: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    abandon: () => Promise.resolve(),
    staged: () => [],
  };
  for (const parent of [spent, otherHook, foreign]) {
    const unit = createLegacyUnitOfWork(hook, {
      flush: () => Promise.resolve(),
      parent,
    });
    assertStrictEquals(legacyUnitOfWorkParent(unit), undefined);
    await unit.stage({ kind: "write", path: "/cache/data/a" });
    assertEquals(otherHook.staged(), []);
  }
  const unbound = createLegacyUnitOfWork(undefined, {
    flush: undefined,
    parent: createLegacyUnitOfWork(undefined, { flush: undefined }),
  });
  assertStrictEquals(legacyUnitOfWorkParent(unbound), undefined);
});

Deno.test("createLegacyUnitOfWork: a change staged on a spent child goes to its nearest open ancestor", async () => {
  const { hook, calls } = recordingHook();
  const root = createLegacyUnitOfWork(hook, { flush: undefined });
  const child = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: root,
  });
  const grandchild = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: child,
  });
  await grandchild.commit();
  await child.abandon();
  await grandchild.stage({ kind: "write", path: "/cache/data/late" });
  assertEquals(calls, ["/cache/data/late"]);
  assertEquals(root.staged(), [{ kind: "write", path: "/cache/data/late" }]);
  assertEquals(child.staged(), []);
  assertEquals(grandchild.staged(), []);
});

Deno.test("createLegacyUnitOfWork: with no open ancestor a spent child follows afterCommit", async () => {
  const { hook, calls } = recordingHook();
  const root = createLegacyUnitOfWork(hook, { flush: undefined });
  const rejecting = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: root,
  });
  const forwarding = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: root,
    afterCommit: "forward",
  });
  await rejecting.commit();
  await forwarding.commit();
  await root.commit();
  await assertRejects(
    () => rejecting.stage({ kind: "write", path: "/cache/data/x" }),
    Error,
    "unit of work already committed",
  );
  await forwarding.stage({ kind: "write", path: "/cache/data/y" });
  assertEquals(calls, ["/cache/data/y"]);
  assertEquals(root.staged(), []);
});

Deno.test("createLegacyUnitOfWork: ending a root waits for a child's mark in flight", async () => {
  const { hook, holdNext, pending } = recordingHook();
  let pendingAtFlush: number | undefined;
  const root = createLegacyUnitOfWork(hook, {
    flush: () => {
      pendingAtFlush = pending();
      return Promise.resolve();
    },
  });
  const child = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: root,
  });
  const release = holdNext();
  const stage = child.stage({ kind: "write", path: "/cache/data/a" });
  const commit = root.commit();
  release();
  await stage;
  await commit;
  assertEquals(pendingAtFlush, 0);
});

Deno.test("createLegacyUnitOfWork: a spent parent hands the new unit to its nearest open ancestor", async () => {
  const { hook } = recordingHook();
  const root = createLegacyUnitOfWork(hook, { flush: undefined });
  const spent = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: root,
  });
  await spent.abandon();
  const unit = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: spent,
  });
  assertStrictEquals(legacyUnitOfWorkParent(unit), root);
  assertStrictEquals(legacyParentFor(hook, spent), root);
  await unit.stage({ kind: "write", path: "/cache/data/a" });
  assertEquals(root.staged(), [{ kind: "write", path: "/cache/data/a" }]);
});

Deno.test("legacyUnitOfWorkSettled: waits for a mark in flight, including a child's, and leaves the unit open", async () => {
  const { hook, holdNext, calls } = recordingHook();
  const flushes: string[] = [];
  const root = createLegacyUnitOfWork(hook, {
    flush: () => {
      flushes.push("flush");
      return Promise.resolve();
    },
  });
  const child = createLegacyUnitOfWork(hook, {
    flush: undefined,
    parent: root,
  });
  const release = holdNext();
  let marked = false;
  const stage = child.stage({ kind: "write", path: "/cache/data/a" }).then(
    () => {
      marked = true;
    },
  );
  let markedAtSettle: boolean | undefined;
  const settled = legacyUnitOfWorkSettled(root).then(() => {
    markedAtSettle = marked;
  });
  release();
  await stage;
  await settled;

  assertEquals(markedAtSettle, true);
  assertEquals(flushes, []);
  await root.stage({ kind: "write", path: "/cache/data/b" });
  assertEquals(calls, ["/cache/data/a", "/cache/data/b"]);
  await root.commit();
  assertEquals(flushes, ["flush"]);
});

Deno.test("legacyUnitOfWorkSettled: does not rethrow a rejected mark", async () => {
  const { hook, failNext } = recordingHook();
  const error = new Error("remote unreachable");
  failNext(error);
  const unit = createLegacyUnitOfWork(hook, { flush: undefined });

  const stage = unit.stage({ kind: "write", path: "/cache/data/a" });
  const settled = legacyUnitOfWorkSettled(unit);

  assertStrictEquals(await assertRejects(() => stage), error);
  await settled;
});

Deno.test("legacyUnitOfWorkSettled: resolves at once for a unit that is not a legacy unit", async () => {
  const unit: UnitOfWork = {
    stage: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    abandon: () => Promise.resolve(),
    staged: () => [],
  };
  await legacyUnitOfWorkSettled(unit);
});
