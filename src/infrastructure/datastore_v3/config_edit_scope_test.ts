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

import { assertEquals } from "@std/assert";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import type { ConfigEditBases } from "../../domain/datastore_v3/config_edit_bases.ts";
import {
  ConfigChanges,
  recordKeyOf,
} from "../../domain/datastore_v3/repository_changes.ts";
import { MemoryStorage } from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  contextHook,
  MemorySink,
  unitOptions,
} from "./commit_log_test_helpers.ts";
import { createCommitLogUnitOfWork } from "./commit_log_unit_of_work.ts";
import { runAsUserConfigEdit } from "./config_edit_scope.ts";

const KEY = recordKeyOf(["config", "workflows", "workflow-deploy.yaml"]);
const STARTED = { sha256: "a".repeat(64) };
const ON_DISK = { sha256: "b".repeat(64) };

/** What the staged change expects, after a unit with `bases` staged it. */
async function stagedExpect(
  change: TypedChange,
  stage: (fn: () => Promise<void>) => Promise<void>,
): Promise<unknown> {
  const deploy = new ConfigChanges("workflow", "deploy").partition.toString();
  const bases: ConfigEditBases = {
    baseOf: (_ns, partition, key) =>
      partition === deploy && key === KEY.toString() ? STARTED : undefined,
    committed: () => {},
  };
  const unit = createCommitLogUnitOfWork(contextHook(), {
    ...unitOptions(new MemorySink(), new MemoryStorage()),
    configEditBases: bases,
  });
  await stage(() => unit.stageOps([change]));
  const [staged] = unit.stagedOps();
  await unit.abandon();
  return "put" in staged
    ? staged.put.expect
    : staged.op.kind === "tombstone"
    ? staged.op.expect
    : undefined;
}

const edit = () =>
  new ConfigChanges("workflow", "deploy").write(
    "definition.edit",
    KEY,
    new TextEncoder().encode("name: deploy\n"),
    ON_DISK,
  );
const remove = () =>
  new ConfigChanges("workflow", "deploy").remove(
    "definition.delete",
    KEY,
    ON_DISK,
  );
const plain = (fn: () => Promise<void>) => fn();

Deno.test("runAsUserConfigEdit: an edit expects the version the user started from", async () => {
  assertEquals(await stagedExpect(edit(), runAsUserConfigEdit), STARTED);
});

Deno.test("runAsUserConfigEdit: a delete expects the version the user started from", async () => {
  assertEquals(await stagedExpect(remove(), runAsUserConfigEdit), STARTED);
});

Deno.test("runAsUserConfigEdit: outside a user's edit (a system rewrite) the save-time version stands", async () => {
  assertEquals(await stagedExpect(edit(), plain), ON_DISK);
  assertEquals(await stagedExpect(remove(), plain), ON_DISK);
});

Deno.test("runAsUserConfigEdit: a create keeps expecting the key absent", async () => {
  const create = new ConfigChanges("workflow", "deploy").write(
    "definition.create",
    KEY,
    new TextEncoder().encode("name: deploy\n"),
    "absent",
  );
  assertEquals(await stagedExpect(create, runAsUserConfigEdit), "absent");
});

Deno.test("runAsUserConfigEdit: a record the user never held keeps the save-time version", async () => {
  const unit = createCommitLogUnitOfWork(contextHook(), {
    ...unitOptions(new MemorySink(), new MemoryStorage()),
    configEditBases: { baseOf: () => "absent", committed: () => {} },
  });
  await runAsUserConfigEdit(() => unit.stageOps([edit(), remove()]));
  assertEquals(
    unit.stagedOps().map((c) =>
      "put" in c
        ? c.put.expect
        : c.op.kind === "tombstone"
        ? c.op.expect
        : undefined
    ),
    [ON_DISK, ON_DISK],
  );
  await unit.abandon();
});
