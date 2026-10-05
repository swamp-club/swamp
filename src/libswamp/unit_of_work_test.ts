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

import {
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import type {
  StagedChange,
  UnitOfWork,
} from "../domain/datastore/unit_of_work.ts";
import { legacyUnitOfWorkParent } from "../infrastructure/persistence/legacy_unit_of_work.ts";
import {
  repoUnitOfWorkFactory,
  runInRootUnitOfWork,
} from "../infrastructure/persistence/repo_unit_of_work.ts";
import {
  currentUnitOfWork,
  signalChange,
} from "../infrastructure/persistence/unit_of_work_scope.ts";
import { createLibSwampContext, type LibSwampContext } from "./context.ts";
import { result } from "./stream.ts";
import { withUnitOfWork } from "./unit_of_work.ts";

type Event =
  | { kind: "step"; seen: UnitOfWork | undefined }
  | { kind: "completed" }
  | { kind: "suspended" }
  | { kind: "error"; message: string };

type CountingUnit = UnitOfWork & { commits: number; abandons: number };

/**
 * A unit of work that counts commits and abandons, plus a context that opens
 * them.
 */
function countingContext(): {
  ctx: LibSwampContext;
  units: CountingUnit[];
} {
  const units: CountingUnit[] = [];
  const ctx = createLibSwampContext({
    openUnitOfWork: () => {
      const staged: StagedChange[] = [];
      const uow = {
        commits: 0,
        abandons: 0,
        stage(change: StagedChange) {
          staged.push(change);
          return Promise.resolve();
        },
        commit() {
          uow.commits++;
          return Promise.resolve();
        },
        abandon() {
          uow.abandons++;
          return Promise.resolve();
        },
        staged: () => [...staged],
      };
      units.push(uow);
      return uow;
    },
  });
  return { ctx, units };
}

async function drain<E>(stream: AsyncIterable<E>): Promise<E[]> {
  const events: E[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// The zero-delay timers below are not waits: they force a macrotask boundary,
// the hardest case for AsyncLocalStorage to carry the scope across.
Deno.test("withUnitOfWork: the unit is ambient inside the generator across yields and awaits", async () => {
  const { ctx, units } = countingContext();
  async function* body(): AsyncGenerator<Event> {
    yield { kind: "step", seen: currentUnitOfWork() };
    await new Promise((resolve) => setTimeout(resolve, 0));
    yield { kind: "step", seen: currentUnitOfWork() };
    await Promise.resolve();
    yield { kind: "completed" };
  }
  const outside: (UnitOfWork | undefined)[] = [];
  const events: Event[] = [];
  for await (const event of withUnitOfWork(ctx, body)) {
    outside.push(currentUnitOfWork());
    events.push(event);
  }

  assertEquals(units.length, 1);
  assertStrictEquals(
    (events[0] as { seen: UnitOfWork | undefined }).seen,
    units[0],
  );
  assertStrictEquals(
    (events[1] as { seen: UnitOfWork | undefined }).seen,
    units[0],
  );
  assertEquals(outside, [undefined, undefined, undefined]);
});

Deno.test("withUnitOfWork: re-yields events unchanged and commits once after completed and the stream ends", async () => {
  const { ctx, units } = countingContext();
  const completed: Event = { kind: "completed" };
  let commitsWhenWriteAfterCompleted = -1;
  async function* body(): AsyncGenerator<Event> {
    yield completed;
    // A write after `completed` (modelMethodRun's autoGc) is still in the unit.
    commitsWhenWriteAfterCompleted = units[0].commits;
  }
  const events = await drain(withUnitOfWork(ctx, body));

  assertEquals(events.length, 1);
  assertStrictEquals(events[0], completed);
  assertEquals(commitsWhenWriteAfterCompleted, 0);
  assertEquals(units[0].commits, 1);
});

Deno.test("withUnitOfWork: abandons instead of committing after an error event", async () => {
  const { ctx, units } = countingContext();
  async function* body(): AsyncGenerator<Event> {
    yield { kind: "error", message: "boom" };
  }
  await drain(withUnitOfWork(ctx, body));
  assertEquals(units[0].commits, 0);
  assertEquals(units[0].abandons, 1);
});

Deno.test("withUnitOfWork: does not commit when the generator throws", async () => {
  const { ctx, units } = countingContext();
  // deno-lint-ignore require-yield
  async function* body(): AsyncGenerator<Event> {
    throw new Error("boom");
  }
  await assertRejects(() => drain(withUnitOfWork(ctx, body)), Error, "boom");
  assertEquals(units[0].commits, 0);
  assertEquals(units[0].abandons, 1);
});

Deno.test("withUnitOfWork: does not commit when the consumer stops early, and runs the generator's finally inside the unit", async () => {
  const { ctx, units } = countingContext();
  let finallySaw: UnitOfWork | undefined;
  async function* body(): AsyncGenerator<Event> {
    try {
      yield { kind: "completed" };
      yield { kind: "step", seen: undefined };
    } finally {
      finallySaw = currentUnitOfWork();
    }
  }
  const done = await result(withUnitOfWork(ctx, body));

  assertEquals(done.kind, "completed");
  // result() stops at completed with return(): the unit is abandoned, once.
  assertEquals(units[0].commits, 0);
  assertEquals(units[0].abandons, 1);
  assertStrictEquals(finallySaw, units[0]);
});

async function* endsOn(kind: string): AsyncGenerator<{ kind: string }> {
  yield { kind };
}

Deno.test("withUnitOfWork: abandons a stream that ends on suspended or cancelled", async () => {
  for (const kind of ["suspended", "cancelled"] as const) {
    const { ctx, units } = countingContext();
    await drain(withUnitOfWork(ctx, () => endsOn(kind)));
    assertEquals(units[0].commits, 0, kind);
    assertEquals(units[0].abandons, 1, kind);
  }
});

Deno.test("withUnitOfWork: abandons when the consumer stops before completed", async () => {
  const { ctx, units } = countingContext();
  async function* body(): AsyncGenerator<Event> {
    yield { kind: "step", seen: undefined };
    yield { kind: "completed" };
  }
  for await (const _event of withUnitOfWork(ctx, body)) break;
  assertEquals(units[0].commits, 0);
  assertEquals(units[0].abandons, 1);
});

Deno.test("withUnitOfWork: a failing abandon never masks the error that ended the stream", async () => {
  const { ctx, units } = countingContext();
  // deno-lint-ignore require-yield
  async function* body(): AsyncGenerator<Event> {
    units[0].abandon = () => Promise.reject(new Error("abandon failed"));
    throw new Error("boom");
  }
  await assertRejects(() => drain(withUnitOfWork(ctx, body)), Error, "boom");
});

Deno.test("withUnitOfWork: inside a root unit, a wrapped use case stages into a child that rolls up", async () => {
  const calls: (string | undefined)[] = [];
  const hook = (relPath?: string) => {
    calls.push(relPath);
    return Promise.resolve();
  };
  const ctx = createLibSwampContext({
    openUnitOfWork: repoUnitOfWorkFactory({ markDirty: hook }),
  });
  let child: UnitOfWork | undefined;
  let flushes = 0;
  const rootUnit = await runInRootUnitOfWork(
    { markDirty: hook },
    {
      flush: () => {
        flushes++;
        return Promise.resolve();
      },
    },
    async (root) => {
      async function* body(): AsyncGenerator<Event> {
        child = currentUnitOfWork();
        await signalChange(hook, { kind: "write", path: "/cache/data/a" });
        yield { kind: "completed" };
      }
      await result(withUnitOfWork(ctx, body));
      assertEquals(flushes, 0);
      return root;
    },
  );
  assertNotStrictEquals(child, rootUnit);
  assertStrictEquals(legacyUnitOfWorkParent(child!), rootUnit);
  assertEquals(child!.staged(), [{ kind: "write", path: "/cache/data/a" }]);
  assertEquals(rootUnit.staged(), [{ kind: "write", path: "/cache/data/a" }]);
  assertEquals(calls, ["/cache/data/a"]);
  assertEquals(flushes, 1);
});

Deno.test("withUnitOfWork: a nested use case stages into its own unit while it runs", async () => {
  const { ctx, units } = countingContext();
  async function* innerBody(): AsyncGenerator<Event> {
    yield { kind: "step", seen: currentUnitOfWork() };
    yield { kind: "completed" };
  }
  async function* outerBody(): AsyncGenerator<Event> {
    const before = currentUnitOfWork();
    const innerEvents = await drain(withUnitOfWork(ctx, innerBody));
    yield { kind: "step", seen: before };
    yield innerEvents[0];
    yield { kind: "step", seen: currentUnitOfWork() };
    yield { kind: "completed" };
  }
  const events = await drain(withUnitOfWork(ctx, outerBody));
  const seen = events.filter((e) => e.kind === "step").map((e) =>
    (e as { seen: UnitOfWork | undefined }).seen
  );

  assertEquals(units.length, 2);
  const [outer, inner] = units;
  assertStrictEquals(seen[0], outer);
  assertStrictEquals(seen[1], inner);
  assertStrictEquals(seen[2], outer);
  assertEquals(outer.commits, 1);
  assertEquals(inner.commits, 1);
  assertEquals([outer.abandons, inner.abandons], [0, 0]);
});

Deno.test("withUnitOfWork: concurrent use cases never share a unit", async () => {
  const { ctx, units } = countingContext();
  async function* body(): AsyncGenerator<Event> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    yield { kind: "step", seen: currentUnitOfWork() };
    await new Promise((resolve) => setTimeout(resolve, 0));
    yield { kind: "step", seen: currentUnitOfWork() };
    yield { kind: "completed" };
  }
  const [a, b] = await Promise.all([
    drain(withUnitOfWork(ctx, body)),
    drain(withUnitOfWork(ctx, body)),
  ]);
  const seenA = a.filter((e) => e.kind === "step").map((e) =>
    (e as { seen: UnitOfWork | undefined }).seen
  );
  const seenB = b.filter((e) => e.kind === "step").map((e) =>
    (e as { seen: UnitOfWork | undefined }).seen
  );

  assertEquals(units.length, 2);
  assertNotStrictEquals(seenA[0], seenB[0]);
  assertStrictEquals(seenA[0], seenA[1]);
  assertStrictEquals(seenB[0], seenB[1]);
  assertEquals(units.map((u) => u.commits), [1, 1]);
});

Deno.test("withUnitOfWork: child contexts from withTimeout and withSignal open units from the same factory", async () => {
  const { ctx, units } = countingContext();
  async function* body(): AsyncGenerator<Event> {
    yield { kind: "step", seen: currentUnitOfWork() };
    yield { kind: "completed" };
  }
  const timeoutCtx = ctx.withTimeout(60_000);
  const signalCtx = ctx.withSignal(new AbortController().signal);
  const fromTimeout = await drain(withUnitOfWork(timeoutCtx, body));
  const fromSignal = await drain(withUnitOfWork(signalCtx, body));

  assertEquals(units.length, 2);
  assertStrictEquals(
    (fromTimeout[0] as { seen: UnitOfWork | undefined }).seen,
    units[0],
  );
  assertStrictEquals(
    (fromSignal[0] as { seen: UnitOfWork | undefined }).seen,
    units[1],
  );
});

Deno.test("withUnitOfWork: when the consumer stops early and the generator's finally throws, that error propagates and the unit is abandoned", async () => {
  const { ctx, units } = countingContext();
  async function* body(): AsyncGenerator<Event> {
    try {
      yield { kind: "step", seen: undefined };
    } finally {
      // deno-lint-ignore no-unsafe-finally
      throw new Error("cleanup failed");
    }
  }
  await assertRejects(
    async () => {
      for await (const _event of withUnitOfWork(ctx, body)) break;
    },
    Error,
    "cleanup failed",
  );
  assertEquals(units[0].commits, 0);
  assertEquals(units[0].abandons, 1);
});
