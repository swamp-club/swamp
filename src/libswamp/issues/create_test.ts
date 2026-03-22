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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  issueCreate,
  type IssueCreateDeps,
  type IssueCreateEvent,
} from "./create.ts";

function makeDeps(overrides: Partial<IssueCreateDeps> = {}): IssueCreateDeps {
  return {
    createIssue: () =>
      Promise.resolve({
        method: "created" as const,
        url: "https://github.com/systeminit/swamp/issues/1",
        number: 1,
      }),
    ...overrides,
  };
}

Deno.test("issueCreate: yields completed with created method", async () => {
  const deps = makeDeps();

  const events = await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "Test issue",
      body: "Test body",
      labels: ["bug"],
      type: "bug",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    IssueCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.method, "created");
  assertEquals(completed.data.title, "Test issue");
  assertEquals(completed.data.type, "bug");
});

Deno.test("issueCreate: yields completed with url method", async () => {
  const deps = makeDeps({
    createIssue: () =>
      Promise.resolve({
        method: "url" as const,
        url: "https://github.com/systeminit/swamp/issues/new?title=Test",
        body: "Test body",
        labels: ["feature"],
      }),
  });

  const events = await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "Test feature",
      body: "Test body",
      labels: ["feature"],
      type: "feature",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    IssueCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.method, "url");
  assertEquals(completed.data.title, "Test feature");
  assertEquals(completed.data.type, "feature");
});
