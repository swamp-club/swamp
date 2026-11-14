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
import { orderTerminals, type PlannedTerminal } from "./terminal_choice.ts";
import type { ProcessInfo } from "./terminal_launcher.ts";

const SCRIPT = "/ws/.swamp/start/launch.command";
const FIXED = [
  "ptyxis",
  "kgx",
  "gnome-terminal",
  "konsole",
  "xfce4-terminal",
  "ghostty",
  "kitty",
  "alacritty",
  "wezterm",
  "foot",
];

function names(planned: readonly PlannedTerminal[]): string[] {
  return planned.map((p) => p.name);
}

function linux(
  extra: { terminalVar?: string; processes?: ProcessInfo[]; selfPid?: number } =
    {},
): PlannedTerminal[] {
  return orderTerminals({
    os: "linux",
    scriptPath: SCRIPT,
    processes: extra.processes ?? [],
    selfPid: extra.selfPid ?? 100,
    ...(extra.terminalVar !== undefined
      ? { terminalVar: extra.terminalVar }
      : {}),
  });
}

Deno.test("orderTerminals: on Linux with nothing detected uses the configured defaults, then the fixed list", () => {
  assertEquals(names(linux()), [
    "xdg-terminal-exec",
    "x-terminal-emulator",
    ...FIXED,
  ]);
  assertEquals(linux().every((p) => p.chosen === "default" && p.resolve), true);
});

Deno.test("orderTerminals: each Linux terminal gets the arguments that run the script", () => {
  const args = Object.fromEntries(linux().map((p) => [p.name, p.args]));
  assertEquals(args, {
    "xdg-terminal-exec": [SCRIPT],
    "x-terminal-emulator": ["-e", SCRIPT],
    ptyxis: ["--new-window", "--", SCRIPT],
    kgx: ["--", SCRIPT],
    "gnome-terminal": ["--", SCRIPT],
    konsole: ["-e", SCRIPT],
    "xfce4-terminal": ["-x", SCRIPT],
    ghostty: ["-e", SCRIPT],
    kitty: [SCRIPT],
    alacritty: ["-e", SCRIPT],
    wezterm: ["start", "--", SCRIPT],
    foot: [SCRIPT],
  });
});

Deno.test("orderTerminals: TERMINAL comes first, with its own flag when it is a known terminal", () => {
  const known = linux({ terminalVar: "/usr/bin/ptyxis" });
  assertEquals(known[0], {
    name: "/usr/bin/ptyxis",
    command: "/usr/bin/ptyxis",
    args: ["--new-window", "--", SCRIPT],
    chosen: "set",
    resolve: true,
  });
  assertEquals(names(known).includes("ptyxis"), false);
  assertEquals(linux({ terminalVar: "xdg-terminal-exec" })[0].args, [SCRIPT]);
  const unknown = linux({ terminalVar: "my-term" });
  assertEquals(unknown[0].args, ["-e", SCRIPT]);
  assertEquals(names(unknown).length, FIXED.length + 3);
});

Deno.test("orderTerminals: an empty TERMINAL is ignored", () => {
  assertEquals(names(linux({ terminalVar: "  " }))[0], "xdg-terminal-exec");
});

Deno.test("orderTerminals: the terminal swamp start runs in comes after TERMINAL", () => {
  const planned = linux({
    terminalVar: "alacritty",
    selfPid: 30,
    processes: [
      { pid: 10, ppid: 1, name: "ptyxis-agent" },
      { pid: 20, ppid: 10, name: "bash" },
      { pid: 30, ppid: 20, name: "swamp" },
    ],
  });
  assertEquals(names(planned).slice(0, 3), [
    "alacritty",
    "ptyxis",
    "xdg-terminal-exec",
  ]);
  assertEquals(planned[1].chosen, "running_here");
});

Deno.test("orderTerminals: open terminals come after xdg-terminal-exec and before x-terminal-emulator, newest first", () => {
  // a multiplexer daemon parented to init breaks the chain to the terminal
  const planned = linux({
    selfPid: 30,
    processes: [
      { pid: 5, ppid: 1, name: "tmux" },
      { pid: 30, ppid: 5, name: "swamp" },
      { pid: 400, ppid: 1, name: "foot" },
      { pid: 900, ppid: 1, name: "wezterm-gui" },
      { pid: 12, ppid: 1, name: "gnome-terminal-" },
    ],
  });
  assertEquals(names(planned).slice(0, 5), [
    "xdg-terminal-exec",
    "wezterm",
    "foot",
    "gnome-terminal",
    "x-terminal-emulator",
  ]);
  assertEquals(planned.slice(1, 4).every((p) => p.chosen === "open"), true);
  assertEquals(new Set(names(planned)).size, planned.length);
});

Deno.test("orderTerminals: the ancestry walk stops after a bounded number of steps", () => {
  const processes: ProcessInfo[] = [{ pid: 2, ppid: 1, name: "kitty" }];
  for (let pid = 3; pid < 60; pid++) {
    processes.push({ pid, ppid: pid - 1, name: "sh" });
  }
  const planned = linux({ selfPid: 59, processes });
  // too deep to count as running here, but kitty is still open
  assertEquals(planned.find((p) => p.name === "kitty")?.chosen, "open");
});

Deno.test("orderTerminals: on macOS the running terminal goes before open ones and the default handler", () => {
  const planned = orderTerminals({
    os: "darwin",
    scriptPath: SCRIPT,
    selfPid: 30,
    processes: [
      { pid: 11, ppid: 1, name: "ghostty" },
      { pid: 10, ppid: 1, name: "Terminal" },
      { pid: 20, ppid: 10, name: "login" },
      { pid: 25, ppid: 20, name: "zsh" },
      { pid: 30, ppid: 25, name: "swamp" },
    ],
  });
  assertEquals(planned.map((p) => [p.name, p.chosen, p.command, p.args]), [
    ["Terminal", "running_here", "open", ["-a", "Terminal", SCRIPT]],
    ["Ghostty", "open", "open", ["-na", "Ghostty", "--args", "-e", SCRIPT]],
    ["the default app for .command files", "default", "open", [SCRIPT]],
  ]);
  assertEquals(planned.every((p) => !p.resolve), true);
});

Deno.test("orderTerminals: on macOS with nothing detected keeps today's default handler", () => {
  const planned = orderTerminals({
    os: "darwin",
    scriptPath: SCRIPT,
    selfPid: 1,
    processes: [],
    terminalVar: "kitty",
  });
  assertEquals(planned.map((p) => p.args), [[SCRIPT]]);
});
