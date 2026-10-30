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
import { modelPartition } from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  heldServeLeaseOf,
  holdServeLease,
  leaseLockKeyOfPartition,
  raisedFloor,
  raiseServeLeaseFloor,
  resetServeLeasesForTesting,
} from "./serve_lease_registry.ts";

Deno.test("raisedFloor: a landed version raises its name's mark, adds a new name, and never lowers one (swamp-club#4121)", () => {
  assertEquals(
    raisedFloor(
      [{ name: "vpc", highWater: 3, removed: [[1, 1]] }, {
        name: "subnet",
        highWater: 9,
      }],
      [
        { name: "vpc", version: 4 },
        { name: "subnet", version: 2 },
        { name: "igw", version: 1 },
      ],
    ),
    [
      { name: "vpc", highWater: 4, removed: [[1, 1]] },
      { name: "subnet", highWater: 9 },
      { name: "igw", highWater: 1 },
    ],
  );
});

Deno.test("raiseServeLeaseFloor: raises only the lease still held under that id", () => {
  resetServeLeasesForTesting();
  const root = "/checkout/root";
  const partition = modelPartition();
  const lockKey = leaseLockKeyOfPartition(partition)!;
  holdServeLease(root, lockKey, {
    leaseId: "lease-1",
    fence: 2,
    floor: [{ name: "vpc", highWater: 3 }],
  });
  raiseServeLeaseFloor(root, partition, "lease-0", [
    { name: "vpc", version: 9 },
  ]);
  assertEquals(heldServeLeaseOf(root, partition)?.floor, [
    { name: "vpc", highWater: 3 },
  ]);
  raiseServeLeaseFloor(root, partition, "lease-1", [
    { name: "vpc", version: 4 },
  ]);
  assertEquals(heldServeLeaseOf(root, partition)?.floor, [
    { name: "vpc", highWater: 4 },
  ]);
  resetServeLeasesForTesting();
});
