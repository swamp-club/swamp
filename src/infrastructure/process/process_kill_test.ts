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
import { isProcessAlive, killChildGroups } from "./process_kill.ts";

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
