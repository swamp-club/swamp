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
import { passOwnLockGate, setOwnLockGate } from "./own_lock_gate.ts";

Deno.test("passOwnLockGate: with no gate set, as in a CLI process, passes at once", async () => {
  await passOwnLockGate("data/aws-ec2/server-1/.lock", 0);
});

Deno.test("passOwnLockGate: asks the gate serve set for the key and the wait, and fails as it does", async () => {
  const asked: [string, number][] = [];
  setOwnLockGate((lockKey, maxWaitMs) => {
    asked.push([lockKey, maxWaitMs]);
    return lockKey.includes("busy")
      ? Promise.reject(new Error("pending"))
      : Promise.resolve();
  });
  try {
    await passOwnLockGate("data/aws-ec2/free/.lock", 50);
    await assertRejects(
      () => passOwnLockGate("data/aws-ec2/busy/.lock", 50),
      Error,
      "pending",
    );
    assertEquals(asked, [
      ["data/aws-ec2/free/.lock", 50],
      ["data/aws-ec2/busy/.lock", 50],
    ]);
  } finally {
    setOwnLockGate(undefined);
  }
});
