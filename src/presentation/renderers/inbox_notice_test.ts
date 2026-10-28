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
import { stripAnsiCode } from "@std/fmt/colors";
import {
  INBOX_NOTICE_READ_LINE,
  INBOX_NOTICE_SINGLE_LINE,
  inboxNoticeFirstLine,
  renderInboxNotice,
} from "./inbox_notice.ts";

function rendered(unread: number): string[] {
  const lines: string[] = [];
  renderInboxNotice({ unread }, (line) => lines.push(line));
  return lines.map(stripAnsiCode);
}

Deno.test("renderInboxNotice: one unread message prints the singular notice", () => {
  assertEquals(rendered(1), [
    "",
    "ℹ A new message from Swamp Club is waiting for you.",
    "  To read it:  swamp inbox read",
  ]);
});

Deno.test("renderInboxNotice: more than one unread message prints the plural first line", () => {
  assertEquals(rendered(3), [
    "",
    "ℹ 3 unread messages from Swamp Club are waiting for you.",
    "  To read it:  swamp inbox read",
  ]);
});

Deno.test("renderInboxNotice: the second line never changes and matches the exported constant", () => {
  assertEquals(rendered(1)[2], INBOX_NOTICE_READ_LINE);
  assertEquals(rendered(42)[2], INBOX_NOTICE_READ_LINE);
});

Deno.test("inboxNoticeFirstLine: one or fewer reads as the singular line, two or more as the plural", () => {
  assertEquals(inboxNoticeFirstLine(0), INBOX_NOTICE_SINGLE_LINE);
  assertEquals(inboxNoticeFirstLine(1), INBOX_NOTICE_SINGLE_LINE);
  assertEquals(
    inboxNoticeFirstLine(2),
    "ℹ 2 unread messages from Swamp Club are waiting for you.",
  );
});
