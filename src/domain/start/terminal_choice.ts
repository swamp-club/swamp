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

import { basename } from "@std/path";
import type { ProcessInfo, TerminalChoice } from "./terminal_launcher.ts";

interface TerminalEntry {
  /** the name shown in the failure line, and on Linux the name on PATH */
  readonly name: string;
  /** executable file names that show this terminal is running, lower case */
  readonly processNames: readonly string[];
  readonly command: string;
  readonly args: (script: string) => readonly string[];
}

export interface PlannedTerminal {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly chosen: TerminalChoice;
  /** resolved on PATH before it is run; false for macOS's open */
  readonly resolve: boolean;
}

const linux = (
  name: string,
  processNames: readonly string[],
  args: (script: string) => readonly string[],
): TerminalEntry => ({ name, processNames, command: name, args });

const LINUX_XDG_TERMINAL_EXEC = linux("xdg-terminal-exec", [], (s) => [s]);
const LINUX_X_TERMINAL_EMULATOR = linux(
  "x-terminal-emulator",
  [],
  (s) => ["-e", s],
);

/** after the configured defaults, in the order they are tried */
const LINUX_TERMINALS: readonly TerminalEntry[] = [
  linux("ptyxis", ["ptyxis", "ptyxis-agent"], (s) => ["--new-window", "--", s]),
  linux("kgx", ["kgx"], (s) => ["--", s]),
  linux(
    "gnome-terminal",
    ["gnome-terminal", "gnome-terminal-server"],
    (s) => ["--", s],
  ),
  linux("konsole", ["konsole"], (s) => ["-e", s]),
  linux("xfce4-terminal", ["xfce4-terminal"], (s) => ["-x", s]),
  linux("ghostty", ["ghostty"], (s) => ["-e", s]),
  linux("kitty", ["kitty"], (s) => [s]),
  linux("alacritty", ["alacritty"], (s) => ["-e", s]),
  linux("wezterm", ["wezterm", "wezterm-gui"], (s) => ["start", "--", s]),
  linux("foot", ["foot", "footclient"], (s) => [s]),
];

const ALL_LINUX = [
  LINUX_XDG_TERMINAL_EXEC,
  LINUX_X_TERMINAL_EMULATOR,
  ...LINUX_TERMINALS,
];

/** only terminals checked on a Mac; any other falls to the default handler */
const MACOS_TERMINALS: readonly TerminalEntry[] = [
  {
    name: "Terminal",
    processNames: ["terminal"],
    command: "open",
    args: (s) => ["-a", "Terminal", s],
  },
  {
    name: "Ghostty",
    processNames: ["ghostty"],
    command: "open",
    args: (s) => ["-na", "Ghostty", "--args", "-e", s],
  },
];

export const MAX_ANCESTRY_STEPS = 32;

/** comm-style names are cut to 15 characters */
const COMM_LENGTH = 15;

function matches(entry: TerminalEntry, processName: string): boolean {
  const name = processName.toLowerCase();
  return entry.processNames.some((p) =>
    p === name || (name.length === COMM_LENGTH && p.startsWith(name))
  );
}

function entryFor(
  entries: readonly TerminalEntry[],
  processName: string,
): TerminalEntry | undefined {
  return entries.find((e) => matches(e, processName));
}

function terminalRunningHere(
  entries: readonly TerminalEntry[],
  processes: readonly ProcessInfo[],
  selfPid: number,
): TerminalEntry | undefined {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  let pid = selfPid;
  for (let step = 0; step < MAX_ANCESTRY_STEPS && pid > 1; step++) {
    const process = byPid.get(pid);
    if (process === undefined) return undefined;
    const entry = entryFor(entries, process.name);
    if (entry !== undefined) return entry;
    pid = process.ppid;
  }
  return undefined;
}

/** a higher pid stands in for a more recently started process */
function openTerminals(
  entries: readonly TerminalEntry[],
  processes: readonly ProcessInfo[],
): TerminalEntry[] {
  const newest = new Map<TerminalEntry, number>();
  for (const process of processes) {
    const entry = entryFor(entries, process.name);
    if (entry === undefined) continue;
    newest.set(entry, Math.max(newest.get(entry) ?? 0, process.pid));
  }
  return [...newest.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
}

export interface TerminalOrderInput {
  readonly os: string;
  readonly scriptPath: string;
  /** the TERMINAL environment variable, Linux only */
  readonly terminalVar?: string;
  readonly processes: readonly ProcessInfo[];
  readonly selfPid: number;
}

/**
 * Linux: TERMINAL, the terminal running swamp start, xdg-terminal-exec, open
 * terminals, x-terminal-emulator, then the fixed list. macOS: the terminal
 * running swamp start, open terminals, then the default .command handler.
 * Each terminal appears once, at its earliest place.
 */
export function orderTerminals(input: TerminalOrderInput): PlannedTerminal[] {
  const { os, scriptPath, processes, selfPid } = input;
  const planned: PlannedTerminal[] = [];
  const seen = new Set<string>();
  const add = (entry: TerminalEntry, chosen: TerminalChoice) => {
    if (seen.has(entry.name)) return;
    seen.add(entry.name);
    planned.push({
      name: entry.name,
      command: entry.command,
      args: entry.args(scriptPath),
      chosen,
      resolve: os !== "darwin",
    });
  };

  if (os === "darwin") {
    const here = terminalRunningHere(MACOS_TERMINALS, processes, selfPid);
    if (here) add(here, "running_here");
    for (const entry of openTerminals(MACOS_TERMINALS, processes)) {
      add(entry, "open");
    }
    planned.push({
      name: "the default app for .command files",
      command: "open",
      args: [scriptPath],
      chosen: "default",
      resolve: false,
    });
    return planned;
  }

  const terminalVar = input.terminalVar?.trim();
  if (terminalVar) {
    const known = ALL_LINUX.find((e) => e.name === basename(terminalVar));
    seen.add(known?.name ?? terminalVar);
    planned.push({
      name: terminalVar,
      command: terminalVar,
      args: known ? known.args(scriptPath) : ["-e", scriptPath],
      chosen: "set",
      resolve: true,
    });
  }
  const here = terminalRunningHere(LINUX_TERMINALS, processes, selfPid);
  if (here) add(here, "running_here");
  add(LINUX_XDG_TERMINAL_EXEC, "default");
  for (const entry of openTerminals(LINUX_TERMINALS, processes)) {
    add(entry, "open");
  }
  add(LINUX_X_TERMINAL_EMULATOR, "default");
  for (const entry of LINUX_TERMINALS) add(entry, "default");
  return planned;
}
