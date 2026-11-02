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

import type {
  AccountNoticePoll,
  AccountNoticeView,
} from "../libswamp/account_notices/notice.ts";
import type { OutputMode } from "../presentation/output/output.ts";
import { renderAccountNotice } from "../presentation/renderers/account_notice.ts";
import type { AuthGateTiming } from "./auth_gate_exemptions.ts";
import { postCommandNoticesAllowed } from "./context.ts";
import { pollsInbox, showsInboxNotice } from "./inbox_notice_gate.ts";

// unlike the inbox notice, no environment variable turns this one off

export interface AccountNoticeRun {
  readonly commandPath: readonly string[];
  readonly gateTiming: AuthGateTiming;
  readonly gatePassed: boolean;
  readonly nested: boolean;
  // a hook returns before teardown, so a poll it started would never settle
  readonly hook: boolean;
}

export interface AccountNoticeEligibility {
  readonly eligible: boolean;
  readonly slowCommand: boolean;
}

// a nested run never prints into output its parent captures
export function accountNoticeEligibility(
  run: AccountNoticeRun,
): AccountNoticeEligibility {
  const eligible = run.gatePassed && !run.nested && !run.hook &&
    showsInboxNotice(run.commandPath, run.gateTiming);
  return {
    eligible,
    slowCommand: eligible && pollsInbox(run.commandPath),
  };
}

export interface FinishAccountNoticeOptions {
  readonly poll: AccountNoticePoll | null;
  readonly eligible: boolean;
  readonly outputMode: OutputMode;
  readonly quiet: boolean;
  readonly succeeded: boolean;
  readonly show: () => Promise<AccountNoticeView | null>;
  readonly write?: (line: string) => void;
}

// always settles the poll, even when nothing prints
export async function finishAccountNotice(
  options: FinishAccountNoticeOptions,
): Promise<void> {
  try {
    await options.poll?.settle();
    if (
      !options.succeeded || !options.eligible ||
      !postCommandNoticesAllowed(options.outputMode, options.quiet)
    ) {
      return;
    }
    const notice = await options.show();
    if (notice !== null) renderAccountNotice(notice, options.write);
  } catch {
    // best effort: the notice never changes how a run ends
  }
}
