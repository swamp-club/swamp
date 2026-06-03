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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  issueComment,
  type IssueCommentDeps,
  type IssueCommentEvent,
  MAX_RIPPLE_LENGTH,
} from "./comment.ts";

function makeDeps(overrides: Partial<IssueCommentDeps> = {}): IssueCommentDeps {
  return {
    submitToLab: () =>
      Promise.resolve({
        commentId: "ripple-123",
        serverUrl: "https://swamp-club.com",
      }),
    ...overrides,
  };
}

Deno.test("issueComment: yields completed with issue number and comment id", async () => {
  const events = await collect<IssueCommentEvent>(
    issueComment(createLibSwampContext(), makeDeps(), {
      issueNumber: 42,
      body: "Helpful follow-up.",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    IssueCommentEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.issueNumber, 42);
  assertEquals(completed.data.commentId, "ripple-123");
  assertEquals(completed.data.serverUrl, "https://swamp-club.com");
});

Deno.test("issueComment: passes body and issueNumber to submitToLab", async () => {
  let captured: { issueNumber: number; body: string } | undefined;
  const deps = makeDeps({
    submitToLab: (input) => {
      captured = input;
      return Promise.resolve({
        commentId: "ripple-7",
        serverUrl: "https://swamp-club.com",
      });
    },
  });

  await collect(
    issueComment(createLibSwampContext(), deps, {
      issueNumber: 99,
      body: "Multi\nline\nbody.",
    }),
  );

  assertEquals(captured?.issueNumber, 99);
  assertEquals(captured?.body, "Multi\nline\nbody.");
});

Deno.test("issueComment: rejects empty body", async () => {
  await assertRejects(
    () =>
      collect(
        issueComment(createLibSwampContext(), makeDeps(), {
          issueNumber: 1,
          body: "",
        }),
      ),
    UserError,
    "must not be empty",
  );
});

Deno.test("issueComment: rejects whitespace-only body", async () => {
  await assertRejects(
    () =>
      collect(
        issueComment(createLibSwampContext(), makeDeps(), {
          issueNumber: 1,
          body: "   \n\t\n  ",
        }),
      ),
    UserError,
    "must not be empty",
  );
});

Deno.test("issueComment: rejects body exceeding max length", async () => {
  const tooLong = "x".repeat(MAX_RIPPLE_LENGTH + 1);
  const error = await assertRejects(
    () =>
      collect(
        issueComment(createLibSwampContext(), makeDeps(), {
          issueNumber: 1,
          body: tooLong,
        }),
      ),
    UserError,
  );
  assertStringIncludes(error.message, String(MAX_RIPPLE_LENGTH));
});

Deno.test("issueComment: calls updateStatus and sets statusChanged on success", async () => {
  let statusCalled = false;
  const deps = makeDeps({
    updateStatus: (input) => {
      statusCalled = true;
      assertEquals(input.issueNumber, 42);
      assertEquals(input.status, "closed");
      return Promise.resolve();
    },
  });

  const events = await collect<IssueCommentEvent>(
    issueComment(createLibSwampContext(), deps, {
      issueNumber: 42,
      body: "Closing this.",
      statusTransition: "closed",
    }),
  );

  assertEquals(statusCalled, true);
  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    IssueCommentEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.statusChanged, "closed");
  assertEquals(completed.data.statusError, undefined);
});

Deno.test("issueComment: sets statusError on update failure without losing the comment", async () => {
  const deps = makeDeps({
    updateStatus: () => Promise.reject(new Error("forbidden")),
  });

  const events = await collect<IssueCommentEvent>(
    issueComment(createLibSwampContext(), deps, {
      issueNumber: 42,
      body: "Try to close.",
      statusTransition: "closed",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    IssueCommentEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.commentId, "ripple-123");
  assertEquals(completed.data.statusChanged, undefined);
  assertStringIncludes(completed.data.statusError!, "forbidden");
});

Deno.test("issueComment: skips status update when no statusTransition", async () => {
  let statusCalled = false;
  const deps = makeDeps({
    updateStatus: () => {
      statusCalled = true;
      return Promise.resolve();
    },
  });

  await collect(
    issueComment(createLibSwampContext(), deps, {
      issueNumber: 42,
      body: "No status change.",
    }),
  );

  assertEquals(statusCalled, false);
});

Deno.test("issueComment: accepts body at exactly the max length", async () => {
  const exactlyMax = "x".repeat(MAX_RIPPLE_LENGTH);
  const events = await collect<IssueCommentEvent>(
    issueComment(createLibSwampContext(), makeDeps(), {
      issueNumber: 1,
      body: exactlyMax,
    }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "completed");
});
