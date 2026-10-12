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
 * A repository built without a hook stages its typed changes into the v3
 * unit around the call (swamp-club#3279), never into an ended one, and an
 * untyped write there is refused rather than dropped. v2 is untouched: no
 * commit-log unit exists there.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../../domain/datastore_v3/repository_changes.ts";
import { MemoryStorage } from "../../domain/datastore_v3/v3_test_helpers.ts";
import { createLegacyUnitOfWork } from "../persistence/legacy_unit_of_work.ts";
import {
  runInUnitOfWork,
  signalChange,
  stageTyped,
  typedStagingActive,
  UnscopedWriteRefusedError,
} from "../persistence/unit_of_work_scope.ts";
import { unitOfWorkBinding } from "../persistence/unit_of_work_binding.ts";
import {
  createCommitLogUnitOfWork,
  PathOnlyChangeRefusedError,
} from "./commit_log_unit_of_work.ts";
import {
  contextHook,
  MemorySink,
  unitOptions,
} from "./commit_log_test_helpers.ts";

function change() {
  return new AutoDefinitionChanges(crypto.randomUUID()).write(
    recordKeyOf(["auto-definitions", "x.yaml"]),
    new TextEncoder().encode("x"),
  );
}

Deno.test("stageTyped: a hookless write inside a v3 unit stages into it", async () => {
  const unit = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), new MemoryStorage()),
  );
  const staged = change();
  await runInUnitOfWork(unit, async () => {
    assertEquals(typedStagingActive(undefined), true);
    await stageTyped(undefined, () => [staged]);
  });
  assertEquals(unit.stagedOps().length, 1);
  await unit.abandon();
});

Deno.test("stageTyped: an unbound unit inside a v3 unit does not hide it", async () => {
  const unit = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), new MemoryStorage()),
  );
  const unbound = createLegacyUnitOfWork(undefined, { flush: undefined });
  await runInUnitOfWork(unit, () =>
    runInUnitOfWork(unbound, async () => {
      await stageTyped(undefined, () => [change()]);
    }));
  assertEquals(unit.stagedOps().length, 1);
  await unit.abandon();
});

Deno.test("stageTyped: a hookless write after its v3 unit ended stages nothing, as on v2", async () => {
  const unit = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), new MemoryStorage()),
  );
  let late: (() => Promise<void>) | undefined;
  await runInUnitOfWork(unit, () => {
    late = () => stageTyped(undefined, () => [change()]);
    return Promise.resolve();
  });
  await unit.abandon();
  await late!();
  assertEquals(typedStagingActive(undefined), false);
});

Deno.test("signalChange: a hookless untyped write inside a v3 unit is refused", async () => {
  const unit = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), new MemoryStorage()),
  );
  await runInUnitOfWork(unit, async () => {
    await assertRejects(
      () => signalChange(undefined, { kind: "write", path: "/x" }),
      PathOnlyChangeRefusedError,
    );
    // A typed write's path signal is checked, not staged.
    await signalChange(undefined, { kind: "write", path: "/x" }, {
      typed: true,
    });
  });
  await unit.abandon();
});

Deno.test("stageTyped: a hookless write on v2 stages nothing", async () => {
  const legacy = createLegacyUnitOfWork(undefined, { flush: undefined });
  let built = false;
  await runInUnitOfWork(legacy, async () => {
    assertEquals(typedStagingActive(undefined), false);
    await stageTyped(undefined, () => {
      built = true;
      return [];
    });
    await signalChange(undefined, { kind: "write", path: "/x" });
  });
  assertEquals(built, false);
  assertEquals(legacy.staged(), []);
});

Deno.test("signalChange: a hooked write under an unbound unit stages into the v3 unit around it bound to its hook", async () => {
  const hook = contextHook();
  unitOfWorkBinding.requireUnit(hook);
  const unit = createCommitLogUnitOfWork(
    hook,
    unitOptions(new MemorySink(), new MemoryStorage()),
  );
  const unbound = createLegacyUnitOfWork(undefined, { flush: undefined });
  await runInUnitOfWork(unit, () =>
    runInUnitOfWork(unbound, async () => {
      // The path signal is checked, then the typed changes stage.
      await signalChange(hook, { kind: "write", path: "/x" }, { typed: true });
      await stageTyped(hook, () => [change()]);
    }));
  assertEquals(unit.stagedOps().length, 1);
  await unit.abandon();
});

Deno.test("signalChange: a hooked v3 write with no unit bound to its hook around it is refused", async () => {
  const hook = contextHook();
  unitOfWorkBinding.requireUnit(hook);
  const other = createCommitLogUnitOfWork(
    contextHook(),
    unitOptions(new MemorySink(), new MemoryStorage()),
  );
  await runInUnitOfWork(other, async () => {
    await assertRejects(
      () => stageTyped(hook, () => [change()]),
      UnscopedWriteRefusedError,
    );
  });
  await other.abandon();
});
