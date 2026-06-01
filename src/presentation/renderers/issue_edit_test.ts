// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { createIssueEditRenderer } from "./issue_edit.ts";

await initializeLogging({});

function captureStdout(fn: () => void): string {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

Deno.test("createIssueEditRenderer: json completed handler outputs structured data", () => {
  const renderer = createIssueEditRenderer("json");
  const handlers = renderer.handlers();
  const out = captureStdout(() =>
    handlers.completed({
      kind: "completed",
      data: {
        issueNumber: 42,
        title: "Updated title",
        body: "Updated body",
        serverUrl: "https://swamp-club.com",
      },
    })
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.issueNumber, 42);
  assertEquals(parsed.title, "Updated title");
  assertEquals(parsed.body, "Updated body");
  assertEquals(parsed.serverUrl, "https://swamp-club.com");
});

Deno.test("createIssueEditRenderer: json noop handler outputs status", () => {
  const renderer = createIssueEditRenderer("json");
  const handlers = renderer.handlers();
  const out = captureStdout(() =>
    handlers.noop({
      kind: "noop",
      issueNumber: 7,
    })
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.status, "noop");
  assertEquals(parsed.issueNumber, 7);
});

Deno.test("createIssueEditRenderer: log completed handler does not throw", () => {
  const renderer = createIssueEditRenderer("log");
  const handlers = renderer.handlers();
  handlers.completed({
    kind: "completed",
    data: {
      issueNumber: 42,
      title: "Updated",
      body: "Body",
      serverUrl: "https://swamp-club.com",
    },
  });
});

Deno.test("createIssueEditRenderer: log noop handler does not throw", () => {
  const renderer = createIssueEditRenderer("log");
  const handlers = renderer.handlers();
  handlers.noop({
    kind: "noop",
    issueNumber: 5,
  });
});

Deno.test("createIssueEditRenderer: json completed output is valid JSON with serverUrl", () => {
  const renderer = createIssueEditRenderer("json");
  const handlers = renderer.handlers();
  const out = captureStdout(() =>
    handlers.completed({
      kind: "completed",
      data: {
        issueNumber: 100,
        title: "T",
        body: "B",
        serverUrl: "https://example.com",
      },
    })
  );
  JSON.parse(out);
  assertStringIncludes(out, "https://example.com");
});
