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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { render } from "ink-testing-library";
import { waitFor } from "@swamp-club/swamp-testing";
import type {
  InboxBrowseView,
  InboxMessageView,
} from "../../libswamp/inbox/list.ts";
import type {
  InboxMarkOutcome,
  InboxMarkSession,
} from "../../libswamp/inbox/read.ts";
import { pressOnFrame } from "./components/press_on_frame_test_helpers.ts";
import {
  connectInboxTui,
  createInboxTuiRenderer,
  INBOX_MESSAGE_KEYS,
  inboxListKeys,
  type InboxMarkReason,
  inboxMessageLines,
  inboxQuitLine,
  InboxTui,
  type InboxTuiBackend,
  newestUnreadIndex,
} from "./inbox_tui.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

/** An ISO timestamp at local noon, so its local date holds in every zone. */
function localNoon(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12).toISOString();
}

const ANNOUNCEMENT: InboxMessageView = {
  id: "01JBX5Q8ZK0000000000000104",
  kind: "announcement",
  title: "swamp 1.42 is out",
  body: "Read [the notes](https://swamp-club.com/blog/swamp-1-42).",
  createdAt: localNoon(2026, 10, 26),
  readAt: null,
  link: "https://swamp-club.com/blog/swamp-1-42",
  action: { label: "Update now", command: "swamp update" },
};
const ISSUE: InboxMessageView = {
  id: "01JBX5Q8ZK00000000000000ZX",
  kind: "issue_update",
  title: "Your issue #3990 shipped",
  body: "The fix is in swamp 1.42.",
  createdAt: localNoon(2026, 10, 25),
  readAt: null,
};
const POINTS: InboxMessageView = {
  id: "01JBX5Q8ZK00000000000000ZP",
  kind: "points",
  title: "You earned 50 points",
  body: "Thanks for filing a reproducible bug.",
  createdAt: localNoon(2026, 10, 24),
  readAt: localNoon(2026, 10, 24),
};
const OLDER: InboxMessageView = {
  id: "01JBX5Q8ZK00000000000000ZF",
  kind: "direct",
  title: "Welcome to the swamp",
  body: "Glad to have you.",
  createdAt: localNoon(2026, 10, 23),
  readAt: null,
};

function makeView(
  messages: InboxMessageView[],
  nextCursor: string | null = null,
): InboxBrowseView {
  return { messages, nextCursor, dropped: 0 };
}

interface FakeBackend extends InboxTuiBackend {
  marks: { ids: string[]; reason: InboxMarkReason }[];
  loads: string[];
}

function fakeBackend(
  options: {
    outcome?: (ids: readonly string[]) => Promise<InboxMarkOutcome>;
    older?: InboxBrowseView;
  } = {},
): FakeBackend {
  const backend: FakeBackend = {
    marks: [],
    loads: [],
    markRead: (ids, reason) => {
      backend.marks.push({ ids: [...ids], reason });
      return options.outcome?.(ids) ??
        Promise.resolve({ kind: "confirmed", ids: [...ids] });
    },
    loadOlder: (cursor) => {
      backend.loads.push(cursor);
      return Promise.resolve(options.older ?? makeView([]));
    },
  };
  return backend;
}

function openInbox(view: InboxBrowseView, backend = fakeBackend()) {
  let quits = 0;
  const instance = render(
    <InboxTui initial={view} backend={backend} onQuit={() => quits++} />,
  );
  const frame = () => stripAnsiCode(instance.lastFrame() ?? "");
  return {
    ...instance,
    backend,
    frame,
    quits: () => quits,
    /** The results column of the row holding `text`. */
    row: (text: string) =>
      frame().split("\n").map((r) => r.split("│")[0]).find((r) =>
        r.includes(text)
      ) ?? "",
    until: (shows: (frame: string) => boolean, what: string) =>
      waitFor(() => shows(frame()), what),
  };
}

const ROWS = [ANNOUNCEMENT, ISSUE, POINTS];

Deno.test({
  name: "inbox: rows show date, kind and title, with unread marked",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(makeView(ROWS));
    await inbox.until((f) => f.includes("3 / 3"), "the rows to draw");

    assertStringIncludes(
      inbox.row("2026-10-26"),
      "●  2026-10-26  announcement  swamp",
    );
    assertStringIncludes(
      inbox.row("2026-10-25"),
      "●  2026-10-25  issue_update  Your",
    );
    assert(!inbox.row("2026-10-24").includes("●"));
  },
});

Deno.test({
  name:
    "inbox: Enter opens the message and marks it; Esc goes back to the same row",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(makeView(ROWS));
    await inbox.until((f) => f.includes("3 / 3"), "the rows to draw");

    inbox.stdin.write("\x1b[B");
    await inbox.until(
      (f) => f.includes("The fix is in swamp 1.42."),
      "the preview to follow the highlight",
    );
    inbox.stdin.write("\r");
    await inbox.until((f) => f.includes("Esc back"), "the message view");

    assertEquals(inbox.backend.marks, [{ ids: [ISSUE.id], reason: "read" }]);
    assertStringIncludes(inbox.frame(), "Your issue #3990 shipped");

    inbox.stdin.write("\x1b");
    await inbox.until((f) => f.includes("3 / 3"), "the list again");

    assertEquals(inbox.quits(), 0);
    assert(!inbox.row("2026-10-25").includes("●"));
    // Enter opens the row the list came back on.
    inbox.stdin.write("\r");
    await inbox.until((f) => f.includes("Esc back"), "the message view");
    assertStringIncludes(inbox.frame(), "The fix is in swamp 1.42.");
    // Read now, so opening it again sends nothing.
    assertEquals(inbox.backend.marks.length, 1);
  },
});

Deno.test({
  name: "inbox: opening a message already read marks nothing",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(makeView([POINTS]));
    await inbox.until((f) => f.includes("1 / 1"), "the rows to draw");

    inbox.stdin.write("\r");
    await inbox.until((f) => f.includes("Esc back"), "the message view");

    assertEquals(inbox.backend.marks, []);
  },
});

Deno.test({
  name: "inbox: Ctrl-r marks the row and stays; on a read row it sends nothing",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(makeView(ROWS));
    await inbox.until((f) => f.includes("3 / 3"), "the rows to draw");

    inbox.stdin.write("\x12");
    await inbox.until(
      () => !inbox.row("2026-10-26").includes("●"),
      "the dot to clear",
    );
    assertEquals(inbox.backend.marks, [{
      ids: [ANNOUNCEMENT.id],
      reason: "marked",
    }]);

    inbox.stdin.write("\x1b[B");
    inbox.stdin.write("\x1b[B");
    await inbox.until(
      (f) => f.includes("Thanks for filing"),
      "the highlight on the read row",
    );
    inbox.stdin.write("\x12");
    inbox.stdin.write("\x12");
    await inbox.until((f) => f.includes("3 / 3"), "the list to stay");

    assertEquals(inbox.backend.marks.length, 1);
    assertEquals(inbox.quits(), 0);
  },
});

Deno.test({
  name: "inbox: Ctrl-r pressed as the moved highlight is drawn marks that row",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(makeView(ROWS));
    await inbox.until((f) => f.includes("3 / 3"), "the rows to draw");

    const frameCount = inbox.frames.length;
    pressOnFrame(inbox, () => inbox.frames.length > frameCount, "\x12");
    inbox.stdin.write("\x1b[B");
    await waitFor(() => inbox.backend.marks.length === 1, "the mark");

    assertEquals(inbox.backend.marks, [{ ids: [ISSUE.id], reason: "marked" }]);
  },
});

Deno.test({
  name:
    "inbox: Ctrl-a marks every unread message loaded, rows the filter hides included",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(makeView(ROWS));
    await inbox.until((f) => f.includes("3 / 3"), "the rows to draw");

    inbox.stdin.write("points");
    await inbox.until((f) => f.includes("1 / 3"), "the filter to apply");
    inbox.stdin.write("\x01");
    await waitFor(() => inbox.backend.marks.length === 1, "the mark");

    assertEquals(inbox.backend.marks, [{
      ids: [ANNOUNCEMENT.id, ISSUE.id],
      reason: "marked",
    }]);
    assertEquals(inbox.quits(), 0);
  },
});

Deno.test({
  name: "inbox: Esc clears the filter first, then quits",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(makeView(ROWS));
    await inbox.until((f) => f.includes("3 / 3"), "the rows to draw");

    inbox.stdin.write("points");
    await inbox.until((f) => f.includes("1 / 3"), "the filter to apply");
    assertStringIncludes(inbox.frame(), "Esc clear filter");

    inbox.stdin.write("\x1b");
    await inbox.until((f) => f.includes("3 / 3"), "the filter to clear");
    assertEquals(inbox.quits(), 0);

    inbox.stdin.write("\x1b");
    await waitFor(() => inbox.quits() === 1, "the inbox to quit");
    assertEquals(inbox.backend.marks, []);
  },
});

Deno.test({
  name: "inbox: Ctrl-c quits, from the list and from a message",
  ...inkTestOptions,
  fn: async () => {
    const list = openInbox(makeView(ROWS));
    await list.until((f) => f.includes("3 / 3"), "the rows to draw");
    list.stdin.write("\x03");
    await waitFor(() => list.quits() === 1, "the inbox to quit");

    const message = openInbox(makeView(ROWS));
    await message.until((f) => f.includes("3 / 3"), "the rows to draw");
    message.stdin.write("\r");
    await message.until((f) => f.includes("Esc back"), "the message view");
    message.stdin.write("\x03");
    await waitFor(() => message.quits() === 1, "the inbox to quit");
  },
});

Deno.test({
  name: "inbox: a failed mark puts the dot back and says why",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(
      makeView(ROWS),
      fakeBackend({
        outcome: () =>
          Promise.resolve({ kind: "failed", reason: "Swamp Club is down." }),
      }),
    );
    await inbox.until((f) => f.includes("3 / 3"), "the rows to draw");

    inbox.stdin.write("\x12");
    await inbox.until(
      (f) => f.includes("Could not mark 1 message read: Swamp Club is down."),
      "the status line",
    );
    assertStringIncludes(inbox.row("2026-10-26"), "●");

    // The next key clears it.
    inbox.stdin.write("\x1b[B");
    await inbox.until(
      (f) => !f.includes("Could not mark") && f.includes("Enter open"),
      "the help bar again",
    );
  },
});

Deno.test({
  name: "inbox: an id Swamp Club does not confirm gets its dot back",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(
      makeView(ROWS),
      fakeBackend({
        // Confirms the announcement, not the issue.
        outcome: (ids) =>
          Promise.resolve({
            kind: "confirmed",
            ids: ids.filter((id) => id === ANNOUNCEMENT.id),
          }),
      }),
    );
    await inbox.until((f) => f.includes("3 / 3"), "the rows to draw");

    inbox.stdin.write("\x01");
    await inbox.until(
      (f) =>
        f.includes(
          "Could not mark 1 message read: Swamp Club did not confirm it",
        ),
      "the status line",
    );
    assert(!inbox.row("2026-10-26").includes("●"));
    assertStringIncludes(inbox.row("2026-10-25"), "●");
  },
});

Deno.test({
  name: "inbox: reaching the last row loads the older page and appends it",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(
      makeView([ANNOUNCEMENT, ISSUE], ISSUE.id),
      fakeBackend({ older: makeView([OLDER], null) }),
    );
    await inbox.until((f) => f.includes("2 / 2"), "the rows to draw");
    assertEquals(inbox.backend.loads, []);

    inbox.stdin.write("\x1b[B");
    await inbox.until((f) => f.includes("3 / 3"), "the older page");

    assertEquals(inbox.backend.loads, [ISSUE.id]);
    assertStringIncludes(inbox.row("2026-10-23"), "direct        Welcom");
    // That page was the last, so the new last row loads nothing more.
    inbox.stdin.write("\x1b[B");
    await inbox.until(
      (f) => f.includes("Glad to have you."),
      "the highlight on the new row",
    );
    assertEquals(inbox.backend.loads, [ISSUE.id]);
  },
});

Deno.test({
  name: "inbox: the help bar names each view's keys, never select or cancel",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(makeView(ROWS));
    await inbox.until((f) => f.includes("3 / 3"), "the rows to draw");
    const list = inbox.frame();
    assertStringIncludes(
      list,
      "Enter open  Ctrl-r mark read  Ctrl-a mark all read  Esc quit",
    );

    inbox.stdin.write("\r");
    await inbox.until((f) => f.includes("Esc back"), "the message view");
    const message = inbox.frame();
    assertStringIncludes(message, INBOX_MESSAGE_KEYS.join("  "));

    for (const frame of [list, message]) {
      assert(!/\bselect\b/i.test(frame), frame);
      assert(!/\bcancel\b/i.test(frame), frame);
    }
  },
});

Deno.test("inboxListKeys: Esc quits, or clears a filter", () => {
  assertEquals(inboxListKeys(false, false).at(-1), "Esc quit");
  assertEquals(inboxListKeys(false, true).at(-1), "Esc clear filter");
  assert(inboxListKeys(true, false).includes("Ctrl-u/d scroll"));
});

Deno.test({
  name:
    "inbox: the message view scrolls to its last wrapped line and no further",
  ...inkTestOptions,
  fn: async () => {
    const long: InboxMessageView = {
      ...ISSUE,
      body: Array.from({ length: 80 }, (_, i) => `Line ${i + 1}.`).join(
        "\n\n",
      ),
      action: { label: "Update", command: "swamp update" },
    };
    const inbox = openInbox(makeView([long]));
    await inbox.until((f) => f.includes("1 / 1"), "the rows to draw");

    inbox.stdin.write("\r");
    await inbox.until((f) => f.includes("Esc back"), "the message view");
    for (let i = 0; i < 20; i++) inbox.stdin.write("\x1b[6~");
    await inbox.until(
      (f) => f.includes("Next:  swamp update"),
      "the last line in view",
    );
    const bottom = inbox.frame();
    inbox.stdin.write("\x1b[B");
    inbox.stdin.write("\x1b[6~");
    await inbox.until((f) => f.includes("Next:  swamp update"), "no change");
    assertEquals(inbox.frame(), bottom);
  },
});

Deno.test("newestUnreadIndex: the first unread row, or 0 when none is unread", () => {
  assertEquals(newestUnreadIndex([POINTS, ISSUE, ANNOUNCEMENT]), 1);
  assertEquals(newestUnreadIndex([POINTS]), 0);
  assertEquals(newestUnreadIndex([]), 0);
});

Deno.test({
  name: "inbox: opens on the newest unread row",
  ...inkTestOptions,
  fn: async () => {
    const inbox = openInbox(makeView([POINTS, ISSUE, ANNOUNCEMENT]));
    await inbox.until((f) => f.includes("3 / 3"), "the rows to draw");

    inbox.stdin.write("\r");
    await inbox.until((f) => f.includes("Esc back"), "the message view");
    assertStringIncludes(inbox.frame(), "Your issue #3990 shipped");
  },
});

Deno.test("inboxQuitLine: the confirmed counts, or nothing", () => {
  assertEquals(inboxQuitLine(2, 3), "Read 2 messages and marked 3 read.");
  assertEquals(inboxQuitLine(1, 1), "Read 1 message and marked 1 read.");
  assertEquals(inboxQuitLine(1, 0), "Read 1 message.");
  assertEquals(inboxQuitLine(0, 2), "Marked 2 messages read.");
  assertEquals(inboxQuitLine(0, 0), undefined);
});

Deno.test("inbox renderer: an empty inbox prints the empty line and opens nothing", async () => {
  const out: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => out.push(msg);
  let finished = 0;
  const session: InboxMarkSession = {
    mark: () => Promise.resolve({ kind: "confirmed", ids: [] }),
    finish: () => {
      finished++;
      return Promise.resolve();
    },
  };
  try {
    await createInboxTuiRenderer({
      markSession: session,
      loadOlder: () => Promise.resolve(makeView([])),
    }).handlers().completed({ kind: "completed", view: makeView([]) });
  } finally {
    console.log = originalLog;
  }

  assertEquals(out, ["Your inbox is empty."]);
  assertEquals(finished, 0);
});

Deno.test("inboxMessageLines: the heading, body, link and Next line", () => {
  const lines = inboxMessageLines(ANNOUNCEMENT, 80).map(stripAnsiCode);

  assertEquals(lines[0], "announcement · 2026-10-26");
  assertEquals(lines[1], "swamp 1.42 is out");
  const text = lines.join("\n");
  assertStringIncludes(text, "Link:  https://swamp-club.com/blog/swamp-1-42");
  assertStringIncludes(text, "Next:  swamp update");
  assert(!text.includes("Update now"));
});

Deno.test("inboxMessageLines: no link or action, no trailing lines", () => {
  const lines = inboxMessageLines(ISSUE, 80).map(stripAnsiCode);

  assertEquals(lines.at(-1)?.trim(), "The fix is in swamp 1.42.");
});

Deno.test("inboxMessageLines: a body link shows where it really leads", () => {
  const disguised: InboxMessageView = {
    ...ISSUE,
    body: "Sign in at [swamp-club.com](https://elsewhere.example/login).",
  };

  const text = inboxMessageLines(disguised, 80).join("\n");

  assertStringIncludes(
    stripAnsiCode(text),
    "swamp-club.com (https://elsewhere.example/login)",
  );
  assert(!text.includes("\x1b]8;"));
});

Deno.test("inboxMessageLines: a long body link wraps whole instead of being cut to its start", () => {
  const host = `https://swamp-club.com.${"a".repeat(80)}.evil.example/x`;
  const m: InboxMessageView = { ...ISSUE, body: `Go to <${host}>.` };
  const lines = inboxMessageLines(m, 40).map(stripAnsiCode);
  for (const line of lines) assert(line.length <= 40, line);
  assertStringIncludes(lines.join(""), "evil.example");
});

Deno.test("inboxMessageLines: prose that already fits is unchanged by the wrap", () => {
  const m: InboxMessageView = { ...ISSUE, body: "Short line one.\n\nTwo." };
  assertEquals(
    inboxMessageLines(m, 60).map(stripAnsiCode),
    inboxMessageLines(m).map(stripAnsiCode),
  );
});

Deno.test("connectInboxTui: closing waits for marks in flight and counts what was confirmed", async () => {
  const order: string[] = [];
  let release: (() => void) | undefined;
  const session: InboxMarkSession = {
    mark: async (ids) => {
      if (ids[0] === ISSUE.id) {
        await new Promise<void>((resolve) => release = resolve);
      }
      order.push(`marked ${ids.length}`);
      // Swamp Club confirms all but an id it does not know.
      return {
        kind: "confirmed",
        ids: ids.filter((id) => id !== POINTS.id),
      };
    },
    finish: async () => {
      order.push("finish");
      await waitFor(() => release !== undefined, "the slow mark to park");
      release?.();
    },
  };
  const connection = connectInboxTui({
    markSession: session,
    loadOlder: () => Promise.resolve(makeView([])),
  });

  const opened = connection.backend.markRead([ISSUE.id], "read");
  const marked = connection.backend.markRead(
    [ANNOUNCEMENT.id, POINTS.id],
    "marked",
  );
  const line = await connection.close();

  assertEquals(line, { line: "Read 1 message and marked 1 read.", dropped: 0 });
  assertEquals((await opened).kind, "confirmed");
  assertEquals((await marked).kind, "confirmed");
  assertEquals(order.at(-1), "marked 1");
});

Deno.test("connectInboxTui: closing with nothing marked prints nothing", async () => {
  let finished = 0;
  const connection = connectInboxTui({
    markSession: {
      mark: () => Promise.resolve({ kind: "confirmed", ids: [] }),
      finish: () => {
        finished++;
        return Promise.resolve();
      },
    },
    loadOlder: () => Promise.resolve(makeView([])),
  });

  assertEquals(await connection.close(), { dropped: 0 });
  assertEquals(finished, 1);
});

Deno.test("connectInboxTui: closing aborts a page load still running", async () => {
  let aborted = false;
  const connection = connectInboxTui({
    markSession: {
      mark: () => Promise.resolve({ kind: "confirmed", ids: [] }),
      finish: () => Promise.resolve(),
    },
    loadOlder: (_cursor, signal) =>
      new Promise<InboxBrowseView>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  });

  const load = connection.backend.loadOlder(ISSUE.id);
  await connection.close();

  assertEquals(aborted, true);
  await load.then(
    () => assert(false, "the load should have been aborted"),
    (error: unknown) => assert(error instanceof DOMException),
  );
});

Deno.test("connectInboxTui: closing counts entries older pages left out", async () => {
  const connection = connectInboxTui({
    markSession: {
      mark: () => Promise.resolve({ kind: "confirmed", ids: [] }),
      finish: () => Promise.resolve(),
    },
    loadOlder: () =>
      Promise.resolve({ messages: [OLDER], nextCursor: null, dropped: 2 }),
  });

  await connection.backend.loadOlder(ISSUE.id);

  assertEquals(await connection.close(), { dropped: 2 });
});

Deno.test({
  name:
    "inbox: a failed older-page load is retried by the next key past the last row",
  ...inkTestOptions,
  fn: async () => {
    let calls = 0;
    const backend = fakeBackend();
    backend.loadOlder = (cursor) => {
      backend.loads.push(cursor);
      calls++;
      return calls === 1
        ? Promise.reject(new Error("Swamp Club is down."))
        : Promise.resolve(makeView([OLDER], null));
    };
    const inbox = openInbox(makeView([ANNOUNCEMENT, ISSUE], ISSUE.id), backend);
    await inbox.until((f) => f.includes("2 / 2"), "the rows to draw");

    inbox.stdin.write("\x1b[B");
    await inbox.until(
      (f) => f.includes("Could not load older messages: Swamp Club is down."),
      "the failed load",
    );
    inbox.stdin.write("\x1b[B");
    await inbox.until((f) => f.includes("3 / 3"), "the retried page");

    assertEquals(backend.loads, [ISSUE.id, ISSUE.id]);
  },
});

Deno.test({
  name: "inbox: a page naming the same cursor again stops paging",
  ...inkTestOptions,
  fn: async () => {
    const backend = fakeBackend({ older: makeView([OLDER], ISSUE.id) });
    const inbox = openInbox(makeView([ANNOUNCEMENT, ISSUE], ISSUE.id), backend);
    await inbox.until((f) => f.includes("2 / 2"), "the rows to draw");

    inbox.stdin.write("\x1b[B");
    await inbox.until((f) => f.includes("3 / 3"), "the older page");
    inbox.stdin.write("\x1b[B");
    await inbox.until(
      (f) => f.includes("Glad to have you."),
      "the highlight on the new last row",
    );

    assertEquals(backend.loads, [ISSUE.id]);
  },
});
