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

import { type AccountNotice, noticeKey } from "./account_notice.ts";
import type {
  AccountNoticePollOutcome,
  AccountNoticeSnapshot,
  AccountNoticeState,
} from "./account_notice_state.ts";
import type { PollStop } from "../inbox/inbox_state.ts";
import {
  MAX_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  UNSUPPORTED_RETRY_SECONDS,
} from "../inbox/inbox_policy.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export const NOTICE_REPEAT_MS = DAY_MS;

export interface NoticeToShow {
  readonly notice: AccountNotice;
  readonly daysLeft?: number;
}

// a trial past its end reads as ended with no poll; one notice per collective
export function effectiveNotices(
  snapshot: AccountNoticeSnapshot | null,
  now: number,
): AccountNotice[] {
  if (snapshot === null) return [];
  const bySlug = new Map<string, AccountNotice>();
  for (const notice of snapshot.notices) {
    const current: AccountNotice =
      notice.kind === "trial-ending" && notice.endsAt <= now
        ? {
          kind: "trial-ended",
          collective: notice.collective,
          billingPath: notice.billingPath,
        }
        : notice;
    const seen = bySlug.get(current.collective.slug);
    if (
      seen === undefined || (seen.kind !== "trial-ended" &&
        current.kind === "trial-ended")
    ) {
      bySlug.set(current.collective.slug, current);
    }
  }
  const all = [...bySlug.values()];
  return [
    ...all.filter((n) => n.kind === "trial-ended"),
    ...all.filter((n) => n.kind !== "trial-ended"),
  ];
}

export function hasEndedTrial(state: AccountNoticeState, now: number): boolean {
  return effectiveNotices(state.snapshot, now).some((n) =>
    n.kind === "trial-ended"
  );
}

// swamp-club's own count: elapsed ms rounded up, no calendar or timezone, so
// an aged cache stays right; capped at the server's count against a slow clock
export function daysLeft(
  notice: Extract<AccountNotice, { kind: "trial-ending" }>,
  now: number,
): number {
  const counted = Math.ceil((notice.endsAt - now) / DAY_MS);
  return Math.max(1, Math.min(counted, notice.daysRemaining));
}

export function shouldPoll(
  state: AccountNoticeState,
  now: number,
  options: { readonly slowCommand: boolean },
): boolean {
  const { lastPolledAt, nextPollAt, stop } = state.schedule;
  if (stop !== null) return false;
  // a fast command polls only to clear an ended trial the user may have paid
  if (!options.slowCommand && !hasEndedTrial(state, now)) return false;
  // a last poll in the future means the clock went back
  if (lastPolledAt === null || lastPolledAt > now) return true;
  const sinceLast = now - lastPolledAt;
  if (sinceLast >= MAX_POLL_INTERVAL_SECONDS * 1000) return true;
  if (nextPollAt !== null && now < nextPollAt) return false;
  return sinceLast >= MIN_POLL_INTERVAL_SECONDS * 1000;
}

function backoffMs(retryAfterSeconds: number | undefined): number {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)) {
    return MIN_POLL_INTERVAL_SECONDS * 1000;
  }
  return Math.min(Math.max(retryAfterSeconds, 0), MAX_POLL_INTERVAL_SECONDS) *
    1000;
}

function stopAfterSuccess(
  stop: PollStop | null,
  sentAt: number,
): PollStop | null {
  if (stop === null) return null;
  return sentAt < stop.at ? stop : null;
}

// a future-dated stored snapshot loses, so a clock set back never freezes it
function newerSnapshot(
  stored: AccountNoticeSnapshot | null,
  fetched: AccountNoticeSnapshot,
  now: number,
): AccountNoticeSnapshot {
  if (stored === null || stored.fetchedAt > now) return fetched;
  return stored.fetchedAt > fetched.fetchedAt ? stored : fetched;
}

// recent showings stay too, so a notice that drops out and back waits its day
function prunedShown(
  shown: Readonly<Record<string, number>>,
  snapshot: AccountNoticeSnapshot,
  now: number,
): Record<string, number> {
  const standing = new Set(effectiveNotices(snapshot, now).map(noticeKey));
  return Object.fromEntries(
    Object.entries(shown).filter(([key, at]) =>
      standing.has(key) || (at <= now && now - at < NOTICE_REPEAT_MS)
    ),
  );
}

// every outcome counts as a poll, failed included
export function applyPollOutcome(
  state: AccountNoticeState,
  outcome: AccountNoticePollOutcome,
  now: number,
): AccountNoticeState {
  const schedule = { ...state.schedule, lastPolledAt: now, nextPollAt: null };
  switch (outcome.kind) {
    case "ok": {
      const stop = stopAfterSuccess(schedule.stop, outcome.sentAt);
      // an answer sent before the stop must not refill its notices
      if (stop !== null) return { ...state, schedule: { ...schedule, stop } };
      const snapshot = newerSnapshot(state.snapshot, {
        notices: outcome.notices,
        fetchedAt: outcome.sentAt,
      }, now);
      return {
        snapshot,
        schedule: { ...schedule, stop: null },
        shown: prunedShown(state.shown, snapshot, now),
      };
    }
    // a failure never cuts short a backoff the server asked for
    case "failed":
      return {
        ...state,
        schedule: {
          ...schedule,
          nextPollAt: state.schedule.nextPollAt !== null &&
              state.schedule.nextPollAt > now
            ? state.schedule.nextPollAt
            : null,
        },
      };
    case "backoff":
      return {
        ...state,
        schedule: {
          ...schedule,
          nextPollAt: now + backoffMs(outcome.retryAfterSeconds),
        },
      };
    // a server can gain the endpoint later, so a 404 waits rather than stops
    case "unsupported":
      return {
        ...state,
        schedule: {
          ...schedule,
          nextPollAt: now + UNSUPPORTED_RETRY_SECONDS * 1000,
        },
      };
    // only swamp-club's exact collective-key answer stops for good
    case "unavailable":
      return {
        snapshot: null,
        shown: {},
        schedule: {
          ...schedule,
          stop: state.schedule.stop ?? { reason: outcome.kind, at: now },
        },
      };
    // a 401 may be a proxy's: drop the notices it can't clear, ask again later
    case "rejected":
      return {
        ...state,
        snapshot: null,
        schedule: {
          ...schedule,
          nextPollAt: now + UNSUPPORTED_RETRY_SECONDS * 1000,
        },
      };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// a showing dated after now means the clock went back, and holds nothing back
export function noticeToShow(
  state: AccountNoticeState,
  now: number,
): NoticeToShow | null {
  for (const notice of effectiveNotices(state.snapshot, now)) {
    const last = state.shown[noticeKey(notice)];
    if (last !== undefined && last <= now && now - last < NOTICE_REPEAT_MS) {
      continue;
    }
    return notice.kind === "trial-ending"
      ? { notice, daysLeft: daysLeft(notice, now) }
      : { notice };
  }
  return null;
}

export function recordNoticeShown(
  state: AccountNoticeState,
  notice: AccountNotice,
  now: number,
): AccountNoticeState {
  return { ...state, shown: { ...state.shown, [noticeKey(notice)]: now } };
}
