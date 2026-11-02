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

// seat overage stays on the web
export const ACCOUNT_NOTICE_KINDS = ["trial-ended", "trial-ending"] as const;

export type AccountNoticeKind = typeof ACCOUNT_NOTICE_KINDS[number];

// bounds the cache file, so whatever parses also saves
export const MAX_ACCOUNT_NOTICES = 20;

export interface NoticeCollective {
  readonly slug: string;
  readonly name: string;
  readonly personal: boolean;
}

export type AccountNotice =
  | {
    readonly kind: "trial-ended";
    readonly collective: NoticeCollective;
    // null when the server sent no path the CLI could trust
    readonly billingPath: string | null;
  }
  | {
    readonly kind: "trial-ending";
    readonly collective: NoticeCollective;
    readonly billingPath: string | null;
    // epoch milliseconds
    readonly endsAt: number;
    // the server's count when it answered, a ceiling on what is shown
    readonly daysRemaining: number;
  };

export function noticeKey(notice: AccountNotice): string {
  return `${notice.kind}:${notice.collective.slug}`;
}
