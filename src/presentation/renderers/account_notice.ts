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
import type { AccountNoticeView } from "../../libswamp/account_notices/notice.ts";

// pinned in design/surfaces/account-notices.md
export const ACCOUNT_NOTICE_PLAN_LABEL = "Choose a plan:";

function subject(notice: AccountNoticeView): string {
  return notice.personal
    ? "Your Swamp Club trial"
    // the slug, not the free-text name, which a co-admin could fill with a link
    : `The Swamp Club trial for ${notice.slug}`;
}

export function accountNoticeFirstLine(notice: AccountNoticeView): string {
  if (notice.kind === "trial-ended") return `⚠ ${subject(notice)} has ended.`;
  const days = notice.daysRemaining ?? 1;
  const when = days <= 1 ? "within a day" : `in ${days} days`;
  const date = notice.endsAt ? ` (${notice.endsAt.slice(0, 10)})` : "";
  return `ℹ ${subject(notice)} ends ${when}${date}.`;
}

export function accountNoticePlanLine(notice: AccountNoticeView): string {
  return `  ${ACCOUNT_NOTICE_PLAN_LABEL}  ${notice.billingUrl}`;
}

// only the label is coloured, as in the inbox notice
export function renderAccountNotice(
  notice: AccountNoticeView,
  write: (line: string) => void = (line) => console.error(line),
): void {
  write("");
  write(accountNoticeFirstLine(notice));
  write(`  ${yellow(ACCOUNT_NOTICE_PLAN_LABEL)}  ${notice.billingUrl}`);
}
