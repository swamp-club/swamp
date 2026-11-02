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
 * the notice text is pinned in design/surfaces/inbox.md and the swamp skill
 * quotes its second line, so the three change together
 */
export const INBOX_NOTICE_SINGLE_LINE =
  "ℹ A new message from Swamp Club is waiting for you.";

export const INBOX_NOTICE_READ_LABEL = "To read it:";

export const INBOX_NOTICE_READ_COMMAND = "swamp inbox read";

export const INBOX_NOTICE_READ_LINE =
  `  ${INBOX_NOTICE_READ_LABEL}  ${INBOX_NOTICE_READ_COMMAND}`;

/** the plural says unread, not new: the count includes messages announced before */
export function inboxNoticeFirstLine(unread: number): string {
  return unread > 1
    ? `ℹ ${unread} unread messages from Swamp Club are waiting for you.`
    : INBOX_NOTICE_SINGLE_LINE;
}

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
