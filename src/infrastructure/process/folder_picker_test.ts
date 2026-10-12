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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type FolderPickerDeps,
  type PickerRun,
  SystemFolderPicker,
} from "./folder_picker.ts";

function picker(options: {
  os: FolderPickerDeps["os"];
  env?: Record<string, string>;
  onPath?: Record<string, string>;
  result?: PickerRun;
}) {
  const runs: Array<{ command: string; args: readonly string[] }> = [];
  const env = options.env ?? {};
  const onPath = options.onPath ?? {};
  const p = new SystemFolderPicker({
    os: options.os,
    env: (name) => env[name],
    resolve: (name) => Promise.resolve(onPath[name] ?? null),
    run: (command, args) => {
      runs.push({ command, args });
      return Promise.resolve(
        options.result ?? { code: 0, stdout: "", stderr: "" },
      );
    },
  });
  return { p, runs };
}

const MAC = { osascript: "/usr/bin/osascript" };

Deno.test("SystemFolderPicker: macOS runs choose folder through osascript and trims the path", async () => {
  const { p, runs } = picker({
    os: "darwin",
    onPath: MAC,
    result: { code: 0, stdout: "/Users/u/code/infra/\n", stderr: "" },
  });
  assertEquals(await p.available(), true);
  assertEquals(await p.pick('Choose "a" repo'), "/Users/u/code/infra");
  assertEquals(runs[0].command, "/usr/bin/osascript");
  assertEquals(runs[0].args.slice(0, 3), ["-e", "tell me to activate", "-e"]);
  assertEquals(
    runs[0].args[3],
    'POSIX path of (choose folder with prompt "Choose \\"a\\" repo")',
  );
});

Deno.test("SystemFolderPicker: macOS cancel (-128) is null, other failures throw", async () => {
  const cancel = picker({
    os: "darwin",
    onPath: MAC,
    result: {
      code: 1,
      stdout: "",
      stderr: "execution error: User canceled. (-128)",
    },
  });
  assertEquals(await cancel.p.pick("Choose"), null);
  const broken = picker({
    os: "darwin",
    onPath: MAC,
    result: { code: 1, stdout: "", stderr: "syntax error" },
  });
  await assertRejects(() => broken.p.pick("Choose"), Error, "syntax error");
});

Deno.test("SystemFolderPicker: Windows uses a topmost Forms dialog; nothing written means cancelled", async () => {
  const { p, runs } = picker({
    os: "windows",
    onPath: { powershell: "C:\\ps\\powershell.exe" },
    result: { code: 0, stdout: "C:\\work\\infra", stderr: "" },
  });
  assertEquals(await p.pick("Choose it's repo"), "C:\\work\\infra");
  assertEquals(runs[0].args.slice(0, 4), [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-Command",
  ]);
  assertStringIncludes(runs[0].args[4], "FolderBrowserDialog");
  assertStringIncludes(runs[0].args[4], "TopMost = $true");
  assertStringIncludes(runs[0].args[4], "'Choose it''s repo'");
  const cancelled = picker({
    os: "windows",
    onPath: { powershell: "C:\\ps\\powershell.exe" },
  });
  assertEquals(await cancelled.p.pick("Choose"), null);
});

Deno.test("SystemFolderPicker: Linux prefers zenity, falls back to kdialog, needs a display", async () => {
  const display = { DISPLAY: ":0", HOME: "/home/u" };
  const z = picker({
    os: "linux",
    env: display,
    onPath: { zenity: "/usr/bin/zenity", kdialog: "/usr/bin/kdialog" },
    result: { code: 0, stdout: "/home/u/infra\n", stderr: "" },
  });
  assertEquals(await z.p.pick("Choose"), "/home/u/infra");
  assertEquals(z.runs[0].command, "/usr/bin/zenity");
  assertEquals(z.runs[0].args, [
    "--file-selection",
    "--directory",
    "--title=Choose",
  ]);

  const k = picker({
    os: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0", HOME: "/home/u" },
    onPath: { kdialog: "/usr/bin/kdialog" },
    result: { code: 1, stdout: "", stderr: "" },
  });
  assertEquals(await k.p.pick("Choose"), null);
  assertEquals(k.runs[0].args, [
    "--getexistingdirectory",
    "/home/u",
    "--title",
    "Choose",
  ]);

  const headless = picker({
    os: "linux",
    onPath: { zenity: "/usr/bin/zenity" },
  });
  assertEquals(await headless.p.available(), false);
  const none = picker({ os: "linux", env: display });
  assertEquals(await none.p.available(), false);
  await assertRejects(() => none.p.pick("Choose"), Error, "No folder chooser");
});

Deno.test("SystemFolderPicker: unavailable over SSH on every OS", async () => {
  for (const os of ["darwin", "windows", "linux"] as const) {
    const { p } = picker({
      os,
      env: { SSH_CONNECTION: "1 2 3 4", DISPLAY: ":0" },
      onPath: { ...MAC, powershell: "p", zenity: "z" },
    });
    assertEquals(await p.available(), false, os);
  }
});

Deno.test("SystemFolderPicker: keeps a root folder's separator", async () => {
  const { p } = picker({
    os: "darwin",
    onPath: MAC,
    result: { code: 0, stdout: "/\n", stderr: "" },
  });
  assertEquals(await p.pick("Choose"), "/");
});
