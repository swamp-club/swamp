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

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";
import { createLegacyUnitOfWork } from "./legacy_unit_of_work.ts";
import {
  currentUnitOfWork,
  runInUnitOfWork,
  signalChange,
} from "./unit_of_work_scope.ts";

/** A mark hook that records its arguments and can reject the next call. */
function recordingHook(): {
  hook: MarkDirtyHook;
  calls: (string | undefined)[];
  failNext: (error: Error) => void;
} {
  const calls: (string | undefined)[] = [];
  let failure: Error | undefined;
  const hook: MarkDirtyHook = (relPath?: string) => {
    calls.push(relPath);
    const error = failure;
    failure = undefined;
    return error ? Promise.reject(error) : Promise.resolve();
  };
  return { hook, calls, failNext: (error) => failure = error };
}

const WRITE: StagedChange = { kind: "write", path: "/cache/data/a/raw" };
const REMOVE: StagedChange = { kind: "remove", path: "/cache/data/b" };
const BULK: StagedChange = { kind: "bulk", reason: "test" };

Deno.test("signalChange: with no scope, calls the hook with the path, and nothing for bulk", async () => {
  const { hook, calls } = recordingHook();
  await signalChange(hook, WRITE);
  await signalChange(hook, REMOVE);
  await signalChange(hook, BULK);
  assertEquals(calls, ["/cache/data/a/raw", "/cache/data/b", undefined]);
});

Deno.test("signalChange: in a scope bound to the hook, stages once and the unit marks once", async () => {
  const { hook, calls } = recordingHook();
  const uow = createLegacyUnitOfWork(hook, { flush: undefined });
  await runInUnitOfWork(uow, async () => {
    await signalChange(hook, WRITE);
    await signalChange(hook, BULK);
  });
  assertEquals(uow.staged(), [WRITE, BULK]);
  assertEquals(calls, ["/cache/data/a/raw", undefined]);
});

Deno.test("signalChange: in a scope bound to another hook, calls its own hook and stages nothing", async () => {
  const mine = recordingHook();
  const theirs = recordingHook();
  const uow = createLegacyUnitOfWork(theirs.hook, { flush: undefined });
  await runInUnitOfWork(uow, () => signalChange(mine.hook, WRITE));
  assertEquals(uow.staged(), []);
  assertEquals(theirs.calls, []);
  assertEquals(mine.calls, ["/cache/data/a/raw"]);
});

Deno.test("signalChange: with no hook, sends and stages nothing, even inside a scope", async () => {
  const { hook, calls } = recordingHook();
  const bound = createLegacyUnitOfWork(hook, { flush: undefined });
  const hookless = createLegacyUnitOfWork(undefined, { flush: undefined });
  await signalChange(undefined, WRITE);
  await runInUnitOfWork(bound, () => signalChange(undefined, WRITE));
  await runInUnitOfWork(hookless, () => signalChange(undefined, WRITE));
  assertEquals(bound.staged(), []);
  assertEquals(hookless.staged(), []);
  assertEquals(calls, []);
});

Deno.test("signalChange: a unit of work not built by the legacy adapter is never staged into", async () => {
  const { hook, calls } = recordingHook();
  const staged: StagedChange[] = [];
  const foreign: UnitOfWork = {
    stage: (change) => {
      staged.push(change);
      return Promise.resolve();
    },
    commit: () => Promise.resolve(),
    staged: () => staged,
  };
  await runInUnitOfWork(foreign, () => signalChange(hook, WRITE));
  assertEquals(staged, []);
  assertEquals(calls, ["/cache/data/a/raw"]);
});

Deno.test("signalChange: a hook rejection rejects with the same error on both routes", async () => {
  const { hook, failNext } = recordingHook();
  const direct = new Error("direct");
  failNext(direct);
  const thrownDirect = await assertRejects(() => signalChange(hook, WRITE));
  assertStrictEquals(thrownDirect, direct);

  const staged = new Error("staged");
  const uow = createLegacyUnitOfWork(hook, { flush: undefined });
  failNext(staged);
  const thrownStaged = await assertRejects(() =>
    runInUnitOfWork(uow, () => signalChange(hook, WRITE))
  );
  assertStrictEquals(thrownStaged, staged);
  assertEquals(uow.staged(), [WRITE]);
});

Deno.test("currentUnitOfWork: undefined outside, innermost inside nested scopes, outer restored after", async () => {
  const outer = createLegacyUnitOfWork(undefined, { flush: undefined });
  const inner = createLegacyUnitOfWork(undefined, { flush: undefined });
  assertStrictEquals(currentUnitOfWork(), undefined);
  await runInUnitOfWork(outer, async () => {
    assertStrictEquals(currentUnitOfWork(), outer);
    await runInUnitOfWork(inner, () => {
      assertStrictEquals(currentUnitOfWork(), inner);
      return Promise.resolve();
    });
    assertStrictEquals(currentUnitOfWork(), outer);
  });
  assertStrictEquals(currentUnitOfWork(), undefined);
});

Deno.test("runInUnitOfWork: returns fn's value and rejects with fn's error", async () => {
  const uow = createLegacyUnitOfWork(undefined, { flush: undefined });
  assertEquals(await runInUnitOfWork(uow, () => Promise.resolve(42)), 42);
  const error = new Error("boom");
  const thrown = await assertRejects(() =>
    runInUnitOfWork(uow, () => Promise.reject(error))
  );
  assertStrictEquals(thrown, error);
  assertStrictEquals(currentUnitOfWork(), undefined);
});
