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
import { PartitionKey } from "./partition_key.ts";
import {
  dataNameOfKey,
  dataNamePrefix,
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
