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

/**
 * When to poll the inbox and when to show the post-command notice. Pure
 * functions; `now` is always epoch milliseconds passed in by the caller.
 */

import type { InboxState, PollOutcome } from "./inbox_state.ts";

/** The server can lengthen the gap between polls but never shorten it below this. */
export const MIN_POLL_INTERVAL_SECONDS = 900;

/** A misbehaving server cannot push the next poll further out than this. */
export const MAX_POLL_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

/** A notice retires this long after it first showed, read or not. */
export const NOTICE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** What the post-command notice reports. */
export interface InboxNotice {
  readonly unread: number;
}

function pollIntervalMs(pollAfterSeconds: number | undefined): number {
  const seconds = pollAfterSeconds !== undefined &&
      Number.isFinite(pollAfterSeconds)
    ? pollAfterSeconds
    : MIN_POLL_INTERVAL_SECONDS;
  return Math.min(
    Math.max(seconds, MIN_POLL_INTERVAL_SECONDS),
    MAX_POLL_INTERVAL_SECONDS,
  ) * 1000;
}

function backoffMs(retryAfterSeconds: number | undefined): number {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)) {
    return MIN_POLL_INTERVAL_SECONDS * 1000;
  }
  return Math.min(Math.max(retryAfterSeconds, 0), MAX_POLL_INTERVAL_SECONDS) *
    1000;
}

/** Whether the inbox is due a poll. */
export function shouldPoll(state: InboxState, now: number): boolean {
  const { lastPolledAt, nextPollAt, stop } = state.schedule;
  if (stop !== null) return false;
  // A last poll in the future means the clock went back: poll rather than
  // wait out a gap measured from the wrong time.
  if (lastPolledAt === null || lastPolledAt > now) return true;
  const sinceLast = now - lastPolledAt;
  if (sinceLast >= MAX_POLL_INTERVAL_SECONDS * 1000) return true;
  if (nextPollAt !== null && now < nextPollAt) return false;
  return sinceLast >= pollIntervalMs(state.snapshot?.pollAfterSeconds);
}

/** The state after a poll. Every outcome counts as a poll, `failed` included. */
export function applyPollOutcome(
  state: InboxState,
  outcome: PollOutcome,
  now: number,
): InboxState {
  const schedule = { ...state.schedule, lastPolledAt: now, nextPollAt: null };
  switch (outcome.kind) {
    case "ok":
      return { ...state, snapshot: outcome.snapshot, schedule };
    case "not_modified":
    case "failed":
      return { ...state, schedule };
    case "backoff":
      return {
        ...state,
        schedule: {
          ...schedule,
          nextPollAt: now + backoffMs(outcome.retryAfterSeconds),
        },
      };
    case "unsupported":
    case "unavailable":
    case "rejected":
      return {
        ...state,
        schedule: {
          ...schedule,
          stop: state.schedule.stop ?? { reason: outcome.kind, at: now },
        },
      };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/**
 * The notice to print after a command, or null. Shown for unread messages
 * newer than the last one announced, and again for the same message until
 * 24 hours after it first showed.
 */
export function noticeToShow(
  state: InboxState,
  now: number,
): InboxNotice | null {
  const { snapshot, announcement } = state;
  if (snapshot === null || snapshot.unread <= 0) return null;
  const { newestId } = snapshot;
  if (newestId === null) return null;
  if (announcement === null || newestId > announcement.id) {
    return { unread: snapshot.unread };
  }
  if (
    newestId === announcement.id && now - announcement.at < NOTICE_LIFETIME_MS
  ) {
    return { unread: snapshot.unread };
  }
  return null;
}

/**
 * The state after the notice showed. The first showing of a message starts
 * its 24 hours; later showings of the same message leave them running.
 */
export function recordNoticeShown(state: InboxState, now: number): InboxState {
  if (noticeToShow(state, now) === null) return state;
  const newestId = state.snapshot?.newestId;
  if (newestId === undefined || newestId === null) return state;
  if (state.announcement?.id === newestId) return state;
  return { ...state, announcement: { id: newestId, at: now } };
}
