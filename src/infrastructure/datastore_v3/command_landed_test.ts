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
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  commandLanded,
  commandMayHaveLanded,
  intentKindsOfOps,
  noteCommandLanded,
  noteCommandMayHaveLanded,
  resetCommandLandedForTesting,
} from "./command_landed.ts";

const SHELL = partitionOf({
  kind: "model",
  type: ModelType.create("command/shell"),
  id: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a81",
});
const WORKFLOW = partitionOf({
  kind: "model",
  type: ModelType.create("workflow"),
  id: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a82",
});
const RUN = partitionOf({
  kind: "run",
  workflowId: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a82",
  runId: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a83",
});
const CONFIG = partitionOf({
  kind: "config",
  definitionKind: "workflow",
  name: "deploy",
});

function landedAfter(note: () => void): boolean {
  resetCommandLandedForTesting();
  note();
  return commandLanded();
}

Deno.test("noteCommandLanded: a run's bookkeeping does not count, a behavior's data does", () => {
  assertEquals(
    landedAfter(() =>
      noteCommandLanded(SHELL, ["evaluated-definition.save", "output.save"])
    ),
    false,
  );
  assertEquals(landedAfter(() => noteCommandLanded(SHELL, [])), false);
  assertEquals(
    landedAfter(() => noteCommandLanded(CONFIG, ["evaluated-workflow.save"])),
    false,
  );
  assertEquals(
    landedAfter(() => noteCommandLanded(RUN, ["data.save"])),
    false,
  );
  assertEquals(
    landedAfter(() => noteCommandLanded(WORKFLOW, ["data.save"])),
    false,
  );
  assertEquals(
    landedAfter(() => noteCommandLanded(SHELL, ["output.save", "data.save"])),
    true,
  );
  assertEquals(
    landedAfter(() => noteCommandLanded(CONFIG, ["definition.edit"])),
    true,
  );
  assertEquals(
    landedAfter(() => noteCommandLanded(SHELL, [undefined])),
    true,
  );
});

Deno.test("noteCommandMayHaveLanded: an unknown outcome with effects counts, as landed and as may-have-landed", () => {
  resetCommandLandedForTesting();
  noteCommandMayHaveLanded(SHELL, ["data.save"]);
  assertEquals(commandLanded(), true);
  assertEquals(commandMayHaveLanded(), true);
  resetCommandLandedForTesting();
  assertEquals(commandMayHaveLanded(), false);
});

Deno.test("noteCommandMayHaveLanded: bookkeeping and run checkpoints are filtered as noteCommandLanded filters them", () => {
  for (
    const [partition, kinds] of [
      [RUN, ["run.update"]],
      [RUN, ["data.save"]],
      [WORKFLOW, ["data.save"]],
      [SHELL, ["output.save", "evaluated-definition.save"]],
      [SHELL, []],
    ] as const
  ) {
    resetCommandLandedForTesting();
    noteCommandMayHaveLanded(partition, kinds);
    assertEquals(commandMayHaveLanded(), false, `${partition} ${kinds}`);
    assertEquals(commandLanded(), false, `${partition} ${kinds}`);
  }
  resetCommandLandedForTesting();
});

Deno.test("commandMayHaveLanded: a confirmed landing alone is not a may-have-landed", () => {
  resetCommandLandedForTesting();
  noteCommandLanded(SHELL, ["data.save"]);
  assertEquals(commandLanded(), true);
  assertEquals(commandMayHaveLanded(), false);
  resetCommandLandedForTesting();
});

Deno.test("intentKindsOfOps: data-version and lease ops name no intent by design and drop out; another intent-less op counts as an effect", () => {
  assertEquals(
    intentKindsOfOps([
      { kind: "put", intent: { kind: "data.save" } },
      { kind: "data-version" },
      { kind: "lease" },
      { kind: "tombstone", intent: { kind: "output.delete" } },
    ]),
    ["data.save", "output.delete"],
  );
  assertEquals(intentKindsOfOps([{ kind: "some-new-op" }]), [undefined]);
  assertEquals(
    landedAfter(() =>
      noteCommandLanded(
        SHELL,
        intentKindsOfOps([
          { kind: "put", intent: { kind: "output.save" } },
          { kind: "data-version" },
        ]),
      )
    ),
    false,
  );
});
