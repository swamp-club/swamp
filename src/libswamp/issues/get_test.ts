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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { issueGet, type IssueGetDeps, type IssueGetEvent } from "./get.ts";

function makeDeps(overrides: Partial<IssueGetDeps> = {}): IssueGetDeps {
  return {
    fetchIssue: () =>
      Promise.resolve({
        number: 42,
        title: "Example issue",
        type: "bug",
        status: "open",
        author: "testuser",
        body: "Something is broken.",
        assignees: ["alice"],
        commentCount: 3,
        serverUrl: "https://swamp-club.com",
      }),
    ...overrides,
  };
}

Deno.test("issueGet: yields completed with fetched issue data", async () => {
  const events = await collect<IssueGetEvent>(
    issueGet(createLibSwampContext(), makeDeps(), { issueNumber: 42 }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<IssueGetEvent, { kind: "completed" }>;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.number, 42);
  assertEquals(completed.data.title, "Example issue");
  assertEquals(completed.data.type, "bug");
  assertEquals(completed.data.status, "open");
  assertEquals(completed.data.author, "testuser");
  assertEquals(completed.data.body, "Something is broken.");
  assertEquals(completed.data.assignees, ["alice"]);
  assertEquals(completed.data.commentCount, 3);
  assertEquals(completed.data.serverUrl, "https://swamp-club.com");
});

Deno.test("issueGet: passes issueNumber to fetchIssue dep", async () => {
  let captured: number | undefined;
  const deps = makeDeps({
    fetchIssue: (issueNumber) => {
      captured = issueNumber;
      return Promise.resolve({
        number: issueNumber,
        title: "Captured",
        type: "feature",
        status: "triaged",
        author: "bob",
        body: "A feature.",
        assignees: [],
        commentCount: 0,
        serverUrl: "https://swamp-club.com",
      });
    },
  });

  await collect(
    issueGet(createLibSwampContext(), deps, { issueNumber: 99 }),
  );

  assertEquals(captured, 99);
});
