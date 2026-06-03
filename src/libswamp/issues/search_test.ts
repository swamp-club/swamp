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
import {
  issueSearch,
  type IssueSearchData,
  type IssueSearchDeps,
  type IssueSearchEvent,
  type IssueSearchInput,
} from "./search.ts";
import { createLibSwampContext } from "../context.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

await initializeLogging({});

function collectEvents(
  gen: AsyncIterable<IssueSearchEvent>,
): Promise<IssueSearchEvent[]> {
  return Array.fromAsync(gen);
}

Deno.test("issueSearch: returns completed event with search results", async () => {
  const mockData: IssueSearchData = {
    issues: [
      {
        number: 42,
        title: "Test issue",
        type: "bug",
        status: "open",
        author: "alice",
      },
    ],
    total: 1,
    serverUrl: "https://swamp-club.com",
  };

  const deps: IssueSearchDeps = {
    searchIssues: (_input: IssueSearchInput) => Promise.resolve(mockData),
  };

  const ctx = createLibSwampContext({});
  const events = await collectEvents(
    issueSearch(ctx, deps, { q: "test" }),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "completed");
  if (events[0].kind === "completed") {
    assertEquals(events[0].data.issues.length, 1);
    assertEquals(events[0].data.issues[0].number, 42);
    assertEquals(events[0].data.total, 1);
    assertEquals(events[0].data.serverUrl, "https://swamp-club.com");
  }
});

Deno.test("issueSearch: passes input filters to deps", async () => {
  let capturedInput: IssueSearchInput | undefined;
  const deps: IssueSearchDeps = {
    searchIssues: (input: IssueSearchInput) => {
      capturedInput = input;
      return Promise.resolve({
        issues: [],
        total: 0,
        serverUrl: "https://swamp-club.com",
      });
    },
  };

  const ctx = createLibSwampContext({});
  const input: IssueSearchInput = {
    q: "vault",
    type: "feature",
    status: "open",
    source: "swamp",
    limit: 25,
  };
  await collectEvents(issueSearch(ctx, deps, input));

  assertEquals(capturedInput, input);
});

Deno.test("issueSearch: returns empty results", async () => {
  const deps: IssueSearchDeps = {
    searchIssues: () =>
      Promise.resolve({
        issues: [],
        total: 0,
        serverUrl: "https://swamp-club.com",
      }),
  };

  const ctx = createLibSwampContext({});
  const events = await collectEvents(
    issueSearch(ctx, deps, {}),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "completed");
  if (events[0].kind === "completed") {
    assertEquals(events[0].data.issues.length, 0);
    assertEquals(events[0].data.total, 0);
  }
});
