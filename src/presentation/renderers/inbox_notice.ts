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

import { yellow } from "@std/fmt/colors";
import type { InboxNotice } from "../../domain/inbox/inbox_policy.ts";

/**
 * The notice's text is pinned in design/surfaces/inbox.md, and the `swamp`
 * skill quotes its second line, so the three change together
 * (integration/inbox_notice_text_test.ts).
 */
export const INBOX_NOTICE_SINGLE_LINE =
  "ℹ A new message from Swamp Club is waiting for you.";

export const INBOX_NOTICE_READ_LABEL = "To read it:";

export const INBOX_NOTICE_READ_COMMAND = "swamp inbox read";

/** The second line, uncoloured. */
export const INBOX_NOTICE_READ_LINE =
  `  ${INBOX_NOTICE_READ_LABEL}  ${INBOX_NOTICE_READ_COMMAND}`;

/**
 * The first line: singular for one unread message, plural for more. The
 * policy only shows a notice with at least one unread message.
 */
export function inboxNoticeFirstLine(unread: number): string {
  return unread > 1
    ? `ℹ ${unread} new messages from Swamp Club are waiting for you.`
    : INBOX_NOTICE_SINGLE_LINE;
}

/**
 * Writes the post-command inbox notice to stderr, after a blank line as the
 * update banner is. Only the label is coloured, as `To approve:` is.
 */
export function renderInboxNotice(
  notice: InboxNotice,
  write: (line: string) => void = (line) => console.error(line),
): void {
  write("");
  write(inboxNoticeFirstLine(notice.unread));
  write(
    `  ${yellow(INBOX_NOTICE_READ_LABEL)}  ${INBOX_NOTICE_READ_COMMAND}`,
  );
}
