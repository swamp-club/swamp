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
import { processHostIdentity } from "../runtime/process.ts";
import {
  judgeRecorded,
  localProcess,
  probeProcess,
  setLocalProcessForTesting,
} from "./process_identity.ts";

const inspectable = Deno.build.os === "linux" || Deno.build.os === "darwin";

Deno.test("localProcess: names this process by its pid and host identity", async () => {
  const local = await localProcess();
  assertEquals(local.pid, Deno.pid);
  assertEquals(local.identity.host, processHostIdentity());
  assertEquals(await localProcess(), local);
});

Deno.test({
  name: "localProcess: records this process's start time where it can be read",
  ignore: !inspectable,
  async fn() {
    const local = await localProcess();
    assert(local.identity.startTime !== undefined);
    assertEquals(probeProcess(Deno.pid).startTime, local.identity.startTime);
  },
});

Deno.test("judgeRecorded: this process's own record is alive, and a predecessor's with its pid is gone", async () => {
  const { identity } = await localProcess();
  assertEquals(
    await judgeRecorded({ pid: Deno.pid, process: identity }),
    "alive",
  );
  assertEquals(
    await judgeRecorded({
      pid: Deno.pid,
      process: identity,
      notThisProcess: true,
    }),
    "gone",
  );
});

Deno.test("judgeRecorded: a pid no process has, on this kernel, is gone", async () => {
  const { identity } = await localProcess();
  assertEquals(
    await judgeRecorded({ pid: 2147483646, process: identity }),
    "gone",
  );
  assertEquals(probeProcess(2147483646), { present: false, zombie: false });
});

Deno.test("judgeRecorded: a record from another pid namespace is unknown, even naming a pid absent here", async () => {
  const { identity } = await localProcess();
  assertEquals(
    await judgeRecorded({
      pid: 2147483646,
      process: { ...identity, host: `${identity.host}#elsewhere` },
    }),
    "unknown",
  );
});

Deno.test("setLocalProcessForTesting: plays another process until cleared", async () => {
  const played = {
    pid: 7,
    identity: { host: "played" },
    probe: () => ({ present: true, zombie: false }),
    bootIdRequired: true,
  };
  setLocalProcessForTesting(played);
  try {
    assertEquals(await localProcess(), played);
  } finally {
    setLocalProcessForTesting(undefined);
  }
  assertEquals((await localProcess()).pid, Deno.pid);
});
