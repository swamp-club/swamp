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

import type { AccountNotice } from "./account_notice.ts";
import type { InboxCacheKey, PollSchedule } from "../inbox/inbox_state.ts";

export interface AccountNoticeSnapshot {
  readonly notices: readonly AccountNotice[];
  // when the request was sent, so an older answer never replaces a newer one
  readonly fetchedAt: number;
}

export interface AccountNoticeState {
  readonly snapshot: AccountNoticeSnapshot | null;
  readonly schedule: PollSchedule;
  // epoch milliseconds each notice last showed, keyed by noticeKey
  readonly shown: Readonly<Record<string, number>>;
}

export const AccountNoticeState = {
  empty(): AccountNoticeState {
    return {
      snapshot: null,
      schedule: { lastPolledAt: null, nextPollAt: null, stop: null },
      shown: {},
    };
  },
};

export type AccountNoticePollOutcome =
  | {
    readonly kind: "ok";
    readonly notices: readonly AccountNotice[];
    readonly sentAt: number;
  }
  | { readonly kind: "unsupported" }
  // a collective key, which has no notices
  | { readonly kind: "unavailable" }
  | { readonly kind: "rejected" }
  | { readonly kind: "backoff"; readonly retryAfterSeconds?: number }
  | { readonly kind: "failed"; readonly reason: string };

export interface AccountNoticeCacheRepository {
  // an empty state when none is stored or the stored one is invalid
  load(key: InboxCacheKey): Promise<AccountNoticeState>;
  save(key: InboxCacheKey, state: AccountNoticeState): Promise<void>;
  delete(key: InboxCacheKey): Promise<void>;
}
