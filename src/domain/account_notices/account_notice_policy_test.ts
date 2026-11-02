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
  daysLeft,
  effectiveNotices,
  hasEndedTrial,
  NOTICE_REPEAT_MS,
  noticeToShow,
  recordNoticeShown,
  shouldPoll,
} from "./account_notice_policy.ts";
import { type AccountNotice, noticeKey } from "./account_notice.ts";
import { AccountNoticeState } from "./account_notice_state.ts";
import {
  MAX_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  UNSUPPORTED_RETRY_SECONDS,
} from "../inbox/inbox_policy.ts";

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;

const personal = { slug: "keeb", name: "keeb", personal: true };
const team = { slug: "acme", name: "Acme", personal: false };

function ending(
  endsAt: number,
  daysRemaining: number,
  collective = personal,
): Extract<AccountNotice, { kind: "trial-ending" }> {
  return {
    kind: "trial-ending",
    collective,
    billingPath: "/billing",
    endsAt,
    daysRemaining,
  };
}

function ended(collective = personal): AccountNotice {
  return { kind: "trial-ended", collective, billingPath: "/billing" };
}

function polled(
  notices: AccountNotice[],
  at = T0,
  state = AccountNoticeState.empty(),
): AccountNoticeState {
  return applyPollOutcome(state, { kind: "ok", notices, sentAt: at }, at);
}

Deno.test("effectiveNotices: an ending trial past its end reads as ended", () => {
  const snap = { notices: [ending(T0 + HOUR, 1)], fetchedAt: T0 };
  assertEquals(effectiveNotices(snap, T0)[0].kind, "trial-ending");
  assertEquals(effectiveNotices(snap, T0 + HOUR), [ended()]);
});

Deno.test("effectiveNotices: one notice per collective, the ended one, ended first", () => {
  const snap = {
    notices: [ending(T0 + 3 * DAY, 3, team), ending(T0 - 1, 1), ended()],
    fetchedAt: T0,
  };
  assertEquals(effectiveNotices(snap, T0), [
    ended(),
    ending(T0 + 3 * DAY, 3, team),
  ]);
});

Deno.test("effectiveNotices: no snapshot means no notices", () => {
  assertEquals(effectiveNotices(null, T0), []);
});

Deno.test("daysLeft: counts elapsed milliseconds up to a whole day, as swamp-club does", () => {
  const n = ending(T0 + 5 * DAY, 5);
  assertEquals(daysLeft(n, T0), 5);
  assertEquals(daysLeft(n, T0 + 1), 5);
  assertEquals(daysLeft(n, T0 + DAY), 4);
  assertEquals(daysLeft(n, T0 + 2 * DAY + 1), 3);
});

Deno.test("daysLeft: a stale cache never shows the count it was fetched with", () => {
  assertEquals(daysLeft(ending(T0 + 5 * DAY, 5), T0 + 2 * DAY), 3);
});

Deno.test("daysLeft: a clock running behind cannot raise the server's count", () => {
  assertEquals(daysLeft(ending(T0 + 5 * DAY, 5), T0 - 3 * DAY), 5);
});

Deno.test("daysLeft: never less than one while the trial runs", () => {
  assertEquals(daysLeft(ending(T0 + SECOND, 1), T0), 1);
  assertEquals(daysLeft(ending(T0 + SECOND, 0), T0), 1);
});

Deno.test("shouldPoll: a slow command polls a key never polled", () => {
  assertEquals(
    shouldPoll(AccountNoticeState.empty(), T0, { slowCommand: true }),
    true,
  );
});

Deno.test("shouldPoll: a fast command does not poll without an ended trial", () => {
  assertEquals(
    shouldPoll(AccountNoticeState.empty(), T0, { slowCommand: false }),
    false,
  );
  const state = polled([ending(T0 + 3 * DAY, 3)]);
  assertEquals(
    shouldPoll(state, T0 + DAY, { slowCommand: false }),
    false,
  );
});

Deno.test("shouldPoll: a fast command polls once an ended trial is cached, after the floor", () => {
  const state = polled([ended()]);
  const floor = MIN_POLL_INTERVAL_SECONDS * SECOND;
  assertEquals(
    shouldPoll(state, T0 + floor - 1, { slowCommand: false }),
    false,
  );
  assertEquals(shouldPoll(state, T0 + floor, { slowCommand: false }), true);
});

Deno.test("shouldPoll: an ending trial that has passed its end lets a fast command poll", () => {
  const state = polled([ending(T0 + HOUR, 1)]);
  assertEquals(shouldPoll(state, T0 + 2 * HOUR, { slowCommand: false }), true);
});

Deno.test("shouldPoll: waits out the floor and respects a backoff", () => {
  const state = polled([]);
  const floor = MIN_POLL_INTERVAL_SECONDS * SECOND;
  assertEquals(shouldPoll(state, T0 + floor - 1, { slowCommand: true }), false);
  assertEquals(shouldPoll(state, T0 + floor, { slowCommand: true }), true);
  const backedOff = applyPollOutcome(state, {
    kind: "backoff",
    retryAfterSeconds: 3600,
  }, T0);
  assertEquals(
    shouldPoll(backedOff, T0 + 3599 * SECOND, { slowCommand: true }),
    false,
  );
  assertEquals(shouldPoll(backedOff, T0 + HOUR, { slowCommand: true }), true);
});

Deno.test("shouldPoll: the ceiling bounds any wait", () => {
  const state = applyPollOutcome(AccountNoticeState.empty(), {
    kind: "backoff",
    retryAfterSeconds: 1e12,
  }, T0);
  const ceiling = MAX_POLL_INTERVAL_SECONDS * SECOND;
  assertEquals(shouldPoll(state, T0 + ceiling, { slowCommand: true }), true);
});

Deno.test("shouldPoll: a clock that went back polls", () => {
  const state = polled([], T0);
  assertEquals(shouldPoll(state, T0 - HOUR, { slowCommand: true }), true);
});

Deno.test("applyPollOutcome: a collective key's answer stops for good and drops the notices", () => {
  const stopped = applyPollOutcome(polled([ended()]), {
    kind: "unavailable",
  }, T0 + HOUR);
  assertEquals(stopped.snapshot, null);
  assertEquals(stopped.schedule.stop, { reason: "unavailable", at: T0 + HOUR });
  assertEquals(noticeToShow(stopped, T0 + 2 * DAY), null);
  assertEquals(
    shouldPoll(stopped, T0 + 30 * DAY, { slowCommand: true }),
    false,
  );
  const stale = applyPollOutcome(stopped, {
    kind: "ok",
    notices: [ended()],
    sentAt: T0,
  }, T0 + 2 * HOUR);
  assertEquals(stale.snapshot, null);
});

Deno.test("applyPollOutcome: a 401 keeps the showings, so a quick recovery can't show a notice twice in a day", () => {
  const shown = recordNoticeShown(polled([ended()]), ended(), T0);
  const rejected = applyPollOutcome(shown, { kind: "rejected" }, T0 + HOUR);
  const recovered = polled([ended()], T0 + 2 * HOUR, rejected);
  assertEquals(noticeToShow(recovered, T0 + 2 * HOUR), null);
});

Deno.test("applyPollOutcome: a 401 drops the notices but asks again in a day, so a valid key recovers", () => {
  const rejected = applyPollOutcome(polled([ended()]), {
    kind: "rejected",
  }, T0 + HOUR);
  assertEquals(rejected.snapshot, null);
  assertEquals(rejected.schedule.stop, null);
  assertEquals(noticeToShow(rejected, T0 + 2 * HOUR), null);
  assertEquals(
    shouldPoll(rejected, T0 + HOUR + DAY - 1, { slowCommand: true }),
    false,
  );
  assertEquals(
    shouldPoll(rejected, T0 + HOUR + DAY, { slowCommand: true }),
    true,
  );
  const recovered = polled([ended()], T0 + HOUR + DAY, rejected);
  assertEquals(noticeToShow(recovered, T0 + HOUR + DAY)?.notice, ended());
});

Deno.test("applyPollOutcome: a success sent after a stop clears it, one sent before does not", () => {
  const stopped = applyPollOutcome(AccountNoticeState.empty(), {
    kind: "unavailable",
  }, T0);
  const before = applyPollOutcome(stopped, {
    kind: "ok",
    notices: [],
    sentAt: T0 - SECOND,
  }, T0 + SECOND);
  assertEquals(before.schedule.stop, { reason: "unavailable", at: T0 });
  const after = applyPollOutcome(stopped, {
    kind: "ok",
    notices: [],
    sentAt: T0 + SECOND,
  }, T0 + 2 * SECOND);
  assertEquals(after.schedule.stop, null);
});

Deno.test("applyPollOutcome: unsupported waits a day", () => {
  const state = applyPollOutcome(AccountNoticeState.empty(), {
    kind: "unsupported",
  }, T0);
  assertEquals(
    state.schedule.nextPollAt,
    T0 + UNSUPPORTED_RETRY_SECONDS * SECOND,
  );
  assertEquals(state.schedule.stop, null);
});

Deno.test("applyPollOutcome: a failure keeps a backoff the server asked for", () => {
  const backedOff = applyPollOutcome(polled([ended()]), {
    kind: "backoff",
    retryAfterSeconds: 3600,
  }, T0);
  const failed = applyPollOutcome(backedOff, {
    kind: "failed",
    reason: "timeout",
  }, T0 + 60 * SECOND);
  assertEquals(failed.schedule.nextPollAt, T0 + HOUR);
  const later = applyPollOutcome(backedOff, {
    kind: "failed",
    reason: "timeout",
  }, T0 + 2 * HOUR);
  assertEquals(later.schedule.nextPollAt, null);
});

Deno.test("applyPollOutcome: failed counts as a poll and keeps the snapshot", () => {
  const state = polled([ended()]);
  const failed = applyPollOutcome(
    state,
    { kind: "failed", reason: "x" },
    T0 + DAY,
  );
  assertEquals(failed.snapshot, state.snapshot);
  assertEquals(failed.schedule.lastPolledAt, T0 + DAY);
});

Deno.test("applyPollOutcome: an older answer never replaces a newer snapshot", () => {
  const newer = polled([ended()], T0 + HOUR);
  const older = applyPollOutcome(newer, {
    kind: "ok",
    notices: [],
    sentAt: T0,
  }, T0 + 2 * HOUR);
  assertEquals(older.snapshot?.notices, [ended()]);
});

Deno.test("applyPollOutcome: drops a showing once its notice is gone and its day is up", () => {
  const shown = recordNoticeShown(
    polled([ended(), ended(team)]),
    ended(team),
    T0,
  );
  // shown an hour ago, so it is kept although gone
  const soon = polled([ended()], T0 + HOUR, shown);
  assertEquals(soon.shown, { [noticeKey(ended(team))]: T0 });
  assertEquals(
    noticeToShow(polled([ended(team)], T0 + 2 * HOUR, soon), T0 + 2 * HOUR),
    null,
  );
  const later = polled([ended()], T0 + DAY, shown);
  assertEquals(later.shown, {});
});

Deno.test("applyPollOutcome: keeps the showing of a notice that still stands", () => {
  const kept = recordNoticeShown(polled([ended()]), ended(), T0);
  const again = polled([ended()], T0 + 3 * DAY, kept);
  assertEquals(again.shown, { [noticeKey(ended())]: T0 });
});

Deno.test("noticeToShow: shows the first standing notice, then not again for 24 hours", () => {
  const state = polled([ended(), ending(T0 + 3 * DAY, 3, team)]);
  assertEquals(noticeToShow(state, T0), { notice: ended() });
  const once = recordNoticeShown(state, ended(), T0);
  assertEquals(noticeToShow(once, T0)?.notice.collective.slug, "acme");
  const both = recordNoticeShown(once, ending(T0 + 3 * DAY, 3, team), T0);
  assertEquals(noticeToShow(both, T0 + NOTICE_REPEAT_MS - 1), null);
  assertEquals(noticeToShow(both, T0 + NOTICE_REPEAT_MS)?.notice, ended());
});

Deno.test("noticeToShow: an ending trial carries the day count at display time", () => {
  const state = polled([ending(T0 + 5 * DAY, 5)]);
  assertEquals(noticeToShow(state, T0 + 2 * DAY)?.daysLeft, 3);
});

Deno.test("noticeToShow: the flip to ended shows at once, even after the ending notice showed today", () => {
  const n = ending(T0 + HOUR, 1);
  const shownEnding = recordNoticeShown(polled([n]), n, T0);
  assertEquals(noticeToShow(shownEnding, T0 + 30 * 60 * SECOND), null);
  assertEquals(noticeToShow(shownEnding, T0 + HOUR), { notice: ended() });
});

Deno.test("noticeToShow: a showing dated in the future does not hold the notice back", () => {
  const state = recordNoticeShown(polled([ended()]), ended(), T0 + DAY);
  assertEquals(noticeToShow(state, T0), { notice: ended() });
});

Deno.test("hasEndedTrial: reads the cache as it stands at now", () => {
  const state = polled([ending(T0 + HOUR, 1)]);
  assertEquals(hasEndedTrial(state, T0), false);
  assertEquals(hasEndedTrial(state, T0 + HOUR), true);
});
