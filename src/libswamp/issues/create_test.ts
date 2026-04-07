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
    submitToLab: () =>
      Promise.resolve({ number: 1, serverUrl: "https://swamp.club" }),
    ...overrides,
  };
}

Deno.test("issueCreate: submits bug to Lab and yields completed", async () => {
  const deps = makeDeps();

  const events = await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "Test bug",
      body: "Test body",
      type: "bug",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    IssueCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.method, "lab");
  assertEquals(completed.data.title, "Test bug");
  assertEquals(completed.data.type, "bug");
});

Deno.test("issueCreate: submits feature to Lab", async () => {
  const deps = makeDeps({
    submitToLab: () =>
      Promise.resolve({ number: 7, serverUrl: "https://swamp.club" }),
  });

  const events = await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "New feature",
      body: "Details",
      type: "feature",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    IssueCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.method, "lab");
  assertEquals((completed.data as { number: number }).number, 7);
  assertEquals(completed.data.type, "feature");
});

Deno.test("issueCreate: passes title, body, and type to submitToLab", async () => {
  let captured: { type: string; title: string; body: string } | undefined;
  const deps = makeDeps({
    submitToLab: (input) => {
      captured = input;
      return Promise.resolve({ number: 42, serverUrl: "https://swamp.club" });
    },
  });

  await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "My title",
      body: "My body",
      type: "bug",
    }),
  );

  assertEquals(captured?.type, "bug");
  assertEquals(captured?.title, "My title");
  assertEquals(captured?.body, "My body");
});

Deno.test("issueCreate: includes serverUrl in result", async () => {
  const deps = makeDeps({
    submitToLab: () =>
      Promise.resolve({
        number: 1,
        serverUrl: "https://custom.server.com",
      }),
  });

  const events = await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "Test",
      body: "Body",
      type: "bug",
    }),
  );

  const data = (events[0] as Extract<IssueCreateEvent, { kind: "completed" }>)
    .data;
  if (data.method === "lab") {
    assertEquals(data.serverUrl, "https://custom.server.com");
  }
});
