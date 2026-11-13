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
import {
  BRIEF_HEADER,
  briefFileName,
  briefTaskText,
  isBriefFile,
  isSwampBrief,
  renderBrief,
  SWAMPIFY_PAGE_LINE_PREFIX,
  swampifyPageUrl,
} from "./brief.ts";
import { SwampifyKickoff } from "./swampify_kickoff.ts";
import { StartTask } from "./start_task.ts";

Deno.test("renderBrief: starts with the versioned header", () => {
  const brief = renderBrief({
    task: StartTask.create("list pods"),
    workspacePath: "/w",
    harnessDisplayName: "Claude Code",
  });
  assertEquals(brief.split("\n")[0], BRIEF_HEADER);
  assertEquals(BRIEF_HEADER, "<!-- swamp start brief v1 -->");
});

Deno.test("renderBrief: carries the task verbatim, including markdown and shell metacharacters", () => {
  const text = [
    "# Not a heading of mine",
    "* bullet `code` **bold** [link](http://x)",
    "$(rm -rf /) `whoami` $HOME ${PATH} 'single' \"double\" \\ | & ; < > %PATH% ^",
    "```sh",
    "echo hi",
    "```",
    "<!-- comment --> <script>alert(1)</script>",
  ].join("\n");
  const brief = renderBrief({
    task: StartTask.create(text),
    workspacePath: "/w",
    harnessDisplayName: "Codex",
  });
  assertStringIncludes(brief, "# Task\n\n" + text + "\n\n# Context");
});

Deno.test("renderBrief: names the workspace and the agent", () => {
  const brief = renderBrief({
    task: StartTask.create("x"),
    workspacePath: "/home/u/.swamp/workspaces/first-workspace",
    harnessDisplayName: "Cursor",
  });
  assertStringIncludes(
    brief,
    "- Workspace: /home/u/.swamp/workspaces/first-workspace.",
  );
  assertStringIncludes(brief, "- Agent: Cursor");
  assertStringIncludes(brief, "swamp-getting-started");
  assert(brief.endsWith("\n"));
});

Deno.test("renderBrief: describes a created workspace as holding only Swamp's files", () => {
  const brief = renderBrief({
    task: StartTask.create("x"),
    workspacePath: "/w",
    harnessDisplayName: "Cursor",
    imported: false,
  });
  assertStringIncludes(brief, "it holds only Swamp's files.");
  assert(!brief.includes("existing project"));
});

Deno.test("renderBrief: describes an imported workspace as the user's own project", () => {
  const brief = renderBrief({
    task: StartTask.create("x"),
    workspacePath: "/src/app",
    harnessDisplayName: "Cursor",
    imported: true,
  });
  assertStringIncludes(
    brief,
    "- Workspace: /src/app. This is the user's existing project, registered as a Swamp workspace; leave files unrelated to the task alone.",
  );
  assert(!brief.includes("only Swamp's files"));
});

Deno.test("briefFileName: dates and slugs the task title", () => {
  assertEquals(
    briefFileName(
      "2026-10-11T09:30:00.000Z",
      "List the VPCs in my dev AWS account.",
    ),
    "2026-10-11-list-the-vpcs-in-my-dev-aws-account.md",
  );
  assertEquals(
    briefFileName("2026-10-11T00:00:00Z", "!!!"),
    "2026-10-11-task.md",
  );
  const long = briefFileName("2026-10-11T00:00:00Z", "a ".repeat(80));
  assert(long.length <= "2026-10-11-".length + 60 + ".md".length);
  assert(!long.includes("-.md"));
});

Deno.test("isSwampBrief: only a file starting with the brief header", () => {
  assert(isSwampBrief(`${BRIEF_HEADER}\n# Task`));
  assert(!isSwampBrief("# My own task list"));
});

Deno.test("isBriefFile: only tasks/<lower-case slug>.md", () => {
  assert(isBriefFile("tasks/2026-10-11-list-my-vpcs.md"));
  assert(isBriefFile("tasks/2026-10-11-task-2.md"));
  for (
    const bad of [
      "TASK.md",
      "tasks/../TASK.md",
      "tasks/a/b.md",
      "tasks/-x.md",
      "tasks/X.md",
      "tasks/a b.md",
      "tasks/a'.md",
      "tasks\\a.md",
      "/tasks/a.md",
      "tasks/a.md\n",
    ]
  ) {
    assert(!isBriefFile(bad), bad);
  }
});

Deno.test("briefFileName: always makes a valid brief path", () => {
  for (
    const title of ["List the VPCs.", "!!!", "  ", "Ünïcödé ✓", "a".repeat(200)]
  ) {
    assert(
      isBriefFile(`tasks/${briefFileName("2026-10-11T00:00:00Z", title)}`),
      title,
    );
  }
});

Deno.test("briefTaskText: reads back the task a brief was written for", () => {
  const text = "line one\n\n# Context\nnot a heading of the brief";
  const brief = renderBrief({
    task: StartTask.create(text),
    workspacePath: "/w",
    harnessDisplayName: "Codex",
  });
  assertEquals(briefTaskText(brief), text);
  assertEquals(briefTaskText("# my own notes"), null);
});

Deno.test("renderBrief: a swampify task keeps its own steps and works in the user's repo", () => {
  const text =
    "Automate this repeated chore as a swamp workflow: Release docs.\n\n## How to work on this\n\n1. Record the pick.";
  const brief = renderBrief({
    task: StartTask.create(text, "swampify"),
    workspacePath: "/home/u/my-repo",
    harnessDisplayName: "Codex",
  });
  assert(isSwampBrief(brief));
  assertStringIncludes(
    brief,
    "- Workspace: /home/u/my-repo. This is the user's own swamp repo;",
  );
  assertStringIncludes(brief, "- Agent: Codex");
  assert(!brief.includes("swamp-getting-started"));
  assert(!brief.includes("# How to work on this\n\n1. Before you run"));
  assertEquals(briefTaskText(brief), text);
});

const PAGE = "http://127.0.0.1:41234/dashboard/w/swampify/swampify";

function swampifyBrief(text: string, url?: string | null): string {
  return renderBrief({
    task: StartTask.create(text, "swampify"),
    workspacePath: "/home/u/swampify",
    harnessDisplayName: "Claude Code",
    swampifyPageUrl: url,
  });
}

Deno.test("renderBrief: a kick-off brief links to the Swampify page after its context, and keeps its pinned text", () => {
  const text = SwampifyKickoff.create({ windowDays: 30 }, "linux").render();
  const brief = swampifyBrief(text, PAGE);
  assert(brief.endsWith(`- Agent: Claude Code\n- Swampify page: ${PAGE}\n`));
  assertEquals(briefTaskText(brief), text);
  assertEquals(
    brief.split("\n").filter((l) => l.startsWith(SWAMPIFY_PAGE_LINE_PREFIX)),
    [`- Swampify page: ${PAGE}`],
  );
});

Deno.test("renderBrief: a build brief links to the Swampify page too", () => {
  const text =
    "Automate this repeated chore as a swamp workflow: Release docs.";
  const brief = swampifyBrief(text, PAGE);
  assertStringIncludes(brief, `\n- Swampify page: ${PAGE}\n`);
  assertEquals(briefTaskText(brief), text);
});

Deno.test("renderBrief: no address, no Swampify page line", () => {
  for (const url of [undefined, null]) {
    const brief = swampifyBrief("Automate this.", url);
    assert(!brief.includes("Swampify page"), String(url));
  }
});

Deno.test("renderBrief: a typed task never gets the Swampify page line", () => {
  const brief = renderBrief({
    task: StartTask.create("list pods"),
    workspacePath: "/w",
    harnessDisplayName: "Claude Code",
    swampifyPageUrl: PAGE,
  });
  assert(!brief.includes("Swampify page"));
});

Deno.test("swampifyPageUrl: builds the page's address from a bare origin, with no token", () => {
  assertEquals(
    swampifyPageUrl("http://127.0.0.1:41234", "swampify"),
    "http://127.0.0.1:41234/dashboard/w/swampify/swampify",
  );
  assertEquals(
    swampifyPageUrl("https://swamp.example.test", "my work"),
    "https://swamp.example.test/dashboard/w/my%20work/swampify",
  );
  assertEquals(
    swampifyPageUrl("http://[::1]:8080", "w"),
    "http://[::1]:8080/dashboard/w/w/swampify",
  );
  const url = swampifyPageUrl("http://127.0.0.1:41234", "w")!;
  assert(!url.includes("#") && !url.includes("token"));
});

Deno.test("swampifyPageUrl: anything but a bare http(s) origin gives no address", () => {
  for (
    const origin of [
      "",
      "null",
      "javascript:alert(1)",
      "file:///etc",
      "ftp://host",
      "http://user:pw@host",
      "http://host/path",
      "http://host/",
      "http://host?x=1",
      "http://host#token=abc",
      "http://host\n- Agent: evil",
      "http://ho st",
      "HTTP://HOST",
      "[x](http://host)",
    ]
  ) {
    assertEquals(swampifyPageUrl(origin, "w"), null, origin);
  }
});
