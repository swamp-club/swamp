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
import {
  canResume,
  findHarness,
  type HarnessDefinition,
  HARNESSES,
  launchPrompt,
  pickBinaryPath,
  planHarnessLaunch,
} from "./harness.ts";

const WS = "/home/u/.swamp/workspaces/first-workspace";
const BRIEF = "tasks/2026-10-12-list-pods.md";
const LAUNCH_PROMPT = launchPrompt(BRIEF);

function harness(id: string): HarnessDefinition {
  const found = findHarness(id);
  assert(found, `no harness ${id}`);
  return found;
}

Deno.test("HARNESSES: lists every harness once, in page order", () => {
  assertEquals(HARNESSES.map((h) => h.id), [
    "claude",
    "codex",
    "cursor",
    "opencode",
    "copilot",
    "kiro",
    "pi",
    "amp",
    "antigravity",
  ]);
});

Deno.test("HARNESSES: binaries and enrol tools match the detection table", () => {
  assertEquals(
    Object.fromEntries(HARNESSES.map((h) => [h.id, [h.binary, h.enrolTool]])),
    {
      claude: ["claude", "claude"],
      codex: ["codex", "codex"],
      cursor: ["cursor-agent", "cursor"],
      opencode: ["opencode", "opencode"],
      copilot: ["copilot", "copilot"],
      kiro: ["kiro-cli", "kiro"],
      pi: ["pi", "pi"],
      amp: ["amp", "amp"],
      antigravity: ["agy", "antigravity"],
    },
  );
});

Deno.test("HARNESSES: only amp and antigravity are not launchable", () => {
  assertEquals(
    HARNESSES.filter((h) => !h.launchable).map((h) => h.id),
    ["amp", "antigravity"],
  );
});

Deno.test("findHarness: returns undefined for an unknown id", () => {
  assertEquals(findHarness("emacs"), undefined);
  assertEquals(findHarness("cursor-agent"), undefined);
});

Deno.test("planHarnessLaunch: builds the exact arguments for each harness on POSIX", () => {
  const expected: Record<string, readonly string[]> = {
    claude: [LAUNCH_PROMPT],
    codex: [
      "-c",
      `projects."${WS}".trust_level="trusted"`,
      LAUNCH_PROMPT,
    ],
    cursor: ["--trust", LAUNCH_PROMPT],
    opencode: ["--prompt", LAUNCH_PROMPT],
    copilot: ["-i", LAUNCH_PROMPT],
    kiro: ["chat", "--agent", "swamp", LAUNCH_PROMPT],
    pi: [LAUNCH_PROMPT],
    amp: [],
    antigravity: [],
  };
  for (const h of HARNESSES) {
    const spec = planHarnessLaunch(
      h,
      "/usr/bin/" + h.binary,
      WS,
      "darwin",
      "task",
      BRIEF,
    );
    assertEquals(spec.args, expected[h.id], h.id);
    assertEquals(spec.binaryPath, "/usr/bin/" + h.binary);
    assertEquals(spec.harness, h.id);
    assertEquals(spec.displayName, h.displayName);
    assertEquals(spec.trustMode, h.trustMode);
  }
});

Deno.test("planHarnessLaunch: trust modes match the table", () => {
  assertEquals(
    Object.fromEntries(
      HARNESSES.map((
        h,
      ) => [
        h.id,
        planHarnessLaunch(h, "x", WS, "linux", "task", BRIEF).trustMode,
      ]),
    ),
    {
      claude: "dialog",
      codex: "passed",
      cursor: "passed",
      opencode: "unknown",
      copilot: "unknown",
      kiro: "unknown",
      pi: "unknown",
      amp: "unknown",
      antigravity: "unknown",
    },
  );
});

Deno.test("launchPrompt: names the task's brief", () => {
  assertEquals(
    LAUNCH_PROMPT,
    "Read tasks/2026-10-12-list-pods.md and use the swamp-getting-started skill.",
  );
});

Deno.test("launchPrompt: refuses anything but a tasks/<slug>.md path", () => {
  for (
    const bad of ["TASK.md", "tasks/../x.md", "tasks/a b.md", "tasks/x'.md"]
  ) {
    let threw = false;
    try {
      launchPrompt(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

Deno.test("planHarnessLaunch: a task launch needs a brief path", () => {
  let threw = false;
  try {
    planHarnessLaunch(harness("claude"), "/bin/claude", WS, "darwin", "task");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("planHarnessLaunch: codex on Windows drops -c and falls back to the dialog", () => {
  const spec = planHarnessLaunch(
    harness("codex"),
    "C:\\npm\\codex.cmd",
    "C:\\Users\\u\\.swamp\\workspaces\\w",
    "windows",
    "task",
    BRIEF,
  );
  assertEquals(spec.args, [LAUNCH_PROMPT]);
  assertEquals(spec.trustMode, "dialog");
});

Deno.test("planHarnessLaunch: other harnesses keep their trust mode on Windows", () => {
  const spec = planHarnessLaunch(
    harness("cursor"),
    "c.exe",
    "C:\\w",
    "windows",
    "task",
    BRIEF,
  );
  assertEquals(spec.trustMode, "passed");
  assertEquals(spec.args, ["--trust", LAUNCH_PROMPT]);
});

Deno.test("planHarnessLaunch: codex escapes quotes and backslashes in the folder key", () => {
  const spec = planHarnessLaunch(
    harness("codex"),
    "codex",
    `/a"b\\c`,
    "linux",
    "task",
    BRIEF,
  );
  assertEquals(spec.args[1], `projects."/a\\"b\\\\c".trust_level="trusted"`);
});

Deno.test("pickBinaryPath: returns null for no hits", () => {
  assertEquals(pickBinaryPath([], "linux"), null);
  assertEquals(pickBinaryPath(["", "  "], "windows"), null);
});

Deno.test("pickBinaryPath: takes the first trimmed hit on POSIX", () => {
  assertEquals(
    pickBinaryPath(["  /usr/local/bin/claude ", "/opt/claude"], "darwin"),
    "/usr/local/bin/claude",
  );
});

Deno.test("pickBinaryPath: prefers a .cmd or .exe hit on Windows", () => {
  assertEquals(
    pickBinaryPath(
      ["C:\\npm\\claude", "C:\\npm\\claude.CMD", "C:\\bin\\claude.exe"],
      "windows",
    ),
    "C:\\npm\\claude.CMD",
  );
  assertEquals(
    pickBinaryPath(["C:\\npm\\claude", "C:\\bin\\claude.exe"], "windows"),
    "C:\\bin\\claude.exe",
  );
});

Deno.test("pickBinaryPath: falls back to the first hit on Windows with no .cmd or .exe", () => {
  assertEquals(
    pickBinaryPath(["C:\\npm\\claude", "C:\\npm\\claude.ps1"], "windows"),
    "C:\\npm\\claude",
  );
});

Deno.test("pickBinaryPath: does not prefer .cmd on POSIX", () => {
  assertEquals(
    pickBinaryPath(["/a/claude", "/b/claude.cmd"], "linux"),
    "/a/claude",
  );
});

Deno.test("planHarnessLaunch: resume continues the conversation where the harness can, and sends no task", () => {
  const args = (id: string, os = "darwin") =>
    planHarnessLaunch(findHarness(id)!, "/bin/x", WS, os, "resume").args;
  assertEquals(args("claude"), ["--continue"]);
  assertEquals(args("codex"), [
    "resume",
    "--last",
    "-c",
    `projects."${WS}".trust_level="trusted"`,
  ]);
  assertEquals(args("codex", "windows"), ["resume", "--last"]);
  assertEquals(args("opencode"), ["--continue"]);
  assertEquals(args("cursor"), ["--trust"]);
  assertEquals(args("kiro"), ["chat", "--agent", "swamp"]);
  for (const h of HARNESSES) {
    assert(!args(h.id).includes(LAUNCH_PROMPT), h.id);
  }
});

Deno.test("planHarnessLaunch: a resume falls back to a fresh session, and nothing else does", () => {
  const plan = (id: string, mode: "task" | "resume" | "open") =>
    planHarnessLaunch(findHarness(id)!, "/bin/x", WS, "darwin", mode, BRIEF);
  assertEquals(plan("claude", "resume").fallbackArgs, []);
  assertEquals(plan("opencode", "resume").fallbackArgs, []);
  assertEquals(plan("codex", "resume").fallbackArgs, [
    "-c",
    `projects."${WS}".trust_level="trusted"`,
  ]);
  for (const h of HARNESSES) {
    assertEquals(plan(h.id, "task").fallbackArgs, undefined, h.id);
    assertEquals(plan(h.id, "open").fallbackArgs, undefined, h.id);
    if (!canResume(h)) {
      assertEquals(plan(h.id, "resume").fallbackArgs, undefined, h.id);
    }
  }
});

Deno.test("canResume: only the harnesses with a verified resume", () => {
  assertEquals(
    HARNESSES.filter(canResume).map((h) => h.id),
    ["claude", "codex", "opencode"],
  );
});
