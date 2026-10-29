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

import { assertEquals, assertThrows } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { UserError } from "../../domain/errors.ts";
import type { InboxListView } from "../../libswamp/inbox/list.ts";
import { notAuthenticated } from "../../libswamp/errors.ts";
import type { OutputMode } from "../output/output.ts";
import {
  createInboxListRenderer,
  droppedWarning,
  localDate,
} from "./inbox_list.ts";

/** An ISO timestamp at local noon, so its local date holds in every zone. */
function localNoon(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12).toISOString();
}

function makeView(overrides: Partial<InboxListView> = {}): InboxListView {
  return {
    status: "unread",
    messages: [
      {
        id: "01JBX5Q8ZK0000000000000104",
        kind: "announcement",
        title: "swamp 1.42 is out",
        createdAt: localNoon(2026, 10, 26),
        readAt: null,
      },
      {
        id: "01JBX5Q8ZK00000000000000ZX",
        kind: "issue_update",
        title: "Your issue #3990 shipped",
        createdAt: localNoon(2026, 10, 25),
        readAt: null,
      },
      {
        id: "01JBX5Q8ZK00000000000000ZP",
        kind: "points",
        title: "You earned 50 points",
        createdAt: localNoon(2026, 10, 24),
        readAt: localNoon(2026, 10, 24),
      },
    ],
    nextCursor: null,
    dropped: 0,
    ...overrides,
  };
}

function capture(
  view: InboxListView,
  mode: OutputMode,
): { stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => out.push(msg);
  console.error = (msg: string) => err.push(msg);
  try {
    createInboxListRenderer(mode).handlers().completed({
      kind: "completed",
      view,
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return {
    stdout: stripAnsiCode(out.join("\n")),
    stderr: stripAnsiCode(err.join("\n")),
  };
}

Deno.test("localDate: the local calendar date of a timestamp", () => {
  assertEquals(localDate(localNoon(2026, 1, 5)), "2026-01-05");
  assertEquals(localDate(localNoon(2026, 12, 31)), "2026-12-31");
});

Deno.test("LogInboxListRenderer: marks unread rows, pads the kind and title, ends rows with the id and counts", () => {
  assertEquals(
    capture(makeView({ status: "all" }), "log").stdout,
    [
      "●  2026-10-26  announcement  swamp 1.42 is out         01JBX5Q8ZK0000000000000104",
      "●  2026-10-25  issue_update  Your issue #3990 shipped  01JBX5Q8ZK00000000000000ZX",
      "   2026-10-24  points        You earned 50 points      01JBX5Q8ZK00000000000000ZP",
      "",
      "2 unread of 3 shown.",
      "To read one:  swamp inbox read <id>",
    ].join("\n"),
  );
});

Deno.test("LogInboxListRenderer: the To read one line comes before To see older", () => {
  const cursor = "01JBX5Q8ZK00000000000000ZP";

  assertEquals(
    capture(makeView({ nextCursor: cursor }), "log").stdout.split("\n")
      .slice(-3),
    [
      "2 unread of 3 shown.",
      "To read one:  swamp inbox read <id>",
      `To see older:  swamp inbox --before ${cursor}`,
    ],
  );
});

Deno.test("LogInboxListRenderer: an empty list has no To read one line", () => {
  assertEquals(
    capture(makeView({ messages: [] }), "log").stdout.includes("To read one"),
    false,
  );
});

Deno.test("LogInboxListRenderer: suggests the older page only when there is one", () => {
  const cursor = "01JBX5Q8ZK00000000000000ZP";

  assertEquals(
    capture(makeView({ nextCursor: cursor }), "log").stdout.split("\n").at(-1),
    `To see older:  swamp inbox --before ${cursor}`,
  );
  assertEquals(
    capture(makeView({ status: "all", nextCursor: cursor }), "log").stdout
      .split("\n").at(-1),
    `To see older:  swamp inbox --all --before ${cursor}`,
  );
  assertEquals(
    capture(makeView(), "log").stdout.includes("To see older"),
    false,
  );
});

Deno.test("LogInboxListRenderer: the two empty states", () => {
  assertEquals(
    capture(makeView({ messages: [] }), "log").stdout,
    "No unread messages. To include read ones:  swamp inbox --all",
  );
  assertEquals(
    capture(makeView({ status: "all", messages: [] }), "log").stdout,
    "Your inbox is empty.",
  );
});

Deno.test("LogInboxListRenderer: warns on stderr when messages were left out", () => {
  const one = capture(makeView({ dropped: 1 }), "log");
  assertEquals(
    one.stderr,
    "1 message from Swamp Club did not match the inbox format and was left out.",
  );
  assertEquals(one.stdout.includes("left out"), false);

  assertEquals(
    capture(makeView({ messages: [], dropped: 3 }), "log").stderr,
    "3 messages from Swamp Club did not match the inbox format and were left out.",
  );
  assertEquals(capture(makeView(), "log").stderr, "");
});

Deno.test("droppedWarning: none when nothing was left out", () => {
  assertEquals(droppedWarning(0), undefined);
});

Deno.test("JsonInboxListRenderer: prints exactly the documented fields, nothing on stderr", () => {
  const view = makeView({
    dropped: 1,
    nextCursor: "01JBX5Q8ZK00000000000000ZP",
  });

  const { stdout, stderr } = capture(view, "json");

  assertEquals(JSON.parse(stdout), {
    status: "unread",
    messages: view.messages,
    nextCursor: "01JBX5Q8ZK00000000000000ZP",
    dropped: 1,
  });
  assertEquals(stderr, "");
});

Deno.test("JsonInboxListRenderer: extra view fields never reach the document", () => {
  const view = makeView();
  const leaky = {
    ...view,
    messages: view.messages.map((m) => ({ ...m, body: "secret" })),
  };

  const { stdout } = capture(leaky, "json");

  assertEquals(stdout.includes("secret"), false);
});

Deno.test("InboxListRenderer: an error event throws a UserError in both modes", () => {
  for (const mode of ["log", "json"] as const) {
    assertThrows(
      () =>
        createInboxListRenderer(mode).handlers().error({
          kind: "error",
          error: notAuthenticated(),
        }),
      UserError,
    );
  }
});
