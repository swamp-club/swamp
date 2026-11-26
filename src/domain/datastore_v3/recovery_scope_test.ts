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

import { assert, assertEquals } from "@std/assert";
import { PartitionKey, partitionOf } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";
import {
  dataNameOfKey,
  dataNamePrefix,
  keyBindsToPartition,
  RecoveryScope,
} from "./recovery_scope.ts";
import { MODEL_ID, MODEL_TYPE, modelPartition } from "./v3_test_helpers.ts";

Deno.test("dataNameOfKey: the model id is the first UUID segment, so a type may hold slashes", () => {
  assertEquals(
    dataNameOfKey(`data/@swamp/aws/ec2/${MODEL_ID}/vpc/3/raw`),
    { type: "@swamp/aws/ec2", modelId: MODEL_ID, name: "vpc" },
  );
  assertEquals(dataNameOfKey(`data/t/${MODEL_ID}/vpc`), {
    type: "t",
    modelId: MODEL_ID,
    name: "vpc",
  });
  assertEquals(dataNameOfKey(`workflow-runs/${MODEL_ID}/x`), undefined);
  assertEquals(dataNameOfKey(`data/t/${MODEL_ID}`), undefined);
  assertEquals(dataNameOfKey("data/t/not-a-uuid/vpc/1/raw"), undefined);
});

Deno.test("RecoveryScope: groups names by namespace and partition, and touches the name of every key it checks or removes", () => {
  const scope = new RecoveryScope();
  const type = MODEL_TYPE.normalized;
  scope.addName({ namespace: "", type, modelId: MODEL_ID, name: "a" });
  scope.addKeyToCheck("", `data/${type}/${MODEL_ID}/b/1/raw`);
  scope.addRemoval("", `data/${type}/${MODEL_ID}/c/2/raw`, "/x/c");
  scope.addKeyToCheck("", "workflow-runs/w/r.yaml");
  scope.addName({ namespace: "ns", type, modelId: MODEL_ID, name: "a" });
  assertEquals(scope.unscopable, undefined);
  assertEquals(scope.partitions().map((p) => [p.namespace, p.names]), [
    ["", ["a", "b", "c"]],
    ["ns", ["a"]],
  ]);
  assert(scope.partitions()[0].partition.equals(modelPartition()));
  assertEquals(scope.nameCount, 4);
  assertEquals(scope.partitionCount, 2);
  assertEquals(scope.keysToCheckCount, 2);
  assertEquals(scope.removals(), [{
    namespace: "",
    key: `data/${type}/${MODEL_ID}/c/2/raw`,
    path: "/x/c",
  }]);
  assertEquals(
    dataNamePrefix({ namespace: "", type, modelId: MODEL_ID, name: "a" }),
    `data/${type}/${MODEL_ID}/a`,
  );
});

Deno.test("RecoveryScope: a dirty name of no valid model partition makes the scope unusable", () => {
  const scope = new RecoveryScope();
  assertEquals(
    scope.addName({
      namespace: "",
      type: "Not A Type",
      modelId: MODEL_ID,
      name: "a",
    }),
    false,
  );
  assert(scope.unscopable !== undefined);
});

Deno.test("PartitionKey.forModel: builds the key partitionOf builds, and refuses a type that is not normalized", () => {
  assert(
    PartitionKey.forModel(MODEL_TYPE.normalized, MODEL_ID).equals(
      modelPartition(),
    ),
  );
  let refused = false;
  try {
    PartitionKey.forModel("Not A Type", MODEL_ID);
  } catch {
    refused = true;
  }
  assert(refused);
});

Deno.test("RecoveryScope: a key a live writer covers is skipped, and counts as left to it only when the interrupted writer recorded it too", () => {
  const live = `data/${MODEL_TYPE.normalized}/${MODEL_ID}/live`;
  const dead = `data/${MODEL_TYPE.normalized}/${MODEL_ID}/dead`;
  const kept = (_ns: string, key: string) => key.startsWith(live);
  const scope = new RecoveryScope(kept, (_ns, key) => key.startsWith(dead));
  scope.addRemoval("", `${live}/1/raw`, "/c/live-raw");
  scope.addKeyToCheck("", `${live}/latest`);
  assertEquals(scope.removals(), []);
  assertEquals(scope.keysToCheck(), []);
  assertEquals(scope.leftToLiveWriters, false, "the live writer's own work");
  scope.addRemoval("", `${dead}/2/raw`, "/c/dead-raw");
  assertEquals(scope.leftToLiveWriters, false, "not covered by a live writer");
  assertEquals(scope.removals().length, 1);

  const overlapping = new RecoveryScope(
    (_ns, key) => key.startsWith(dead),
    (_ns, key) => key.startsWith(dead),
  );
  overlapping.addRemoval("", `${dead}/2/raw`, "/c/dead-raw");
  assertEquals(overlapping.removals(), []);
  assertEquals(
    overlapping.leftToLiveWriters,
    true,
    "the interrupted writer's file sits where a live writer journaled",
  );
});

Deno.test("RecoveryScope: a name any writer may have changed is skipped quietly when a live writer covers it", () => {
  const name = {
    namespace: "",
    type: MODEL_TYPE.normalized,
    modelId: MODEL_ID,
    name: "shared",
  };
  const covered = () => true;
  const others = new RecoveryScope(covered, covered);
  assertEquals(others.addName(name, { others: true }), true);
  assertEquals(others.names(), []);
  assertEquals(others.leftToLiveWriters, false);

  const own = new RecoveryScope(covered, covered);
  assertEquals(own.addName(name), true);
  assertEquals(own.names(), []);
  assertEquals(own.leftToLiveWriters, true);
});

const WORKFLOW_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const RUN_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const OTHER_ID = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";

Deno.test("keyBindsToPartition: a model partition binds its own aggregate's keys only", () => {
  const partition = modelPartition();
  const own = `data/${MODEL_TYPE.normalized}/${MODEL_ID}/out/1/raw`;
  const other = `data/${MODEL_TYPE.normalized}/${OTHER_ID}/out/1/raw`;
  assertEquals(keyBindsToPartition(partition, RecordKey.create(own)), true);
  assertEquals(keyBindsToPartition(partition, RecordKey.create(other)), false);
});

Deno.test("keyBindsToPartition: a run partition binds its own run's record, step starts and snapshot, not another run's", () => {
  const partition = partitionOf({
    kind: "run",
    workflowId: WORKFLOW_ID,
    runId: RUN_ID,
  });
  const start = `${"a".repeat(64)}.yaml`;
  const own = [
    `workflow-runs/${WORKFLOW_ID}/workflow-run-${RUN_ID}.yaml`,
    `workflow-runs/${WORKFLOW_ID}/starts/${RUN_ID}/${start}`,
    `workflows-evaluated/runs/${RUN_ID}/evaluated-workflow.yaml`,
  ];
  for (const key of own) {
    assertEquals(keyBindsToPartition(partition, RecordKey.create(key)), true);
  }
  const others = [
    `workflow-runs/${WORKFLOW_ID}/workflow-run-${OTHER_ID}.yaml`,
    `workflow-runs/${OTHER_ID}/workflow-run-${RUN_ID}.yaml`,
    `workflow-runs/${WORKFLOW_ID}/starts/${OTHER_ID}/${start}`,
    `workflows-evaluated/runs/${OTHER_ID}/evaluated-workflow.yaml`,
    `data/${MODEL_TYPE.normalized}/${MODEL_ID}/out/1/raw`,
  ];
  for (const key of others) {
    assertEquals(keyBindsToPartition(partition, RecordKey.create(key)), false);
  }
});

Deno.test("keyBindsToPartition: a config partition binds nothing", () => {
  const partition = partitionOf({
    kind: "config",
    definitionKind: "workflow",
    name: "deploy",
  });
  assertEquals(
    keyBindsToPartition(
      partition,
      RecordKey.create(`workflows/workflow-${WORKFLOW_ID}.yaml`),
    ),
    false,
  );
});
