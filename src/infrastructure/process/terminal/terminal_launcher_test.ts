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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { HarnessLaunchSpec } from "../../../domain/start/harness.ts";
import { copyCommand } from "../../../domain/start/launcher_script.ts";
import { NESTED_SWAMP_ENV_VARS } from "../../../domain/remote/environment_snapshot.ts";
import { startDir } from "../../persistence/start_session_file_repository.ts";
import { assertPathEquals } from "../../persistence/path_test_helpers.ts";
import {
  LAUNCHER_EXPORTED_VARS,
  SystemTerminalLauncher,
  type TerminalLauncherDeps,
  type TerminalProcess,
} from "./terminal_launcher.ts";

const WS = "/home/u/.swamp/workspaces/first-workspace";
const SPEC: HarnessLaunchSpec = {
  harness: "claude",
  displayName: "Claude Code",
  binaryPath: "/usr/local/bin/claude",
  args: [
    "Read tasks/2026-10-12-list-pods.md and use the swamp-getting-started skill.",
  ],
  trustMode: "dialog",
};

interface Spawned {
  command: string;
  args: readonly string[];
  cwd: string;
}

interface Harness {
  launcher: SystemTerminalLauncher;
  spawned: Spawned[];
  scripts: Array<{ path: string; content: string }>;
  unrefs: number;
}

/** A process whose exit status is fixed, or that never exits. */
function fakeProcess(
  outcome: "success" | "failure" | "reject" | "running",
  counter: { unrefs: number },
): TerminalProcess {
  const status = outcome === "running"
    ? new Promise<{ success: boolean }>(() => {})
    : outcome === "reject"
    ? Promise.reject(new Error("spawn failed"))
    : Promise.resolve({ success: outcome === "success" });
  // Avoid an unhandled rejection before the launcher awaits it.
  status.catch(() => {});
  return {
    status,
    unref: () => {
      counter.unrefs++;
    },
  };
}

function makeLauncher(options: {
  os: TerminalLauncherDeps["os"];
  env?: Record<string, string>;
  onPath?: Record<string, string>;
  outcomes?: Record<
    string,
    "success" | "failure" | "reject" | "running" | "throw"
  >;
  graceMs?: number;
}): Harness {
  const h: Harness = {
    launcher: undefined as unknown as SystemTerminalLauncher,
    spawned: [],
    scripts: [],
    unrefs: 0,
  };
  const env = options.env ?? {};
  const onPath = options.onPath ?? {};
  h.launcher = new SystemTerminalLauncher({
    os: options.os,
    env: (name) => env[name],
    resolve: (name) => Promise.resolve(onPath[name] ?? null),
    spawn: (command, args, cwd) => {
      h.spawned.push({ command, args, cwd });
      const outcome = options.outcomes?.[command] ?? "success";
      if (outcome === "throw") throw new Error("not found");
      return fakeProcess(outcome, h);
    },
    writeScript: (path, content) => {
      h.scripts.push({ path, content });
      return Promise.resolve();
    },
    execPath: "/opt/swamp/bin/swamp",
    graceMs: options.graceMs ?? 5,
  });
  return h;
}

Deno.test("SystemTerminalLauncher.open: on macOS opens launch.command with the default application", async () => {
  const ws = "/home/u/Work spaces/R&D;project";
  const h = makeLauncher({ os: "darwin" });
  const outcome = await h.launcher.open(SPEC, ws);
  const script = join(startDir(ws), "launch.command");
  assertEquals(outcome, {
    method: "macos_terminal",
    opened: true,
    command: copyCommand(SPEC, ws, "darwin"),
  });
  assertEquals(h.spawned.length, 1);
  assertEquals(h.spawned[0].command, "open");
  assertEquals(h.spawned[0].args.length, 1);
  assertPathEquals(h.spawned[0].args[0], script);
  assertPathEquals(h.spawned[0].cwd, ws);
  assertEquals(h.scripts.length, 1);
  assertPathEquals(h.scripts[0].path, script);
});

Deno.test("SystemTerminalLauncher.open: on macOS a failed open falls back to copy_command", async () => {
  const h = makeLauncher({ os: "darwin", outcomes: { open: "failure" } });
  const outcome = await h.launcher.open(SPEC, WS);
  assertEquals(outcome.method, "copy_command");
  assertEquals(outcome.opened, false);
  assertEquals(outcome.command, copyCommand(SPEC, WS, "darwin"));
});

Deno.test("SystemTerminalLauncher.open: a spawn that throws or rejects falls back", async () => {
  for (const failure of ["throw", "reject"] as const) {
    const h = makeLauncher({ os: "darwin", outcomes: { open: failure } });
    assertEquals((await h.launcher.open(SPEC, WS)).method, "copy_command");
  }
});

Deno.test("SystemTerminalLauncher.open: a terminal still running after the grace window counts as opened", async () => {
  const h = makeLauncher({
    os: "darwin",
    outcomes: { open: "running" },
    graceMs: 1,
  });
  const outcome = await h.launcher.open(SPEC, WS);
  assertEquals(outcome.method, "macos_terminal");
  assertEquals(outcome.opened, true);
  assertEquals(h.unrefs, 1);
});

Deno.test("SystemTerminalLauncher.open: on Windows uses wt.exe when it resolves", async () => {
  const ws = "C:\\Users\\u\\.swamp\\workspaces\\w";
  const winSpec = { ...SPEC, binaryPath: "C:\\npm\\claude.cmd" };
  const h = makeLauncher({
    os: "windows",
    onPath: { "wt.exe": "C:\\WindowsApps\\wt.exe" },
  });
  const outcome = await h.launcher.open(winSpec, ws);
  const script = join(startDir(ws), "launch.cmd");
  assertEquals(outcome.method, "windows_terminal");
  assertEquals(outcome.opened, true);
  assertEquals(outcome.command, copyCommand(winSpec, ws, "windows"));
  assertEquals(h.spawned[0].command, "C:\\WindowsApps\\wt.exe");
  // The window opens in the workspace and runs the launcher by its relative
  // path, so no workspace path reaches wt's or cmd's parser.
  assertEquals(h.spawned[0].args, [
    "-d",
    ".",
    "cmd",
    "/k",
    ".swamp\\start\\launch.cmd",
  ]);
  assertEquals(h.spawned[0].cwd, ws);
  assertPathEquals(h.scripts[0].path, script);
  assertStringIncludes(h.scripts[0].content, "@echo off\r\n");
});

Deno.test("SystemTerminalLauncher.open: on Windows without wt.exe uses cmd start", async () => {
  const ws = "C:\\w";
  const h = makeLauncher({ os: "windows" });
  const outcome = await h.launcher.open(
    { ...SPEC, binaryPath: "C:\\c.exe" },
    ws,
  );
  assertEquals(outcome.method, "windows_terminal");
  assertEquals(h.spawned[0].command, "cmd");
  assertEquals(h.spawned[0].args, [
    "/c",
    "start",
    "",
    "cmd",
    "/k",
    ".swamp\\start\\launch.cmd",
  ]);
  assertEquals(h.spawned[0].cwd, ws);
});

Deno.test("SystemTerminalLauncher.open: on Windows a workspace path with & or ; never reaches the window command", async () => {
  const ws = "C:\\R&D;x 50%";
  const variants: Record<string, string>[] = [{ "wt.exe": "C:\\wt.exe" }, {}];
  for (const onPath of variants) {
    const h = makeLauncher({ os: "windows", onPath });
    const outcome = await h.launcher.open(
      { ...SPEC, binaryPath: "C:\\c.exe" },
      ws,
    );
    assertEquals(outcome.opened, true);
    for (const arg of h.spawned[0].args) {
      assert(!arg.includes("R&D"), arg);
    }
    assertEquals(h.spawned[0].cwd, ws);
    assertStringIncludes(
      h.scripts[0].content,
      `cd /d "C:\\R&D;x 50%%" || exit /b 1\r\n`,
    );
  }
});

Deno.test("SystemTerminalLauncher.open: on Linux tries terminals in order and falls through on failure", async () => {
  const h = makeLauncher({
    os: "linux",
    env: { DISPLAY: ":0", TERMINAL: "alacritty" },
    onPath: {
      alacritty: "/usr/bin/alacritty",
      "x-terminal-emulator": "/usr/bin/x-terminal-emulator",
      "gnome-terminal": "/usr/bin/gnome-terminal",
      konsole: "/usr/bin/konsole",
      "xfce4-terminal": "/usr/bin/xfce4-terminal",
    },
    outcomes: {
      "/usr/bin/alacritty": "throw",
      "/usr/bin/x-terminal-emulator": "failure",
    },
  });
  const outcome = await h.launcher.open(SPEC, WS);
  const script = join(startDir(WS), "launch.command");
  assertEquals(outcome.method, "linux_terminal");
  assertEquals(outcome.opened, true);
  assertEquals(h.spawned.map((s) => [s.command, s.args[0]]), [
    ["/usr/bin/alacritty", "-e"],
    ["/usr/bin/x-terminal-emulator", "-e"],
    ["/usr/bin/gnome-terminal", "--"],
  ]);
  for (const s of h.spawned) assertPathEquals(s.args[1], script);
});

Deno.test("SystemTerminalLauncher.open: on Linux uses the documented flag for each terminal", async () => {
  const h = makeLauncher({
    os: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    onPath: { konsole: "/k", "xfce4-terminal": "/x" },
    outcomes: { "/k": "failure", "/x": "failure" },
  });
  const outcome = await h.launcher.open(SPEC, WS);
  assertEquals(outcome.method, "copy_command");
  assertEquals(h.spawned.map((s) => [s.command, s.args[0]]), [
    ["/k", "-e"],
    ["/x", "-x"],
  ]);
});

Deno.test("SystemTerminalLauncher.open: on Linux with no display opens nothing", async () => {
  const h = makeLauncher({
    os: "linux",
    onPath: { "x-terminal-emulator": "/usr/bin/x-terminal-emulator" },
  });
  const outcome = await h.launcher.open(SPEC, WS);
  assertEquals(outcome, {
    method: "copy_command",
    opened: false,
    command: copyCommand(SPEC, WS, "linux"),
  });
  assertEquals(h.spawned.length, 0);
  assertEquals(h.scripts.length, 1);
});

Deno.test("SystemTerminalLauncher.open: over SSH writes the script but opens nothing", async () => {
  for (const os of ["darwin", "linux", "windows"] as const) {
    const h = makeLauncher({
      os,
      env: { SSH_CONNECTION: "10.0.0.1 5000 10.0.0.2 22", DISPLAY: ":0" },
      onPath: { "wt.exe": "wt.exe", "x-terminal-emulator": "/x" },
    });
    const outcome = await h.launcher.open(SPEC, WS);
    assertEquals(outcome.method, "copy_command", os);
    assertEquals(outcome.opened, false);
    assertEquals(h.spawned.length, 0, os);
    assertEquals(h.scripts.length, 1, os);
  }
});

Deno.test("SystemTerminalLauncher.open: the launcher unsets exactly NESTED_SWAMP_ENV_VARS", async () => {
  const h = makeLauncher({ os: "darwin" });
  await h.launcher.open(SPEC, WS);
  const unsetLine = h.scripts[0].content.split("\n").find((l) =>
    l.startsWith("unset ")
  );
  assert(unsetLine);
  assertEquals(unsetLine.slice("unset ".length).split(" "), [
    ...NESTED_SWAMP_ENV_VARS,
  ]);
});

Deno.test("SystemTerminalLauncher.open: the Windows launcher clears each NESTED_SWAMP_ENV_VARS entry", async () => {
  const h = makeLauncher({ os: "windows" });
  await h.launcher.open({ ...SPEC, binaryPath: "C:\\c.exe" }, "C:\\w");
  const cleared = h.scripts[0].content.split("\r\n").filter((l) =>
    /^set [A-Z_]+=$/.test(l)
  ).map((l) => l.slice(4, -1));
  assertEquals(cleared, [...NESTED_SWAMP_ENV_VARS]);
});

Deno.test("SystemTerminalLauncher.open: exports only the set config variables and never secrets", async () => {
  const h = makeLauncher({
    os: "darwin",
    env: {
      SWAMP_HOME: "/tmp/swamp home",
      XDG_CONFIG_HOME: "/tmp/xdg",
      SWAMP_API_KEY: "swamp_secret_key",
      SWAMP_CLUB_URL: "https://club.example",
    },
  });
  await h.launcher.open(SPEC, WS);
  const content = h.scripts[0].content;
  const exported = content.split("\n").filter((l) =>
    l.startsWith("export ") && !l.startsWith("export PATH=")
  );
  assertEquals(exported, [
    "export SWAMP_HOME='/tmp/swamp home'",
    "export XDG_CONFIG_HOME='/tmp/xdg'",
    "export SWAMP_CLUB_URL='https://club.example'",
  ]);
  assert(!content.includes("SWAMP_API_KEY"));
  assert(!content.includes("swamp_secret_key"));
  assertEquals([...LAUNCHER_EXPORTED_VARS], [
    "SWAMP_HOME",
    "SWAMP_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "SWAMP_CLUB_URL",
  ]);
});

Deno.test("SystemTerminalLauncher.open: puts the swamp binary's folder first on PATH", async () => {
  const h = makeLauncher({ os: "darwin" });
  await h.launcher.open(SPEC, WS);
  assertStringIncludes(
    h.scripts[0].content,
    `export PATH='/opt/swamp/bin':"$PATH"`,
  );
});
