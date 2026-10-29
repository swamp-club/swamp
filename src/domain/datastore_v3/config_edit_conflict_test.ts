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
  assert,
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
} from "@std/assert";
import { messageFor } from "../behavior_wording.ts";
import { UserError } from "../errors.ts";
import {
  type PartitionRefusal,
  PartitionsRefusedError,
} from "./commit_log_unit_of_work.ts";
import { configEditConflictOf } from "./config_edit_conflict.ts";
import { type AggregateIdentity, partitionOf } from "./partition_key.ts";

function refusal(
  identity: AggregateIdentity,
  overrides: Partial<PartitionRefusal> = {},
): PartitionRefusal {
  return {
    partition: partitionOf(identity),
    reason: "expect-failed",
    message: "refused",
    key: "config/workflows/workflow-deploy.yaml",
    changedBy: "alice",
    changedAt: "2026-10-29T10:00:00.000Z",
    versions: [],
    ...overrides,
  };
}

const DEPLOY = {
  kind: "config",
  definitionKind: "workflow",
  name: "deploy",
} as const;

Deno.test("configEditConflictOf: a refused definition edit is a user error naming it, who and when, and how to retry", () => {
  const conflict = configEditConflictOf(
    new PartitionsRefusedError([refusal(DEPLOY)], []),
  );
  assertInstanceOf(conflict, UserError);
  assertEquals(conflict.code, "config_edit_conflict");
  assertEquals(conflict.conflicts, [{
    kind: "workflow",
    name: "deploy",
    key: "config/workflows/workflow-deploy.yaml",
    changedBy: "alice",
    changedAt: "2026-10-29T10:00:00.000Z",
  }]);
  assertStringIncludes(
    conflict.message,
    "Workflow 'deploy' was changed by alice at 2026-10-29T10:00:00.000Z",
  );
  assertStringIncludes(conflict.message, "re-apply your change");
  assertStringIncludes(conflict.message, "'swamp workflow get deploy'");
});

Deno.test("configEditConflictOf: a behavior reads as a model under the model surface", () => {
  const conflict = configEditConflictOf(
    new PartitionsRefusedError([
      refusal({ kind: "config", definitionKind: "model", name: "vpc" }),
    ], []),
  )!;
  assertStringIncludes(messageFor(conflict, "behavior"), "Behavior 'vpc'");
  assertStringIncludes(
    messageFor(conflict, "behavior"),
    "swamp behavior get vpc",
  );
  assertStringIncludes(messageFor(conflict, "model"), "Model 'vpc'");
  assertStringIncludes(messageFor(conflict, "model"), "swamp model get vpc");
});

Deno.test("configEditConflictOf: a refused lockfile publish says to pull and retry", () => {
  const conflict = configEditConflictOf(
    new PartitionsRefusedError([
      refusal({ kind: "lockfile" }, {
        key: "config/upstream_extensions.json",
      }),
    ], []),
  )!;
  assertEquals(conflict.conflicts[0].kind, "lockfile");
  assertStringIncludes(
    conflict.message,
    "changed in another checkout (by alice at 2026-10-29T10:00:00.000Z)",
  );
  assertStringIncludes(conflict.message, "Pull and retry");
});

Deno.test("configEditConflictOf: who and when are left out when history no longer tells", () => {
  const conflict = configEditConflictOf(
    new PartitionsRefusedError([
      refusal(DEPLOY, { changedBy: undefined, changedAt: undefined }),
    ], []),
  )!;
  assertStringIncludes(conflict.message, "Workflow 'deploy' was changed after");
});

Deno.test("configEditConflictOf: a refusal wrapped as another error's cause is found", () => {
  const wrapped = new Error("publish failed", {
    cause: new PartitionsRefusedError([refusal(DEPLOY)], []),
  });
  assert(configEditConflictOf(wrapped) !== undefined);
});

Deno.test("configEditConflictOf: any other refusal is not an edit conflict", () => {
  assertEquals(configEditConflictOf(new Error("boom")), undefined);
  assertEquals(
    configEditConflictOf(
      new PartitionsRefusedError([refusal(DEPLOY, { reason: "seq-gap" })], []),
    ),
    undefined,
  );
  assertEquals(
    configEditConflictOf(
      new PartitionsRefusedError([
        refusal({ kind: "definition", id: crypto.randomUUID() }),
      ], []),
    ),
    undefined,
  );
  // An edit conflict mixed with another refusal is left as it is.
  assertEquals(
    configEditConflictOf(
      new PartitionsRefusedError([
        refusal(DEPLOY),
        refusal(DEPLOY, { reason: "version-live" }),
      ], []),
    ),
    undefined,
  );
});
