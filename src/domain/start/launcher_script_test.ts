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

import { assert, assertEquals, assertThrows } from "@std/assert";
import type { HarnessLaunchSpec } from "./harness.ts";
import {
  cmdCallQuote,
  cmdPasteQuote,
  cmdQuote,
  copyCommand,
  isBatchFile,
  type LauncherEnvironment,
  posixQuote,
  renderCmdLauncher,
  renderPosixLauncher,
  RESUME_FALLBACK_SECONDS,
} from "./launcher_script.ts";

const SPEC: HarnessLaunchSpec = {
  harness: "claude",
  displayName: "Claude Code",
  binaryPath: "/usr/local/bin/claude",
  args: ["Read it's brief."],
  trustMode: "dialog",
};

const ENV: LauncherEnvironment = {
  workspacePath: "/home/u/.swamp/workspaces/first-workspace",
  swampBinDir: "/opt/swamp bin",
  exports: { SWAMP_HOME: "/tmp/h", XDG_CONFIG_HOME: "/tmp/x y" },
  unset: ["A_VAR", "B_VAR"],
};

Deno.test("posixQuote: wraps in single quotes and escapes single quotes", () => {
  assertEquals(posixQuote("plain"), "'plain'");
  assertEquals(posixQuote(""), "''");
  assertEquals(posixQuote("it's"), `'it'\\''s'`);
  assertEquals(posixQuote('$HOME `x` "q"'), `'$HOME \`x\` "q"'`);
});

Deno.test("cmdQuote: wraps in double quotes and doubles percent signs", () => {
  assertEquals(cmdQuote("C:\\Program Files\\x"), `"C:\\Program Files\\x"`);
  assertEquals(cmdQuote("50% %PATH%"), `"50%% %%PATH%%"`);
  assertEquals(cmdQuote("a & b | c ^ d"), `"a & b | c ^ d"`);
});

Deno.test("cmdQuote: refuses double quotes and line breaks", () => {
  for (const bad of ['a"b', "a\nb", "a\rb"]) {
    assertThrows(() => cmdQuote(bad), Error, "Cannot quote");
  }
});

Deno.test("renderPosixLauncher: writes the exact script", () => {
  assertEquals(
    renderPosixLauncher(SPEC, ENV),
    [
      "#!/bin/sh",
      "unset A_VAR B_VAR",
      `export PATH='/opt/swamp bin':"$PATH"`,
      "export SWAMP_HOME='/tmp/h'",
      "export XDG_CONFIG_HOME='/tmp/x y'",
      "cd '/home/u/.swamp/workspaces/first-workspace' || exit 1",
      "printf '\\033[8;40;120t'",
      `'/usr/local/bin/claude' 'Read it'\\''s brief.'`,
      "echo",
      "echo 'Claude Code exited. You can close this window.'",
      "",
    ].join("\n"),
  );
});

Deno.test("renderPosixLauncher: omits unset when the list is empty", () => {
  const script = renderPosixLauncher(SPEC, { ...ENV, unset: [], exports: {} });
  assert(!script.includes("unset"));
  assert(!script.includes("SWAMP_HOME"));
});

Deno.test("renderCmdLauncher: writes the exact script with CRLF endings", () => {
  const spec: HarnessLaunchSpec = {
    ...SPEC,
    binaryPath: "C:\\npm\\claude.cmd",
    args: ["Read 100% of it."],
  };
  assertEquals(
    renderCmdLauncher(spec, {
      workspacePath: "C:\\Users\\u\\.swamp\\workspaces\\w",
      swampBinDir: "C:\\swamp",
      exports: { SWAMP_HOME: "C:\\h%x" },
      unset: ["A_VAR"],
    }),
    [
      "@echo off",
      "set A_VAR=",
      `set "PATH=C:\\swamp;%PATH%"`,
      `set "SWAMP_HOME=C:\\h%%x"`,
      `cd /d "C:\\Users\\u\\.swamp\\workspaces\\w" || exit /b 1`,
      `call "C:\\npm\\claude.cmd" "Read 100%%%% of it."`,
      "echo.",
      "echo Claude Code exited. You can close this window.",
      "",
    ].join("\r\n"),
  );
});

Deno.test("renderCmdLauncher: runs an .exe directly, without call", () => {
  const script = renderCmdLauncher(
    { ...SPEC, binaryPath: "C:\\R&D 50%\\claude.EXE", args: ["100% & more"] },
    { ...ENV, workspacePath: "C:\\R&D", exports: {}, unset: [] },
  );
  const lines = script.split("\r\n");
  assert(lines.includes(`cd /d "C:\\R&D" || exit /b 1`));
  assert(lines.includes(`"C:\\R&D 50%%\\claude.EXE" "100%% & more"`));
  assert(!script.includes("call "));
});

Deno.test("renderCmdLauncher: calls a .cmd or .bat with percent escaped for both expansions", () => {
  for (const binaryPath of ["C:\\npm\\claude.cmd", "C:\\x\\run.BAT"]) {
    const script = renderCmdLauncher(
      { ...SPEC, binaryPath, args: ["%PATH% & 5%"] },
      { ...ENV, exports: {}, unset: [] },
    );
    assert(
      script.split("\r\n").includes(
        `call "${binaryPath}" "%%%%PATH%%%% & 5%%%%"`,
      ),
    );
  }
});

Deno.test("cmdCallQuote: writes each percent as four", () => {
  assertEquals(cmdCallQuote("a%b"), `"a%%%%b"`);
  assertThrows(() => cmdCallQuote('a"b'), Error, "Cannot quote");
});

Deno.test("cmdPasteQuote: moves each percent outside the quotes with a caret", () => {
  assertEquals(cmdPasteQuote("C:\\R&D"), `"C:\\R&D"`);
  assertEquals(cmdPasteQuote("50% %PATH%"), `"50"^%" "^%"PATH"^%""`);
  assertThrows(() => cmdPasteQuote('a"b'), Error, "Cannot quote");
});

Deno.test("isBatchFile: only .cmd and .bat, any case", () => {
  assert(isBatchFile("C:\\npm\\claude.cmd"));
  assert(isBatchFile("C:\\x\\a.BAT"));
  assert(!isBatchFile("C:\\x\\claude.exe"));
  assert(!isBatchFile("C:\\x\\claude"));
});

Deno.test("copyCommand: quotes each part for a POSIX shell", () => {
  assertEquals(
    copyCommand(SPEC, "/w s", "darwin"),
    `cd '/w s' && '/usr/local/bin/claude' 'Read it'\\''s brief.'`,
  );
});

Deno.test("copyCommand: on Windows keeps percent signs literal when pasted", () => {
  assertEquals(
    copyCommand(
      { ...SPEC, binaryPath: "C:\\a%b\\c.exe", args: ["%PATH%"] },
      "C:\\R&D",
      "windows",
    ),
    `cd /d "C:\\R&D" && "C:\\a"^%"b\\c.exe" ""^%"PATH"^%""`,
  );
});

Deno.test("copyCommand: uses cd /d and double quotes on Windows", () => {
  assertEquals(
    copyCommand(
      { ...SPEC, binaryPath: "C:\\npm\\claude.cmd", args: ["go"] },
      "C:\\w",
      "windows",
    ),
    `cd /d "C:\\w" && "C:\\npm\\claude.cmd" "go"`,
  );
});

const RESUME: HarnessLaunchSpec = {
  ...SPEC,
  args: ["--continue"],
  fallbackArgs: [],
};

Deno.test("renderPosixLauncher: a resume opens a fresh session when it fails straight away", () => {
  const script = renderPosixLauncher(RESUME, {
    ...ENV,
    unset: [],
    exports: {},
  });
  assert(script.includes("started=$(date +%s)\n"));
  assert(
    script.includes(
      `'/usr/local/bin/claude' '--continue' || { [ $(($(date +%s) - started)) -lt ${RESUME_FALLBACK_SECONDS} ] && '/usr/local/bin/claude'; }\n`,
    ),
  );
});

Deno.test("renderCmdLauncher: a resume falls back to a fresh session", () => {
  const exe = renderCmdLauncher(
    { ...RESUME, binaryPath: "C:\\bin\\claude.exe" },
    { ...ENV, workspacePath: "C:\\w", unset: [], exports: {} },
  );
  assert(
    exe.includes(
      `"C:\\bin\\claude.exe" "--continue" || "C:\\bin\\claude.exe"\r\n`,
    ),
  );
  const shim = renderCmdLauncher(
    { ...RESUME, binaryPath: "C:\\npm\\claude.cmd" },
    { ...ENV, workspacePath: "C:\\w", unset: [], exports: {} },
  );
  assert(
    shim.includes(
      `call "C:\\npm\\claude.cmd" "--continue" || call "C:\\npm\\claude.cmd"\r\n`,
    ),
  );
});

Deno.test("copyCommand: a resume falls back to a fresh session", () => {
  assertEquals(
    copyCommand(RESUME, "/w s", "darwin"),
    `cd '/w s' && { '/usr/local/bin/claude' '--continue' || '/usr/local/bin/claude'; }`,
  );
  assertEquals(
    copyCommand(
      { ...RESUME, binaryPath: "C:\\bin\\claude.exe" },
      "C:\\w",
      "windows",
    ),
    `cd /d "C:\\w" && ("C:\\bin\\claude.exe" "--continue" || "C:\\bin\\claude.exe")`,
  );
});

Deno.test("renderCmdLauncher: refuses an exported value with a quote or line break", () => {
  for (const bad of ['https://x" & calc & rem "', "a\r\nb"]) {
    assertThrows(() =>
      renderCmdLauncher(SPEC, { ...ENV, exports: { SWAMP_CLUB_URL: bad } })
    );
  }
});
