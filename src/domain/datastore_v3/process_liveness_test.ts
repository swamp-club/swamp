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
import {
  judgeRecordedProcess,
  type LocalProcess,
  parseProcessIdentity,
  type ProcessIdentity,
  type ProcessProbe,
} from "./process_liveness.ts";

const HERE: ProcessIdentity = {
  host: "shared-host#pid:[4026531836]",
  bootId: "boot-id:aaaa",
  startTime: "linux-ticks:500",
};

function local(
  probes: Record<number, ProcessProbe> = {},
  identity: ProcessIdentity = HERE,
  bootIdRequired = true,
): LocalProcess {
  return {
    pid: 10,
    identity,
    probe: (pid) => probes[pid] ?? { present: false, zombie: false },
    bootIdRequired,
  };
}

const running = (startTime?: string): ProcessProbe => ({
  present: true,
  zombie: false,
  ...(startTime !== undefined ? { startTime } : {}),
});

Deno.test("judgeRecordedProcess: a record without an identity is unknown, whatever its pid here", () => {
  assertEquals(judgeRecordedProcess({ pid: 42 }, local()), "unknown");
  assertEquals(
    judgeRecordedProcess({ pid: 42 }, local({ 42: running("x") })),
    "unknown",
  );
});

Deno.test("judgeRecordedProcess: another pid namespace with the same hostname is unknown, not gone", () => {
  const other = { ...HERE, host: "shared-host#pid:[4026532001]" };
  assertEquals(
    judgeRecordedProcess({ pid: 42, process: other }, local()),
    "unknown",
  );
});

Deno.test("judgeRecordedProcess: another boot is unknown, never proof the writer is gone", () => {
  const rebooted = { ...HERE, bootId: "boot-id:bbbb" };
  assertEquals(
    judgeRecordedProcess({ pid: 42, process: rebooted }, local()),
    "unknown",
  );
  const { bootId: _, ...noBoot } = HERE;
  assertEquals(
    judgeRecordedProcess({ pid: 42, process: noBoot }, local()),
    "unknown",
  );
  assertEquals(
    judgeRecordedProcess({ pid: 42, process: HERE }, local({}, noBoot)),
    "unknown",
  );
});

Deno.test("judgeRecordedProcess: with no boot id on either side, the pid is judged only where the platform has none (Windows)", () => {
  const { bootId: _, ...noBoot } = HERE;
  const recorded = { pid: 42, process: noBoot };
  // Linux and macOS: two machines may share the hostname and the root pid
  // namespace's id, so nothing places the record on this kernel.
  assertEquals(judgeRecordedProcess(recorded, local({}, noBoot)), "unknown");
  assertEquals(
    judgeRecordedProcess(recorded, local({ 42: running() }, noBoot)),
    "unknown",
  );
  // Windows: the host and pid decide, as before.
  assertEquals(
    judgeRecordedProcess(recorded, local({}, noBoot, false)),
    "gone",
  );
  assertEquals(
    judgeRecordedProcess(recorded, local({ 42: running() }, noBoot, false)),
    "alive",
  );
});

Deno.test("judgeRecordedProcess: on this kernel an absent pid or a zombie is gone", () => {
  const recorded = { pid: 42, process: { ...HERE, startTime: "t1" } };
  assertEquals(judgeRecordedProcess(recorded, local()), "gone");
  assertEquals(
    judgeRecordedProcess(
      recorded,
      local({ 42: { present: true, zombie: true, startTime: "t1" } }),
    ),
    "gone",
  );
});

Deno.test("judgeRecordedProcess: a pid reused by a process started at another time is gone", () => {
  const recorded = { pid: 42, process: { ...HERE, startTime: "t1" } };
  assertEquals(
    judgeRecordedProcess(recorded, local({ 42: running("t2") })),
    "gone",
  );
  assertEquals(
    judgeRecordedProcess(recorded, local({ 42: running("t1") })),
    "alive",
  );
});

Deno.test("judgeRecordedProcess: with the start time unreadable on either side, presence decides", () => {
  const { startTime: _, ...noStart } = HERE;
  // Unreadable here (a failed probe, another user's process).
  const recorded = { pid: 42, process: { ...HERE, startTime: "t1" } };
  assertEquals(
    judgeRecordedProcess(recorded, local({ 42: running() })),
    "alive",
  );
  assertEquals(judgeRecordedProcess(recorded, local()), "gone");
  // Unreadable where the record was written (Windows, a failed own read).
  const unstamped = { pid: 42, process: noStart };
  assertEquals(
    judgeRecordedProcess(unstamped, local({ 42: running("t9") })),
    "alive",
  );
  assertEquals(judgeRecordedProcess(unstamped, local()), "gone");
});

Deno.test("judgeRecordedProcess: this process's pid is alive, unless the record is a predecessor's", () => {
  const mine = { pid: 10, process: HERE };
  assertEquals(judgeRecordedProcess(mine, local()), "alive");
  assertEquals(
    judgeRecordedProcess({ ...mine, notThisProcess: true }, local()),
    "gone",
  );
  assertEquals(
    judgeRecordedProcess(
      { pid: 10, process: { ...HERE, startTime: "linux-ticks:1" } },
      local(),
    ),
    "gone",
  );
});

Deno.test("parseProcessIdentity: reads the fields it knows and rejects malformed ones", () => {
  assertEquals(parseProcessIdentity(HERE), HERE);
  assertEquals(parseProcessIdentity({ host: "h", extra: 1 }), { host: "h" });
  assertEquals(parseProcessIdentity({ host: "" }), undefined);
  assertEquals(parseProcessIdentity({ host: "h", bootId: 3 }), undefined);
  assertEquals(parseProcessIdentity({ host: "x".repeat(1025) }), undefined);
  assertEquals(parseProcessIdentity("h"), undefined);
  assertEquals(parseProcessIdentity(null), undefined);
  assertEquals(parseProcessIdentity([HERE]), undefined);
});
