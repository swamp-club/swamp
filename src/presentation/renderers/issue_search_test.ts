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

import { assertEquals } from "@std/assert";
import { assertThrows } from "@std/assert/throws";
import { createIssueSearchRenderer } from "./issue_search.ts";
import { UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

await initializeLogging({});

Deno.test("issue search renderer: json mode outputs JSON", () => {
  const renderer = createIssueSearchRenderer("json");
  const handlers = renderer.handlers();

  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(String(args[0]));
  try {
    const event = {
      kind: "completed" as const,
      data: {
        issues: [
          {
            number: 1,
            title: "Test",
            type: "bug",
            status: "open",
            author: "alice",
          },
        ],
        total: 1,
        serverUrl: "https://swamp-club.com",
      },
    };
    handlers.completed(event);
    const parsed = JSON.parse(output.join(""));
    assertEquals(parsed.total, 1);
    assertEquals(parsed.issues.length, 1);
    assertEquals(parsed.issues[0].number, 1);
  } finally {
    console.log = origLog;
  }
});

Deno.test("issue search renderer: json error throws UserError", () => {
  const renderer = createIssueSearchRenderer("json");
  const handlers = renderer.handlers();

  const event = {
    kind: "error" as const,
    error: { code: "search_failed", message: "something went wrong" },
  };
  assertThrows(
    () => handlers.error(event),
    UserError,
    "something went wrong",
  );
});

Deno.test("issue search renderer: log error throws UserError", () => {
  const renderer = createIssueSearchRenderer("log");
  const handlers = renderer.handlers();

  const event = {
    kind: "error" as const,
    error: { code: "search_failed", message: "search failed" },
  };
  assertThrows(
    () => handlers.error(event),
    UserError,
    "search failed",
  );
});

Deno.test("issue search renderer: log mode renders without throwing", () => {
  const renderer = createIssueSearchRenderer("log");
  const handlers = renderer.handlers();

  handlers.completed({
    kind: "completed",
    data: {
      issues: [
        {
          number: 42,
          title: "Fix the thing",
          type: "bug",
          status: "open",
          author: "bob",
        },
      ],
      total: 1,
      serverUrl: "https://swamp-club.com",
    },
  });
});

Deno.test("issue search renderer: log mode handles empty results", () => {
  const renderer = createIssueSearchRenderer("log");
  const handlers = renderer.handlers();

  handlers.completed({
    kind: "completed",
    data: {
      issues: [],
      total: 0,
      serverUrl: "https://swamp-club.com",
    },
  });
});

Deno.test("issue search renderer: log mode handles partial results", () => {
  const renderer = createIssueSearchRenderer("log");
  const handlers = renderer.handlers();

  handlers.completed({
    kind: "completed",
    data: {
      issues: [
        {
          number: 1,
          title: "First",
          type: "bug",
          status: "open",
          author: "alice",
        },
      ],
      total: 50,
      serverUrl: "https://swamp-club.com",
    },
  });
});
