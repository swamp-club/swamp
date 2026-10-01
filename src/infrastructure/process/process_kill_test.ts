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
import { waitFor } from "@swamp-club/swamp-testing";
import {
  isProcessAlive,
  killChildGroups,
  killProcessTree,
  withoutReusedPids,
} from "./process_kill.ts";

Deno.test({
  name: "killChildGroups: SIGKILLs the whole group a child leads",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const pidFile = await Deno.makeTempFile({ prefix: "swamp-pid-" });
    const readPid = async () =>
      Number((await Deno.readTextFile(pidFile)).trim());
    const child = new Deno.Command("sh", {
      args: ["-c", `sleep 30 & echo $! > '${pidFile}'; wait`],
      stdout: "null",
      stderr: "null",
      detached: true,
    }).spawn();
    try {
      await waitFor(
        () => readPid().then((pid) => pid > 0, () => false),
        "grandchild pid file",
      );

      killChildGroups([child.pid]);

      const status = await child.status;
      assertEquals(status.signal, "SIGKILL");
      const grandchild = await readPid();
      await waitFor(
        () => !isProcessAlive(grandchild),
        "grandchild to be SIGKILLed",
      );
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
      await child.status;
      const pid = await readPid().catch(() => 0);
      if (pid > 0) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch { /* already gone */ }
      }
      await Deno.remove(pidFile).catch(() => {});
    }
  },
});

Deno.test({
  name: "killChildGroups: ignores a child that does not lead a group",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const child = new Deno.Command("sleep", {
      args: ["30"],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      killChildGroups([child.pid]);
      assert(isProcessAlive(child.pid), "non-leader child should be untouched");
    } finally {
      child.kill("SIGKILL");
      await child.status;
    }
  },
});

Deno.test({
  name:
    "killProcessTree: kills a child the owner started while handling SIGTERM",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const pidFile = await Deno.makeTempFile({ prefix: "swamp-pid-" });
    const readPid = async () =>
      Number((await Deno.readTextFile(pidFile)).trim());
    // Stands in for a run owner that starts a cleanup step on SIGTERM and
    // outlives the wait. `$0` names it as a swamp process for the PID check.
    const owner = new Deno.Command("sh", {
      args: [
        "-c",
        `trap 'sleep 30 & echo $! > "${pidFile}"' TERM; echo ready > "${pidFile}"; while :; do sleep 0.1; done`,
        "swamp-owner",
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await waitFor(
        () =>
          Deno.readTextFile(pidFile).then(
            (text) => text.trim() === "ready",
            () => false,
          ),
        "owner to trap SIGTERM",
      );

      assert(await killProcessTree(owner.pid, { maxWaitMs: 1000 }));

      const status = await owner.status;
      assertEquals(status.signal, "SIGKILL");
      const cleanup = await readPid();
      assert(cleanup > 0, "owner should have started its cleanup child");
      await waitFor(
        () => !isProcessAlive(cleanup),
        "cleanup child to be SIGKILLed",
      );
    } finally {
      try {
        owner.kill("SIGKILL");
      } catch { /* already gone */ }
      await owner.status;
      const pid = await readPid().catch(() => 0);
      if (pid > 0) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch { /* already gone */ }
      }
      await Deno.remove(pidFile).catch(() => {});
    }
  },
});

Deno.test("withoutReusedPids: drops a pid that now belongs to another process", () => {
  const before = new Map([[10, "Thu Oct  1 12:00:00 2026"], [
    11,
    "Thu Oct  1 12:00:01 2026",
  ]]);
  const after = new Map([[10, "Thu Oct  1 12:00:00 2026"], [
    11,
    "Thu Oct  1 12:00:40 2026",
  ]]);
  assertEquals(withoutReusedPids([10, 11], before, after), [10]);
});

Deno.test("withoutReusedPids: keeps a pid that no longer exists, for its process group", () => {
  const before = new Map([[10, "Thu Oct  1 12:00:00 2026"]]);
  assertEquals(withoutReusedPids([10], before, new Map()), [10]);
});

Deno.test("withoutReusedPids: drops a pid that was gone at the snapshot and is running now", () => {
  const after = new Map([[10, "Thu Oct  1 12:00:40 2026"]]);
  assertEquals(withoutReusedPids([10], new Map(), after), []);
});

Deno.test("withoutReusedPids: keeps every pid when start times are unavailable", () => {
  const starts = new Map([[10, "Thu Oct  1 12:00:00 2026"]]);
  assertEquals(withoutReusedPids([10, 11], undefined, starts), [10, 11]);
  assertEquals(withoutReusedPids([10, 11], starts, undefined), [10, 11]);
});
