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
import { ModelType } from "../models/model_type.ts";
import { partitionOf } from "./partition_key.ts";
import { commitEffectOf, commitEffectsOf } from "./commit_effects.ts";

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

Deno.test("commitEffectOf: names what a commit to each kind of partition changes", () => {
  assertEquals(
    commitEffectOf(
      partitionOf({ kind: "config", definitionKind: "workflow", name: "w" }),
    ),
    "config",
  );
  assertEquals(commitEffectOf(partitionOf({ kind: "lockfile" })), "lockfile");
  assertEquals(
    commitEffectOf(
      partitionOf({
        kind: "model",
        type: ModelType.create("swamp/grant"),
        id: ID,
      }),
    ),
    "access",
  );
  assertEquals(
    commitEffectOf(
      partitionOf({
        kind: "model",
        type: ModelType.create("swamp/server-token"),
        id: ID,
      }),
    ),
    "access",
  );
  assertEquals(
    commitEffectOf(
      partitionOf({
        kind: "model",
        type: ModelType.create("@swamp/aws-ec2"),
        id: ID,
      }),
    ),
    "runtime",
  );
  assertEquals(
    commitEffectOf(partitionOf({ kind: "run", workflowId: ID, runId: ID })),
    "runtime",
  );
  assertEquals(
    commitEffectOf(partitionOf({ kind: "definition", id: ID })),
    "runtime",
  );
});

Deno.test("commitEffectsOf: each effect once", () => {
  const model = partitionOf({
    kind: "model",
    type: ModelType.create("swamp/grant"),
    id: ID,
  });
  assertEquals(
    [...commitEffectsOf([model, model, partitionOf({ kind: "lockfile" })])],
    ["access", "lockfile"],
  );
});
