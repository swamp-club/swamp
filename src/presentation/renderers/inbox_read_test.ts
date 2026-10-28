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
import type { InboxMessageView } from "../../libswamp/inbox/list.ts";
import type {
  InboxReadNextView,
  MarkReadEvent,
} from "../../libswamp/inbox/read.ts";
import { notAuthenticated } from "../../libswamp/errors.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { OutputMode } from "../output/output.ts";
import {
  createInboxReadRenderer,
  createMarkReadRenderer,
} from "./inbox_read.ts";

/** An ISO timestamp at local noon, so its local date holds in every zone. */
function localNoon(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12).toISOString();
}

const MESSAGE: InboxMessageView = {
  id: "01JBX5Q8ZK0000000000000104",
  kind: "announcement",
  title: "Did I send the announcement?",
  body: "## What's new\n\nSee [the notes](https://swamp-club.com/notes).\n",
  createdAt: localNoon(2026, 10, 27),
  readAt: "2026-10-27T12:00:00.000Z",
  link: "https://swamp-club.com/blog/swamp-1-42",
  action: { label: "Update now", command: "swamp update" },
};

function makeView(
  overrides: Partial<InboxReadNextView> = {},
): InboxReadNextView {
  return {
    message: MESSAGE,
    marked: true,
    moreUnread: false,
    dropped: 0,
    ...overrides,
  };
}

function captureOutput(run: () => void): { stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => out.push(msg);
  console.error = (msg: string) => err.push(msg);
  try {
    run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return {
    stdout: stripAnsiCode(out.join("\n")),
    stderr: stripAnsiCode(err.join("\n")),
  };
}

function capture(view: InboxReadNextView, mode: OutputMode) {
  return captureOutput(() =>
    createInboxReadRenderer(mode).handlers().completed({
      kind: "completed",
      view,
    })
  );
}

Deno.test("LogInboxReadRenderer: the message, its link and its Next line", () => {
  assertEquals(
    capture(makeView(), "log"),
    {
      stdout: [
        "announcement · 2026-10-27",
        "Did I send the announcement?",
        "",
        "## What's new",
        "",
        "See [the notes](https://swamp-club.com/notes).",
        "",
        "Link:  https://swamp-club.com/blog/swamp-1-42",
        "Next:  swamp update",
      ].join("\n"),
      stderr: "",
    },
  );
});

Deno.test("LogInboxReadRenderer: points to the next only while more are unread", () => {
  assertEquals(
    capture(makeView({ moreUnread: true }), "log").stdout.split("\n").slice(-2),
    ["", "To read the next:  swamp inbox read"],
  );
  assertEquals(
    capture(makeView(), "log").stdout.includes("To read the next"),
    false,
  );
});

Deno.test("LogInboxReadRenderer: a message with no link or action ends with its body", () => {
  const plain: InboxMessageView = {
    ...MESSAGE,
    body: "Thanks.",
    link: undefined,
    action: undefined,
  };
  delete plain.link;
  delete plain.action;

  assertEquals(
    capture(makeView({ message: plain }), "log").stdout.split("\n").at(-1),
    "Thanks.",
  );
});

Deno.test("LogInboxReadRenderer: nothing unread", () => {
  assertEquals(
    capture(makeView({ message: null, marked: false }), "log"),
    { stdout: "No unread messages.", stderr: "" },
  );
});

Deno.test("LogInboxReadRenderer: warns on stderr about dropped and unmarked messages", () => {
  assertEquals(
    capture(makeView({ message: null, marked: false, dropped: 1 }), "log")
      .stderr,
    "1 message from Swamp Club did not match the inbox format and was left out.",
  );
  assertEquals(
    capture(makeView({ marked: false }), "log").stderr,
    "Swamp Club did not confirm this message as read, so it is still unread.",
  );
});

Deno.test("JsonInboxReadRenderer: the message, moreUnread and dropped", () => {
  assertEquals(
    JSON.parse(capture(makeView({ moreUnread: true }), "json").stdout),
    {
      message: {
        id: MESSAGE.id,
        kind: "announcement",
        title: "Did I send the announcement?",
        body: MESSAGE.body,
        createdAt: MESSAGE.createdAt,
        link: "https://swamp-club.com/blog/swamp-1-42",
        action: { label: "Update now", command: "swamp update" },
        readAt: "2026-10-27T12:00:00.000Z",
      },
      moreUnread: true,
      dropped: 0,
    },
  );
});

Deno.test("JsonInboxReadRenderer: nothing unread is a null message", () => {
  assertEquals(
    JSON.parse(
      capture(makeView({ message: null, marked: false, dropped: 2 }), "json")
        .stdout,
    ),
    { message: null, moreUnread: false, dropped: 2 },
  );
});

Deno.test("createInboxReadRenderer: an error event throws a UserError", () => {
  for (const mode of ["log", "json"] as const) {
    assertThrows(
      () =>
        createInboxReadRenderer(mode).handlers().error({
          kind: "error",
          error: notAuthenticated(),
        }),
      UserError,
    );
  }
});

function markRead(
  marked: string[],
  announce: boolean,
): string {
  const handlers: EventHandlers<MarkReadEvent> = createMarkReadRenderer({
    announce,
  }).handlers();
  return captureOutput(() => handlers.completed({ kind: "completed", marked }))
    .stdout;
}

Deno.test("createMarkReadRenderer: counts what was marked, only when announcing", () => {
  assertEquals(markRead(["A"], true), "Marked 1 message read.");
  assertEquals(markRead(["A", "B"], true), "Marked 2 messages read.");
  assertEquals(markRead([], true), "Marked 0 messages read.");
  assertEquals(markRead(["A"], false), "");
});
