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
import { join } from "@std/path";
import { parsePsOutput, readLinuxProcesses } from "./process_list.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-proc-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function fakeProcess(
  root: string,
  pid: number,
  fields: { uid: number; ppid: number; exe?: string; comm: string },
): Promise<void> {
  const dir = join(root, String(pid));
  await Deno.mkdir(dir);
  await Deno.writeTextFile(
    join(dir, "status"),
    `Name:\t${fields.comm}\nPPid:\t${fields.ppid}\nUid:\t${fields.uid}\t${fields.uid}\t${fields.uid}\t${fields.uid}\n`,
  );
  await Deno.writeTextFile(join(dir, "comm"), `${fields.comm}\n`);
  if (fields.exe !== undefined) {
    await Deno.symlink(fields.exe, join(dir, "exe"), { type: "file" });
  }
}

Deno.test({
  name:
    "readLinuxProcesses: reads the user's own processes by executable name, falling back to comm",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      await fakeProcess(root, 10, {
        uid: 1000,
        ppid: 1,
        exe: "/usr/libexec/gnome-terminal-server",
        comm: "gnome-terminal-",
      });
      await fakeProcess(root, 11, {
        uid: 1000,
        ppid: 10,
        exe: "/usr/bin/foot (deleted)",
        comm: "foot",
      });
      await fakeProcess(root, 12, { uid: 1000, ppid: 10, comm: "bash" });
      await fakeProcess(root, 13, { uid: 0, ppid: 1, comm: "sshd" });
      await Deno.mkdir(join(root, "self"));
      await Deno.mkdir(join(root, "99"));
      const found = await readLinuxProcesses(root, 1000);
      assertEquals(found.sort((a, b) => a.pid - b.pid), [
        { pid: 10, ppid: 1, name: "gnome-terminal-server" },
        { pid: 11, ppid: 10, name: "foot" },
        { pid: 12, ppid: 10, name: "bash" },
      ]);
    });
  },
});

Deno.test("readLinuxProcesses: a missing proc folder reads as no processes", async () => {
  assertEquals(await readLinuxProcesses("/no/such/proc", 1000), []);
});

Deno.test("parsePsOutput: takes the executable's file name, spaces in the path included", () => {
  assertEquals(
    parsePsOutput(
      [
        "  11792     1 /Applications/Ghostty.app/Contents/MacOS/ghostty",
        "    501   499 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
        "    600   501 /Applications/My Apps/iTerm.app/Contents/MacOS/iTerm2",
        "    601   600 -zsh",
        "garbage",
        "",
      ].join("\n"),
    ),
    [
      { pid: 11792, ppid: 1, name: "ghostty" },
      { pid: 501, ppid: 499, name: "Terminal" },
      { pid: 600, ppid: 501, name: "iTerm2" },
      { pid: 601, ppid: 600, name: "-zsh" },
    ],
  );
});
