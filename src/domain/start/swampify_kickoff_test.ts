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
import { UserError } from "../errors.ts";
import {
  SWAMPIFY_KICKOFF_EXCLUDE_MAX,
  SWAMPIFY_KICKOFF_MARKER,
  SWAMPIFY_KICKOFF_PATH_MAX,
  SWAMPIFY_KICKOFF_TITLE,
  SwampifyKickoff,
} from "./swampify_kickoff.ts";
import { StartTask } from "./start_task.ts";

// The swampify skill recognises these lines; they change only together with
// its own test.
const PINNED_NO_EXCLUDE = [
  "Swampify kick-off: start from your past sessions",
  "<!-- swampify kick-off v1 -->",
  "",
  "Window: last 30 days",
  "Scope: every session on this machine",
  "Excluded paths: none",
  "",
  "1. Run `swamp extension pull @swamp/agent-sessions`. It writes into `.claude/skills` and `.agents/skills`; if a sandbox refuses that, ask the user to let the command run outside it.",
  "2. Run `swamp behavior create @swamp/agent-sessions swampify`, unless a behavior of that type already exists; then use that one.",
  "3. Follow the swampify skill from its first state, with the window and scope above. If the skill isn't available in this session yet, read its SKILL.md where the pull installed it: `.claude/skills/swampify/SKILL.md` for Claude Code, `.agents/skills/swampify/SKILL.md` for Codex.",
  "",
  "The user read what will be read and stored on the swamp start page. Still give the skill's disclosure and wait for the user to agree before anything is read; skip only its window and scope questions.",
].join("\n");

Deno.test("SwampifyKickoff.render: the default kick-off is the pinned text", () => {
  assertEquals(
    SwampifyKickoff.create({ windowDays: 30 }, "linux").render(),
    PINNED_NO_EXCLUDE,
  );
});

Deno.test("SwampifyKickoff.render: fills the window", () => {
  const text = SwampifyKickoff.create({ windowDays: 7 }, "linux").render();
  assert(text.includes("\nWindow: last 7 days\n"));
});

Deno.test("SwampifyKickoff.render: excluded paths go in one JSON array in a fence", () => {
  const text = SwampifyKickoff.create({
    windowDays: 90,
    exclude: ["~/src/client-repo", "/srv/work repo"],
  }, "linux").render();
  assert(
    text.includes(
      '\nExcluded paths:\n\n```json\n["~/src/client-repo","/srv/work repo"]\n```\n',
    ),
    text,
  );
  assert(!text.includes("Excluded paths: none"));
});

Deno.test("SwampifyKickoff.render: the title is the task title and the marker is line two", () => {
  const text = SwampifyKickoff.create({ windowDays: 30 }, "linux").render();
  const lines = text.split("\n");
  assertEquals(lines[0], SWAMPIFY_KICKOFF_TITLE);
  assertEquals(lines[1], SWAMPIFY_KICKOFF_MARKER);
  assertEquals(
    StartTask.create(text, "swampify").title(),
    SWAMPIFY_KICKOFF_TITLE,
  );
  assertEquals(StartTask.create(text, "swampify").text, text);
});

Deno.test("SwampifyKickoff.create: trims, drops blanks and de-duplicates paths", () => {
  const kickoff = SwampifyKickoff.create({
    windowDays: 30,
    exclude: [" ~/a ", "", "  ", "~/a", "/b"],
  }, "linux");
  assertEquals(kickoff.exclude, ["~/a", "/b"]);
});

Deno.test("SwampifyKickoff.create: refuses a window outside 1 to 365 whole days", () => {
  for (const windowDays of [0, -1, 366, 1.5, Number.NaN]) {
    assertThrows(
      () => SwampifyKickoff.create({ windowDays }, "linux"),
      UserError,
      "window",
    );
  }
  assertEquals(
    SwampifyKickoff.create({ windowDays: 1 }, "linux").windowDays,
    1,
  );
  assertEquals(
    SwampifyKickoff.create({ windowDays: 365 }, "linux").windowDays,
    365,
  );
});

Deno.test("SwampifyKickoff.create: refuses relative paths", () => {
  for (const path of ["src/repo", "./repo", "~user/repo", "C:\\work"]) {
    assertThrows(
      () =>
        SwampifyKickoff.create({ windowDays: 30, exclude: [path] }, "linux"),
      UserError,
      "absolute",
    );
  }
});

Deno.test("SwampifyKickoff.create: accepts Windows drive, UNC and ~ paths on Windows", () => {
  const kickoff = SwampifyKickoff.create({
    windowDays: 30,
    exclude: ["C:\\work\\client", "\\\\server\\share", "~\\src", "~/src"],
  }, "windows");
  assertEquals(kickoff.exclude.length, 4);
  assert(kickoff.render().includes('"C:\\\\work\\\\client"'));
  assertThrows(
    () =>
      SwampifyKickoff.create({ windowDays: 30, exclude: ["work"] }, "windows"),
    UserError,
    "absolute",
  );
});

Deno.test("SwampifyKickoff.create: refuses characters that could leave the quoting, fence or line", () => {
  for (
    const path of [
      "/a'b",
      '/a"b',
      "/a`b",
      "/a$HOME",
      "/a<b",
      "/a>b",
      "/a\nb",
      "/a\rb",
      "/a\tb",
      "/a\u0000b",
      "/a\u007fb",
      "/a\u0085b",
      "/a\u2028b",
      "/a\u2029b",
    ]
  ) {
    assertThrows(
      () =>
        SwampifyKickoff.create({ windowDays: 30, exclude: [path] }, "linux"),
      UserError,
      "Excluded paths can't contain",
    );
  }
});

Deno.test("SwampifyKickoff.create: bounds the number and length of paths", () => {
  const many = Array.from(
    { length: SWAMPIFY_KICKOFF_EXCLUDE_MAX + 1 },
    (_, i) => `/p${i}`,
  );
  assertThrows(
    () => SwampifyKickoff.create({ windowDays: 30, exclude: many }, "linux"),
    UserError,
    "at most",
  );
  assertEquals(
    SwampifyKickoff.create({
      windowDays: 30,
      exclude: many.slice(0, SWAMPIFY_KICKOFF_EXCLUDE_MAX),
    }, "linux").exclude.length,
    SWAMPIFY_KICKOFF_EXCLUDE_MAX,
  );
  const long = "/" + "a".repeat(SWAMPIFY_KICKOFF_PATH_MAX);
  assertThrows(
    () => SwampifyKickoff.create({ windowDays: 30, exclude: [long] }, "linux"),
    UserError,
    "longer",
  );
});
