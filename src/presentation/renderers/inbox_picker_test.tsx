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

import React from "react";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { render } from "ink-testing-library";
import { waitFor } from "@swamp-club/swamp-testing";
import type {
  InboxBrowseView,
  InboxMessageView,
} from "../../libswamp/inbox/list.ts";
import {
  type PickerResult,
  SearchPicker,
} from "./components/search_picker.tsx";
import { pressOnFrame } from "./components/press_on_frame_test_helpers.ts";
import { computePickerLayout } from "./components/picker_layout.ts";
import {
  createInboxPickerRenderer,
  inboxMessageLines,
  inboxPickerConfig,
  type InboxPickerSelection,
  newestUnreadIndex,
  toInboxPickerSelection,
} from "./inbox_picker.tsx";

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

function makeView(messages: InboxMessageView[]): InboxBrowseView {
  return { messages, nextCursor: null, dropped: 0 };
}

/**
 * Renders the shared picker as the inbox configures it, and resolves with
 * the selection the inbox maps the user's keys to.
 */
function openPicker(view: InboxBrowseView, highlightNewestUnread = false) {
  const config = inboxPickerConfig(view, highlightNewestUnread);
  let selection: InboxPickerSelection | undefined;
  const settle = (result: PickerResult<InboxMessageView> | undefined) => {
    selection = toInboxPickerSelection(result, view.messages);
  };
  const instance = render(
    <SearchPicker<InboxMessageView>
      items={config.items}
      initialQuery=""
      selector={config.selector}
      renderResultLine={config.renderResultLine}
      renderPreview={config.renderPreview}
      renderScrollback={config.renderScrollback}
      itemLabel="messages"
      actions={config.actions}
      initialIndex={config.initialIndex}
      onSelect={(item, _scrollback, action) => settle({ item, action })}
      onCancel={() => settle(undefined)}
    />,
  );
  return {
    ...instance,
    drawn: () =>
      waitFor(
        () =>
          (instance.lastFrame() ?? "").includes(
            `${view.messages.length} / ${view.messages.length}`,
          ),
        "the picker to draw its rows",
      ),
    selection: async () => {
      await waitFor(() => selection !== undefined, "the picker to close");
      return selection!;
    },
  };
}

Deno.test({
  name: "inbox picker: rows show date, kind and title, with unread marked",
  ...inkTestOptions,
  fn: async () => {
    const picker = openPicker(makeView([ANNOUNCEMENT, ISSUE, POINTS]));
    await picker.drawn();

    // Each row's results column, left of the preview border.
    const rows = stripAnsiCode(picker.lastFrame() ?? "").split("\n")
      .map((r) => r.split("│")[0]);
    const row = (date: string) => rows.find((r) => r.includes(date)) ?? "";
    assertStringIncludes(
      row("2026-10-26"),
      "●  2026-10-26  announcement  swamp",
    );
    assertStringIncludes(
      row("2026-10-25"),
      "●  2026-10-25  issue_update  Your",
    );
    assert(!row("2026-10-24").includes("●"));
    assertStringIncludes(row("2026-10-24"), "2026-10-24  points        You");
  },
});

Deno.test({
  name: "inbox picker: Enter opens the highlighted message and marks it",
  ...inkTestOptions,
  fn: async () => {
    const picker = openPicker(makeView([ANNOUNCEMENT, ISSUE, POINTS]));
    await picker.drawn();

    picker.stdin.write("\r");

    assertEquals(await picker.selection(), {
      kind: "open",
      ids: [ANNOUNCEMENT.id],
      message: ANNOUNCEMENT,
    });
  },
});

Deno.test({
  name: "inbox picker: moving through the list marks nothing read",
  ...inkTestOptions,
  fn: async () => {
    const picker = openPicker(makeView([ANNOUNCEMENT, ISSUE, POINTS]));
    await picker.drawn();

    picker.stdin.write("\x1b[B");
    picker.stdin.write("\x1b[B");
    await waitFor(
      () => (picker.lastFrame() ?? "").includes("Thanks for filing"),
      "the preview to follow the highlight",
    );
    // Opening a message already read marks nothing.
    picker.stdin.write("\r");

    assertEquals(await picker.selection(), {
      kind: "open",
      ids: [],
      message: POINTS,
    });
  },
});

Deno.test({
  name: "inbox picker: Ctrl-r marks the highlighted message read",
  ...inkTestOptions,
  fn: async () => {
    const picker = openPicker(makeView([ANNOUNCEMENT, ISSUE, POINTS]));
    await picker.drawn();

    picker.stdin.write("\x1b[B");
    await waitFor(
      () => (picker.lastFrame() ?? "").includes("The fix is in swamp 1.42."),
      "the preview to follow the highlight",
    );
    picker.stdin.write("\x12");

    assertEquals(await picker.selection(), {
      kind: "mark",
      ids: [ISSUE.id],
      message: ISSUE,
    });
  },
});

Deno.test({
  name:
    "inbox picker: Ctrl-r pressed as the moved highlight is drawn marks that message",
  ...inkTestOptions,
  fn: async () => {
    const picker = openPicker(makeView([ANNOUNCEMENT, ISSUE, POINTS]));
    await picker.drawn();

    const frameCount = picker.frames.length;
    pressOnFrame(picker, () => picker.frames.length > frameCount, "\x12");
    picker.stdin.write("\x1b[B");

    assertEquals(await picker.selection(), {
      kind: "mark",
      ids: [ISSUE.id],
      message: ISSUE,
    });
  },
});

Deno.test({
  name:
    "inbox picker: Ctrl-a marks every unread message on the page, filter or not",
  ...inkTestOptions,
  fn: async () => {
    const picker = openPicker(makeView([ANNOUNCEMENT, ISSUE, POINTS]));
    await picker.drawn();

    picker.stdin.write("points");
    await waitFor(
      () => (picker.lastFrame() ?? "").includes("1 / 3"),
      "the filter to apply",
    );
    picker.stdin.write("\x01");

    assertEquals(await picker.selection(), {
      kind: "mark_all",
      ids: [ANNOUNCEMENT.id, ISSUE.id],
    });
  },
});

Deno.test({
  name: "inbox picker: Esc closes and marks nothing",
  ...inkTestOptions,
  fn: async () => {
    const picker = openPicker(makeView([ANNOUNCEMENT, ISSUE, POINTS]));
    await picker.drawn();

    picker.stdin.write("\x1b");

    assertEquals(await picker.selection(), { kind: "cancelled", ids: [] });
  },
});

Deno.test({
  name: "inbox picker: inbox read starts on the newest unread message",
  ...inkTestOptions,
  fn: async () => {
    const picker = openPicker(makeView([POINTS, ISSUE, ANNOUNCEMENT]), true);
    await picker.drawn();

    picker.stdin.write("\r");

    assertEquals((await picker.selection()).message, ISSUE);
  },
});

Deno.test("newestUnreadIndex: the first unread row, or 0 when none is unread", () => {
  assertEquals(newestUnreadIndex([POINTS, ISSUE, ANNOUNCEMENT]), 1);
  assertEquals(newestUnreadIndex([POINTS]), 0);
  assertEquals(newestUnreadIndex([]), 0);
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

Deno.test("inbox picker: an empty inbox prints the empty line and opens no picker", async () => {
  const out: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => out.push(msg);
  try {
    const renderer = createInboxPickerRenderer();
    await renderer.handlers().completed({
      kind: "completed",
      view: makeView([]),
    });
    assertEquals(renderer.selection(), { kind: "cancelled", ids: [] });
  } finally {
    console.log = originalLog;
  }

  assertEquals(out, ["Your inbox is empty."]);
});

/** A long body, as a six-paragraph announcement is. */
const LONG: InboxMessageView = {
  ...ANNOUNCEMENT,
  body: Array.from(
    { length: 6 },
    (_, i) => `Paragraph ${i + 1}. ${"Swamp news and notes. ".repeat(20)}`,
  ).join("\n\n"),
  link: `https://swamp-club.com/blog/${"long-path-".repeat(20)}end`,
  action: {
    label: "Search",
    command: `swamp extension search ${"aws ".repeat(30)}x`,
  },
};

/** The preview's rows, as the shared picker renders them at `width`. */
function previewRows(m: InboxMessageView, width: number): string[] {
  const config = inboxPickerConfig(makeView([m]), false);
  const element = config.renderPreview(m, undefined, width, 0);
  return React.Children.toArray(
    (element.props as { children?: React.ReactNode }).children,
  ).map((child) =>
    String((child as React.ReactElement<{ children: string }>).props.children)
  );
}

Deno.test("inbox picker: at 120x40 the preview line count reaches the Next line", () => {
  const { previewWidth } = computePickerLayout(120, 40);
  const config = inboxPickerConfig(makeView([LONG]), false);
  const rows = previewRows(LONG, previewWidth);

  const counted = config.previewLineCount(LONG, undefined, previewWidth);

  assertEquals(counted, rows.length);
  assertStringIncludes(stripAnsiCode(rows.at(-1) ?? ""), "x");
  assert(rows.some((r) => stripAnsiCode(r).startsWith("Next:")));
  // The scrollback's count, what the scroll limit used before, falls short.
  assert(config.renderScrollback(LONG, undefined).split("\n").length < counted);
});

Deno.test("inbox picker: no preview row is wider than the pane, so nothing is cut off", () => {
  const { previewWidth } = computePickerLayout(120, 40);
  const inner = previewWidth - 1;
  const rows = previewRows(LONG, previewWidth).map(stripAnsiCode);
  for (const row of rows) assert(row.length <= inner, row);
  const joined = rows.join("");
  assertStringIncludes(joined, LONG.link!);
  assertStringIncludes(
    joined.replaceAll(" ", ""),
    LONG.action!.command.replaceAll(" ", ""),
  );
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

Deno.test("inbox picker: after closing, names the older page when there is one", async () => {
  for (
    const [nextCursor, expected] of [
      [
        "01JBX5Q8ZK00000000000000ZP",
        ["To see older:  swamp inbox --all --before 01JBX5Q8ZK00000000000000ZP"],
      ],
      [null, []],
    ] as const
  ) {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => out.push(stripAnsiCode(msg));
    try {
      const renderer = createInboxPickerRenderer();
      // An empty page opens no picker, so the test needs no terminal.
      await renderer.handlers().completed({
        kind: "completed",
        view: { messages: [], nextCursor, dropped: 0 },
      });
      out.length = 0;
      renderer.printOlderPageLine();
    } finally {
      console.log = originalLog;
    }
    assertEquals(out, [...expected]);
  }
});
