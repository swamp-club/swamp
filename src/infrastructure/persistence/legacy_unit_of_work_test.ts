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
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { StagedChange } from "../../domain/datastore/unit_of_work.ts";
import { assertUnitOfWorkContract } from "../testing/unit_of_work_contract.ts";
import { createLegacyUnitOfWork } from "./legacy_unit_of_work.ts";

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
  return { hook, calls, failNext: (error) => (failure = error) };
}

Deno.test("createLegacyUnitOfWork: meets the unit of work contract", async () => {
  await assertUnitOfWorkContract(() => {
    const { hook, calls, failNext } = recordingHook();
    return {
      unit: createLegacyUnitOfWork(hook),
      forwarded: () => calls,
      failNext,
    };
  });
});

Deno.test("createLegacyUnitOfWork: write, remove and bulk mark the path, the path and nothing, in order", async () => {
  const { hook, calls } = recordingHook();
  const unit = createLegacyUnitOfWork(hook);

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
  const unit = createLegacyUnitOfWork(undefined);

  await unit.stage({ kind: "write", path: "/repo/.swamp/data/a" });
  await unit.stage({ kind: "bulk", reason: "gc" });

  assertEquals(unit.staged(), [
    { kind: "write", path: "/repo/.swamp/data/a" },
    { kind: "bulk", reason: "gc" },
  ]);
});

Deno.test("createLegacyUnitOfWork: a hook rejection rejects stage with the same error and keeps the change", async () => {
  const { hook, failNext } = recordingHook();
  const unit = createLegacyUnitOfWork(hook);
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
  const unit = createLegacyUnitOfWork(hook);
  await unit.stage({ kind: "write", path: "/cache/data/a" });

  await unit.commit();

  assertEquals(calls, ["/cache/data/a"]);
});

Deno.test("createLegacyUnitOfWork: staging or committing after commit rejects", async () => {
  const { hook, calls } = recordingHook();
  const unit = createLegacyUnitOfWork(hook);
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

Deno.test("createLegacyUnitOfWork: staged() returns a frozen copy", async () => {
  const unit = createLegacyUnitOfWork(undefined);
  await unit.stage({ kind: "write", path: "/cache/data/a" });

  const staged = unit.staged() as StagedChange[];
  assertThrows(() => staged.push({ kind: "bulk", reason: "tamper" }));

  assertEquals(unit.staged(), [{ kind: "write", path: "/cache/data/a" }]);
});
