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

import { assertEquals, assertRejects } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { issueEdit, type IssueEditDeps, type IssueEditEvent } from "./edit.ts";

function makeDeps(overrides: Partial<IssueEditDeps> = {}): IssueEditDeps {
  return {
    updateIssue: () =>
      Promise.resolve({
        title: "Updated title",
        body: "Updated body",
        type: "bug",
        url: "https://swamp-club.com/lab/42",
      }),
    ...overrides,
  };
}

Deno.test("issueEdit: yields completed when title changes", async () => {
  const events = await collect<IssueEditEvent>(
    issueEdit(createLibSwampContext(), makeDeps(), {
      issueNumber: 42,
      title: "New title",
      body: "Same body",
      originalTitle: "Old title",
      originalBody: "Same body",
    }),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "completed");
  const completed = events[0] as Extract<IssueEditEvent, { kind: "completed" }>;
  assertEquals(completed.data.issueNumber, 42);
  assertEquals(completed.data.url, "https://swamp-club.com/lab/42");
});

Deno.test("issueEdit: yields completed when body changes", async () => {
  const events = await collect<IssueEditEvent>(
    issueEdit(createLibSwampContext(), makeDeps(), {
      issueNumber: 10,
      title: "Same title",
      body: "New body",
      originalTitle: "Same title",
      originalBody: "Old body",
    }),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "completed");
});

Deno.test("issueEdit: yields noop when nothing changes", async () => {
  let updateCalled = false;
  const deps = makeDeps({
    updateIssue: () => {
      updateCalled = true;
      return Promise.resolve({
        title: "Same",
        body: "Same",
        type: "bug",
        url: "https://swamp-club.com/lab/42",
      });
    },
  });

  const events = await collect<IssueEditEvent>(
    issueEdit(createLibSwampContext(), deps, {
      issueNumber: 5,
      title: "Same",
      body: "Same",
      originalTitle: "Same",
      originalBody: "Same",
    }),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "noop");
  assertEquals(updateCalled, false);
});

Deno.test("issueEdit: sends only changed fields to updateIssue", async () => {
  let capturedFields: { title?: string; body?: string; type?: string } = {};
  const deps = makeDeps({
    updateIssue: (input) => {
      capturedFields = input.fields;
      return Promise.resolve({
        title: input.fields.title ?? "Original",
        body: input.fields.body ?? "Original",
        type: "bug",
        url: "https://swamp-club.com/lab/42",
      });
    },
  });

  await collect(
    issueEdit(createLibSwampContext(), deps, {
      issueNumber: 1,
      title: "Changed title",
      body: "Same body",
      originalTitle: "Old title",
      originalBody: "Same body",
    }),
  );

  assertEquals(capturedFields.title, "Changed title");
  assertEquals(capturedFields.body, undefined);
});

Deno.test("issueEdit: rejects empty title", async () => {
  await assertRejects(
    () =>
      collect(
        issueEdit(createLibSwampContext(), makeDeps(), {
          issueNumber: 1,
          title: "  ",
          body: "body",
          originalTitle: "Old title",
          originalBody: "body",
        }),
      ),
    UserError,
    "Title must not be empty",
  );
});

Deno.test("issueEdit: sends both fields when both change", async () => {
  let capturedFields: { title?: string; body?: string; type?: string } = {};
  const deps = makeDeps({
    updateIssue: (input) => {
      capturedFields = input.fields;
      return Promise.resolve({
        title: "New title",
        body: "New body",
        type: "bug",
        url: "https://swamp-club.com/lab/42",
      });
    },
  });

  await collect(
    issueEdit(createLibSwampContext(), deps, {
      issueNumber: 1,
      title: "New title",
      body: "New body",
      originalTitle: "Old title",
      originalBody: "Old body",
    }),
  );

  assertEquals(capturedFields.title, "New title");
  assertEquals(capturedFields.body, "New body");
});

Deno.test("issueEdit: yields completed when type changes", async () => {
  const deps = makeDeps({
    updateIssue: () =>
      Promise.resolve({
        title: "Same",
        body: "Same",
        type: "security",
        url: "https://swamp-club.com/lab/42",
      }),
  });

  const events = await collect<IssueEditEvent>(
    issueEdit(createLibSwampContext(), deps, {
      issueNumber: 42,
      title: "Same",
      body: "Same",
      type: "security",
      originalTitle: "Same",
      originalBody: "Same",
      originalType: "bug",
    }),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "completed");
  const completed = events[0] as Extract<IssueEditEvent, { kind: "completed" }>;
  assertEquals(completed.data.type, "security");
});

Deno.test("issueEdit: yields noop when type is unchanged", async () => {
  let updateCalled = false;
  const deps = makeDeps({
    updateIssue: () => {
      updateCalled = true;
      return Promise.resolve({
        title: "Same",
        body: "Same",
        type: "bug",
        url: "https://swamp-club.com/lab/42",
      });
    },
  });

  const events = await collect<IssueEditEvent>(
    issueEdit(createLibSwampContext(), deps, {
      issueNumber: 5,
      title: "Same",
      body: "Same",
      type: "bug",
      originalTitle: "Same",
      originalBody: "Same",
      originalType: "bug",
    }),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "noop");
  assertEquals(updateCalled, false);
});

Deno.test("issueEdit: sends type and title when both change", async () => {
  let capturedFields: { title?: string; body?: string; type?: string } = {};
  const deps = makeDeps({
    updateIssue: (input) => {
      capturedFields = input.fields;
      return Promise.resolve({
        title: "New title",
        body: "Same body",
        type: "security",
        url: "https://swamp-club.com/lab/42",
      });
    },
  });

  await collect(
    issueEdit(createLibSwampContext(), deps, {
      issueNumber: 1,
      title: "New title",
      body: "Same body",
      type: "security",
      originalTitle: "Old title",
      originalBody: "Same body",
      originalType: "bug",
    }),
  );

  assertEquals(capturedFields.title, "New title");
  assertEquals(capturedFields.body, undefined);
  assertEquals(capturedFields.type, "security");
});

Deno.test("issueEdit: includes type in data even when type did not change", async () => {
  const events = await collect<IssueEditEvent>(
    issueEdit(createLibSwampContext(), makeDeps(), {
      issueNumber: 42,
      title: "New title",
      body: "Same body",
      originalTitle: "Old title",
      originalBody: "Same body",
      originalType: "bug",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<IssueEditEvent, { kind: "completed" }>;
  assertEquals(completed.data.type, "bug");
});
