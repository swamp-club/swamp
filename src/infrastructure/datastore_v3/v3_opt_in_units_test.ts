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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../../domain/datastore_v3/repository_changes.ts";
import { MemoryStorage } from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  type CommitLogUnitOptions,
  createCommitLogUnitOfWork,
} from "./commit_log_unit_of_work.ts";
import { runInCommitLogRoot } from "./commit_log_root.ts";
import {
  contextHook,
  MemorySink,
  unitOptions,
} from "./commit_log_test_helpers.ts";
import { createV3LockfileSync } from "./v3_lockfile_sync.ts";
import {
  bindCommitLogEngine,
  runInRootUnitOfWork,
} from "../persistence/repo_unit_of_work.ts";
import { currentUnitOfWork } from "../persistence/unit_of_work_scope.ts";
import { commitLogParentFor } from "./commit_log_unit_of_work.ts";

function definition(key: string) {
  return new AutoDefinitionChanges(crypto.randomUUID()).write(
    recordKeyOf(key.split("/")),
    new TextEncoder().encode(key),
  );
}

Deno.test("createCommitLogUnitOfWork: a key the datastore does not admit is never staged", async () => {
  const sink = new MemorySink();
  const unit = createCommitLogUnitOfWork(contextHook(), {
    ...unitOptions(sink, new MemoryStorage()),
    admits: (key: string) => !key.startsWith("auto-definitions/local"),
  } as CommitLogUnitOptions);
  await unit.stageOps([
    definition("auto-definitions/local.yaml"),
    definition("auto-definitions/shared.yaml"),
  ]);
  assertEquals(
    unit.stagedOps().map((c) => "put" in c ? c.put.key.toString() : ""),
    ["auto-definitions/shared.yaml"],
  );
  await unit.commit();
  assertEquals(sink.landed.length, 1);
});

Deno.test("createV3LockfileSync: the publish commits the lockfile at its root's checkpoint", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-lockfile-" });
  try {
    const configBase = join(dir, ".swamp", "config");
    await Deno.mkdir(configBase, { recursive: true });
    const lockfilePath = join(configBase, "upstream_extensions.json");
    await Deno.writeTextFile(lockfilePath, '{"@test/ext":{}}');
    const sink = new MemorySink();
    const hook = contextHook();
    const options = unitOptions(sink, new MemoryStorage());
    bindCommitLogEngine(hook, {
      openUnit: () =>
        createCommitLogUnitOfWork(hook, {
          ...options,
          parent: currentUnitOfWork(),
        }),
      hasOpenUnit: () =>
        commitLogParentFor(hook, currentUnitOfWork()) !== undefined,
      checkpointOpenUnit: () => Promise.resolve("no-unit"),
      committedBeforeThrowing: () => false,
      runRoot: (_rootOptions, fn) =>
        runInCommitLogRoot({ markDirty: hook }, options, (root) => fn(root)),
    });
    const sync = createV3LockfileSync({
      markDirty: hook,
      lockfilePath,
      configBase,
    });
    await runInRootUnitOfWork(
      { markDirty: hook },
      { flush: undefined, checkpoint: () => Promise.resolve() },
      () => sync.publish({ mustUpload: true, earlierChangeOnly: false }),
    );
    assertEquals(sink.landed.length, 1);
    const [op] = sink.landed[0].ops;
    assertEquals(
      "key" in op ? op.key.toString() : "",
      "config/upstream_extensions.json",
    );
    assertEquals(
      sink.landed[0].partition.toString(),
      "config--lockfile--upstream_extensions",
    );
    // Outside its transaction's root there is nowhere to publish to.
    await assertRejects(
      () => sync.publish({ mustUpload: true, earlierChangeOnly: false }),
      Error,
      "outside its transaction's root",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
