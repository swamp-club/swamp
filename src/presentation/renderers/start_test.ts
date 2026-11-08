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
import { stripAnsiCode } from "@std/fmt/colors";
import {
  createStartRenderer,
  formatCreated,
  pageReadyLine,
  stopHint,
  taskDetail,
} from "./start.ts";

Deno.test("formatCreated: the local date and time a task was created", () => {
  // Built from local fields, so the test holds in any time zone.
  const created = new Date(2026, 9, 12, 14, 5).toISOString();
  assertEquals(formatCreated(created), "2026-10-12 14:05");
  assertEquals(formatCreated("not a date"), "not a date");
});

Deno.test("taskDetail: when the task was created, and how far it got", () => {
  const createdAt = new Date(2026, 9, 12, 9, 30).toISOString();
  const base = {
    id: "t",
    title: "List my pods",
    harness: null,
    harnessDisplayName: null,
    createdAt,
    launchedAt: null,
    briefFile: null,
  };
  assertEquals(
    taskDetail({ ...base, step: "agent" }),
    "created 2026-10-12 09:30 · at the agent step",
  );
  assertEquals(
    taskDetail({
      ...base,
      step: "launched",
      harness: "claude",
      harnessDisplayName: "Claude Code",
      launchedAt: createdAt,
    }),
    "created 2026-10-12 09:30 · launched with Claude Code",
  );
});

Deno.test("pageReadyLine: swamp start names itself; swamp dashboard names the repo's dashboard", () => {
  assertEquals(
    pageReadyLine(true, false),
    "Opened swamp start in your browser. If it didn't appear, open:",
  );
  assertEquals(
    pageReadyLine(true, true),
    "Opened this repo's dashboard in your browser. If it didn't appear, open:",
  );
  assertEquals(
    pageReadyLine(false, true),
    "Open this page in your browser to continue:",
  );
});

function captureStdout(run: () => void): string[] {
  const out: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => out.push(stripAnsiCode(msg));
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return out;
}

Deno.test("pageReady: proxy URLs come before the stop hint, which stays the last line", () => {
  const renderer = createStartRenderer("log");
  const url = "http://127.0.0.1:1/dashboard/w/r#token=t";
  assertEquals(
    captureStdout(() =>
      renderer.pageReady(url, false, true, [
        "https://a.example/dashboard/w/r#token=t",
        "https://b.example/dashboard/w/r#token=t",
      ])
    ),
    [
      "",
      pageReadyLine(false, true),
      `  ${url}`,
      "Through your proxy (it must serve HTTPS), open:",
      "  https://a.example/dashboard/w/r#token=t",
      "  https://b.example/dashboard/w/r#token=t",
      "Press Ctrl-C to stop it. Closing this terminal leaves it running.",
    ],
  );
  assertEquals(captureStdout(() => renderer.pageReady(url, false, true)), [
    "",
    pageReadyLine(false, true),
    `  ${url}`,
    "Press Ctrl-C to stop it. Closing this terminal leaves it running.",
  ]);
  assertEquals(
    captureStdout(() =>
      createStartRenderer("json").pageReady(url, false, true, ["https://a/"])
    ),
    [],
  );
});

Deno.test("stopHint: swamp start says its terminal keeps the page; swamp dashboard says closing it leaves it running", () => {
  assertEquals(
    stopHint(false),
    "This terminal keeps the page running. Press Ctrl-C to stop it.",
  );
  assertEquals(
    stopHint(true),
    "Press Ctrl-C to stop it. Closing this terminal leaves it running.",
  );
});
