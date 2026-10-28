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
import {
  applyPollOutcome,
  MAX_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  NOTICE_LIFETIME_MS,
  noticeToShow,
  recordNoticeShown,
  shouldPoll,
  UNSUPPORTED_RETRY_SECONDS,
} from "./inbox_policy.ts";
import { type InboxSnapshot, InboxState } from "./inbox_state.ts";

const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const MINUTE = 60 * SECOND;
const DAY = 24 * HOUR;
const ID_A = "01JBQ0000000000000000000AA";
const ID_B = "01JBQ0000000000000000000BB";

function snapshot(overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return {
    unread: 2,
    newestId: ID_A,
    newestAt: "2026-10-27T11:00:00.000Z",
    pollAfterSeconds: MIN_POLL_INTERVAL_SECONDS,
    etag: '"e1"',
    ...overrides,
  };
}

function polledAt(at: number, snap: InboxSnapshot = snapshot()): InboxState {
  return applyPollOutcome(
    InboxState.empty(),
    { kind: "ok", snapshot: snap },
    at,
  );
}

Deno.test("shouldPoll: true when the key has never been polled", () => {
  assertEquals(shouldPoll(InboxState.empty(), T0), true);
});

Deno.test("shouldPoll: waits out the 900-second floor", () => {
  const state = polledAt(T0);
  assertEquals(shouldPoll(state, T0 + 899 * SECOND), false);
  assertEquals(shouldPoll(state, T0 + 900 * SECOND), true);
});

Deno.test("shouldPoll: a pollAfterSeconds below the floor cannot shorten it", () => {
  const state = polledAt(T0, snapshot({ pollAfterSeconds: 10 }));
  assertEquals(shouldPoll(state, T0 + 899 * SECOND), false);
});

Deno.test("shouldPoll: a larger pollAfterSeconds lengthens the gap", () => {
  const state = polledAt(T0, snapshot({ pollAfterSeconds: 3600 }));
  assertEquals(shouldPoll(state, T0 + 3599 * SECOND), false);
  assertEquals(shouldPoll(state, T0 + 3600 * SECOND), true);
});

Deno.test("shouldPoll: pollAfterSeconds is capped at the 7-day ceiling", () => {
  const state = polledAt(T0, snapshot({ pollAfterSeconds: 1e12 }));
  assertEquals(
    shouldPoll(state, T0 + MAX_POLL_INTERVAL_SECONDS * SECOND - 1),
    false,
  );
  assertEquals(
    shouldPoll(state, T0 + MAX_POLL_INTERVAL_SECONDS * SECOND),
    true,
  );
});

Deno.test("shouldPoll: a non-finite or negative pollAfterSeconds counts as the floor", () => {
  for (const pollAfterSeconds of [NaN, Infinity, -5]) {
    const state = polledAt(T0, snapshot({ pollAfterSeconds }));
    assertEquals(shouldPoll(state, T0 + 899 * SECOND), false);
    assertEquals(shouldPoll(state, T0 + 900 * SECOND), true);
  }
});

Deno.test("shouldPoll: due when the last poll is in the future (clock went back)", () => {
  const state = polledAt(T0);
  assertEquals(shouldPoll(state, T0 - HOUR), true);
});

Deno.test("shouldPoll: a stopped key never polls", () => {
  const state = applyPollOutcome(
    InboxState.empty(),
    { kind: "rejected" },
    T0,
  );
  assertEquals(shouldPoll(state, T0 + 365 * 24 * HOUR), false);
  assertEquals(shouldPoll(state, T0 - HOUR), false);
});

Deno.test("applyPollOutcome: ok replaces the snapshot and records the poll", () => {
  const first = polledAt(T0, snapshot({ etag: '"e1"' }));
  const next = snapshot({ unread: 5, newestId: ID_B, etag: '"e2"' });
  const state = applyPollOutcome(
    first,
    { kind: "ok", snapshot: next },
    T0 + HOUR,
  );
  assertEquals(state.snapshot, next);
  assertEquals(state.schedule.lastPolledAt, T0 + HOUR);
});

Deno.test("applyPollOutcome: not_modified and failed keep the snapshot and etag", () => {
  const first = polledAt(T0);
  for (
    const outcome of [
      { kind: "not_modified" } as const,
      { kind: "failed", reason: "connection failed" } as const,
    ]
  ) {
    const state = applyPollOutcome(first, outcome, T0 + HOUR);
    assertEquals(state.snapshot, first.snapshot);
    assertEquals(state.schedule.lastPolledAt, T0 + HOUR);
    assertEquals(state.schedule.stop, null);
  }
});

Deno.test("applyPollOutcome: failed still spaces polls 900 seconds apart", () => {
  const state = applyPollOutcome(
    InboxState.empty(),
    { kind: "failed", reason: "HTTP 500" },
    T0,
  );
  assertEquals(shouldPoll(state, T0 + 899 * SECOND), false);
  assertEquals(shouldPoll(state, T0 + 900 * SECOND), true);
});

Deno.test("applyPollOutcome: backoff waits out Retry-After", () => {
  const state = applyPollOutcome(
    polledAt(T0),
    { kind: "backoff", retryAfterSeconds: 7200 },
    T0,
  );
  assertEquals(state.schedule.nextPollAt, T0 + 7200 * SECOND);
  assertEquals(shouldPoll(state, T0 + 7199 * SECOND), false);
  assertEquals(shouldPoll(state, T0 + 7200 * SECOND), true);
});

Deno.test("applyPollOutcome: backoff without Retry-After waits 900 seconds", () => {
  const state = applyPollOutcome(polledAt(T0), { kind: "backoff" }, T0);
  assertEquals(state.schedule.nextPollAt, T0 + 900 * SECOND);
});

Deno.test("applyPollOutcome: a short Retry-After cannot shorten the 900-second floor", () => {
  const state = applyPollOutcome(
    polledAt(T0),
    { kind: "backoff", retryAfterSeconds: 5 },
    T0,
  );
  assertEquals(shouldPoll(state, T0 + 899 * SECOND), false);
});

Deno.test("applyPollOutcome: Retry-After is capped at the 7-day ceiling", () => {
  const state = applyPollOutcome(
    polledAt(T0),
    { kind: "backoff", retryAfterSeconds: 1e12 },
    T0,
  );
  assertEquals(
    state.schedule.nextPollAt,
    T0 + MAX_POLL_INTERVAL_SECONDS * SECOND,
  );
});

Deno.test("applyPollOutcome: a later outcome clears an earlier backoff", () => {
  const backedOff = applyPollOutcome(
    polledAt(T0),
    { kind: "backoff", retryAfterSeconds: 7200 },
    T0,
  );
  const state = applyPollOutcome(
    backedOff,
    { kind: "not_modified" },
    T0 + 7200 * SECOND,
  );
  assertEquals(state.schedule.nextPollAt, null);
});

Deno.test("applyPollOutcome: unavailable and rejected stop the key with why and when", () => {
  for (const kind of ["unavailable", "rejected"] as const) {
    const state = applyPollOutcome(polledAt(T0), { kind }, T0 + HOUR);
    assertEquals(state.schedule.stop, { reason: kind, at: T0 + HOUR });
    assertEquals(state.snapshot, polledAt(T0).snapshot);
  }
});

Deno.test("applyPollOutcome: unsupported asks again in 24 hours and never stops the key", () => {
  assertEquals(UNSUPPORTED_RETRY_SECONDS, 24 * 60 * 60);
  const before = polledAt(T0);
  const state = applyPollOutcome(before, { kind: "unsupported" }, T0 + HOUR);
  assertEquals(state.schedule, {
    lastPolledAt: T0 + HOUR,
    nextPollAt: T0 + 25 * HOUR,
    stop: null,
  });
  assertEquals(state.snapshot, before.snapshot);
});

Deno.test("shouldPoll: after unsupported, not due at 23 h 59 m and due at 24 h", () => {
  for (
    const start of [
      InboxState.empty(),
      polledAt(T0 - HOUR, snapshot({ pollAfterSeconds: 900 })),
    ]
  ) {
    const state = applyPollOutcome(start, { kind: "unsupported" }, T0);
    assertEquals(shouldPoll(state, T0 + 24 * HOUR - MINUTE), false);
    assertEquals(shouldPoll(state, T0 + 24 * HOUR), true);
  }
});

Deno.test("shouldPoll: after unsupported, a longer pollAfterSeconds still wins", () => {
  const state = applyPollOutcome(
    polledAt(T0 - HOUR, snapshot({ pollAfterSeconds: 48 * 60 * 60 })),
    { kind: "unsupported" },
    T0,
  );
  assertEquals(shouldPoll(state, T0 + 24 * HOUR), false);
  assertEquals(shouldPoll(state, T0 + 48 * HOUR), true);
});

Deno.test("applyPollOutcome: an ok after unsupported resumes the 900-second floor", () => {
  const retrying = applyPollOutcome(
    InboxState.empty(),
    { kind: "unsupported" },
    T0,
  );
  const resumed = applyPollOutcome(
    retrying,
    { kind: "ok", snapshot: snapshot() },
    T0 + 24 * HOUR,
  );
  assertEquals(resumed.schedule.nextPollAt, null);
  assertEquals(resumed.schedule.stop, null);
  const t = T0 + 24 * HOUR;
  assertEquals(shouldPoll(resumed, t + 900 * SECOND - 1), false);
  assertEquals(shouldPoll(resumed, t + 900 * SECOND), true);
});

Deno.test("applyPollOutcome: only an answer the key earned clears a stop", () => {
  const stopped = applyPollOutcome(
    InboxState.empty(),
    { kind: "rejected" },
    T0,
  );
  for (
    const outcome of [
      { kind: "unsupported" },
      { kind: "unavailable" },
      { kind: "rejected" },
      { kind: "backoff" },
      { kind: "failed", reason: "HTTP 500" },
    ] as const
  ) {
    const after = applyPollOutcome(stopped, outcome, T0 + HOUR);
    assertEquals(after.schedule.stop, { reason: "rejected", at: T0 });
  }
});

Deno.test("applyPollOutcome: a key rejected once polls again after an ok or not_modified", () => {
  const stopped = applyPollOutcome(
    InboxState.empty(),
    { kind: "rejected" },
    T0,
  );
  assertEquals(shouldPoll(stopped, T0 + 2 * HOUR), false);
  for (
    const outcome of [
      { kind: "ok", snapshot: snapshot() },
      { kind: "not_modified" },
    ] as const
  ) {
    const working = applyPollOutcome(stopped, outcome, T0 + HOUR);
    assertEquals(working.schedule.stop, null);
    assertEquals(shouldPoll(working, T0 + HOUR + 899 * SECOND), false);
    assertEquals(shouldPoll(working, T0 + HOUR + 900 * SECOND), true);
  }
});

Deno.test("applyPollOutcome: an older snapshot never replaces a newer one", () => {
  const newer = snapshot({ unread: 0, newestId: null, fetchedAt: T0 + 10 });
  const held = applyPollOutcome(
    InboxState.empty(),
    { kind: "ok", snapshot: newer },
    T0 + 10,
  );
  const older = snapshot({ unread: 1, fetchedAt: T0 });
  const after = applyPollOutcome(
    held,
    { kind: "ok", snapshot: older },
    T0 + 20,
  );
  assertEquals(after.snapshot, newer);
  // Still a poll: the schedule moves on.
  assertEquals(after.schedule.lastPolledAt, T0 + 20);
  const later = snapshot({ unread: 3, fetchedAt: T0 + 15 });
  assertEquals(
    applyPollOutcome(held, { kind: "ok", snapshot: later }, T0 + 20).snapshot,
    later,
  );
});

Deno.test("applyPollOutcome: a held snapshot fetched in the future or before fetchedAt existed never blocks a new one", () => {
  const fetched = snapshot({ unread: 4, fetchedAt: T0 });
  for (
    const held of [
      snapshot({ fetchedAt: T0 + DAY }),
      snapshot(),
    ]
  ) {
    const state = { ...InboxState.empty(), snapshot: held };
    assertEquals(
      applyPollOutcome(state, { kind: "ok", snapshot: fetched }, T0 + HOUR)
        .snapshot,
      fetched,
    );
  }
});

Deno.test("applyPollOutcome: never changes the announcement", () => {
  const shown = recordNoticeShown(polledAt(T0), T0);
  const state = applyPollOutcome(
    shown,
    { kind: "ok", snapshot: snapshot({ newestId: ID_B }) },
    T0 + HOUR,
  );
  assertEquals(state.announcement, shown.announcement);
});

Deno.test("noticeToShow: nothing before the first poll", () => {
  assertEquals(noticeToShow(InboxState.empty(), T0), null);
});

Deno.test("noticeToShow: shows unread messages never announced", () => {
  assertEquals(noticeToShow(polledAt(T0), T0), { unread: 2 });
});

Deno.test("noticeToShow: silent when nothing is unread, whatever the announcement", () => {
  const state = polledAt(T0, snapshot({ unread: 0 }));
  assertEquals(noticeToShow(state, T0), null);
  const announced = recordNoticeShown(polledAt(T0), T0);
  const read = applyPollOutcome(
    announced,
    { kind: "ok", snapshot: snapshot({ unread: 0, newestId: null }) },
    T0 + HOUR,
  );
  assertEquals(noticeToShow(read, T0 + HOUR), null);
});

Deno.test("noticeToShow: repeats within 24 hours and retires at 24 hours", () => {
  const shown = recordNoticeShown(polledAt(T0), T0);
  assertEquals(noticeToShow(shown, T0 + NOTICE_LIFETIME_MS - 1), { unread: 2 });
  assertEquals(noticeToShow(shown, T0 + NOTICE_LIFETIME_MS), null);
});

Deno.test("noticeToShow: an announcement dated after now (clock went back) is retired", () => {
  const shown = recordNoticeShown(polledAt(T0), T0);
  assertEquals(noticeToShow(shown, T0 - SECOND), null);
  assertEquals(noticeToShow(shown, T0 - DAY), null);
  assertEquals(noticeToShow(shown, T0), { unread: 2 });
});

Deno.test("noticeToShow: a newer message restarts the 24 hours", () => {
  const shown = recordNoticeShown(polledAt(T0), T0);
  const later = T0 + NOTICE_LIFETIME_MS + HOUR;
  const newer = applyPollOutcome(
    shown,
    { kind: "ok", snapshot: snapshot({ unread: 3, newestId: ID_B }) },
    later,
  );
  assertEquals(noticeToShow(newer, later), { unread: 3 });
  const reshown = recordNoticeShown(newer, later);
  assertEquals(reshown.announcement, { id: ID_B, at: later });
  assertEquals(noticeToShow(reshown, later + NOTICE_LIFETIME_MS - 1), {
    unread: 3,
  });
  assertEquals(noticeToShow(reshown, later + NOTICE_LIFETIME_MS), null);
});

Deno.test("noticeToShow: an older newest message than the one announced shows nothing", () => {
  const shownB = recordNoticeShown(
    polledAt(T0, snapshot({ newestId: ID_B })),
    T0,
  );
  const olderNewest = applyPollOutcome(
    shownB,
    { kind: "ok", snapshot: snapshot({ unread: 1, newestId: ID_A }) },
    T0 + HOUR,
  );
  assertEquals(noticeToShow(olderNewest, T0 + HOUR), null);
});

Deno.test("recordNoticeShown: the first showing sets the announcement", () => {
  const state = recordNoticeShown(polledAt(T0), T0 + SECOND);
  assertEquals(state.announcement, { id: ID_A, at: T0 + SECOND });
});

Deno.test("recordNoticeShown: later showings of the same message keep the first time", () => {
  const first = recordNoticeShown(polledAt(T0), T0);
  const again = recordNoticeShown(first, T0 + HOUR);
  assertEquals(again.announcement, { id: ID_A, at: T0 });
});

Deno.test("recordNoticeShown: does nothing when no notice is due", () => {
  const state = polledAt(T0, snapshot({ unread: 0 }));
  assertEquals(recordNoticeShown(state, T0), state);
});

Deno.test("recordNoticeShown: never changes the snapshot", () => {
  const before = polledAt(T0);
  const after = recordNoticeShown(before, T0);
  assertEquals(after.snapshot, before.snapshot);
  assertEquals(after.schedule, before.schedule);
});
