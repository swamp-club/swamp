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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  applyPollOutcome,
  daysLeft,
  effectiveNotices,
  NOTICE_REPEAT_MS,
  noticeToShow,
  recordNoticeShown,
} from "./account_notice_policy.ts";
import { type AccountNotice, noticeKey } from "./account_notice.ts";
import {
  type AccountNoticePollOutcome,
  AccountNoticeState,
} from "./account_notice_state.ts";

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
// pinned, not imported: a change to the formula must fail here
const serverDaysRemaining = (endsAt: number, now: number) =>
  Math.ceil((endsAt - now) / DAY);

const SLUGS = ["keeb", "acme", "bayou"];

const notice: fc.Arbitrary<AccountNotice> = fc.record({
  slug: fc.constantFrom(...SLUGS),
  ending: fc.boolean(),
  endsIn: fc.integer({ min: -2 * DAY, max: 7 * DAY }),
}).map(({ slug, ending, endsIn }) => {
  const collective = { slug, name: slug, personal: slug === "keeb" };
  return ending
    ? {
      kind: "trial-ending" as const,
      collective,
      billingPath: "/billing",
      endsAt: T0 + endsIn,
      daysRemaining: Math.max(1, serverDaysRemaining(T0 + endsIn, T0)),
    }
    : { kind: "trial-ended" as const, collective, billingPath: "/billing" };
});

const outcome: fc.Arbitrary<AccountNoticePollOutcome> = fc.oneof(
  {
    arbitrary: fc.record({
      notices: fc.array(notice, { maxLength: 4 }),
      lag: fc.integer({ min: 0, max: 60_000 }),
    }).map(({ notices, lag }) => ({
      kind: "ok" as const,
      notices,
      sentAt: -lag,
    })),
    weight: 8,
  },
  {
    arbitrary: fc.constant({ kind: "failed" as const, reason: "x" }),
    weight: 2,
  },
  { arbitrary: fc.constant({ kind: "unsupported" as const }), weight: 1 },
  { arbitrary: fc.constant({ kind: "backoff" as const }), weight: 1 },
  { arbitrary: fc.constant({ kind: "rejected" as const }), weight: 1 },
);

const run = fc.array(
  fc.record({
    step: fc.integer({ min: 0, max: 3 * DAY }),
    poll: fc.option(outcome, { nil: undefined }),
  }),
  { maxLength: 30 },
);

Deno.test("property: a notice never shows twice within 24 hours", () => {
  fc.assert(fc.property(run, (events) => {
    let state = AccountNoticeState.empty();
    let now = T0;
    const lastShown = new Map<string, number>();
    for (const { step, poll } of events) {
      now += step;
      if (poll) {
        const o = poll.kind === "ok"
          ? { ...poll, sentAt: now + poll.sentAt }
          : poll;
        state = applyPollOutcome(state, o, now);
      }
      const shown = noticeToShow(state, now);
      if (shown === null) continue;
      const key = noticeKey(shown.notice);
      const last = lastShown.get(key);
      assert(last === undefined || now - last >= NOTICE_REPEAT_MS);
      lastShown.set(key, now);
      state = recordNoticeShown(state, shown.notice, now);
    }
  }));
});

Deno.test("property: once a trial reads as ended it never reads as ending again", () => {
  fc.assert(fc.property(
    fc.array(notice, { minLength: 1, maxLength: 4 }),
    fc.array(fc.integer({ min: 0, max: 2 * DAY }), { maxLength: 20 }),
    (notices, steps) => {
      const snap = { notices, fetchedAt: T0 };
      const endedSlugs = new Set<string>();
      let now = T0;
      for (const step of steps) {
        now += step;
        for (const n of effectiveNotices(snap, now)) {
          if (n.kind === "trial-ended") endedSlugs.add(n.collective.slug);
          else assert(!endedSlugs.has(n.collective.slug));
        }
      }
    },
  ));
});

Deno.test("property: daysLeft matches swamp-club's count and never rises as time passes", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 7 * DAY }),
    fc.array(fc.integer({ min: 0, max: DAY }), { maxLength: 20 }),
    (endsIn, steps) => {
      const endsAt = T0 + endsIn;
      const n = {
        kind: "trial-ending" as const,
        collective: { slug: "keeb", name: "keeb", personal: true },
        billingPath: null,
        endsAt,
        daysRemaining: serverDaysRemaining(endsAt, T0),
      };
      assertEquals(daysLeft(n, T0), serverDaysRemaining(endsAt, T0));
      let now = T0;
      let previous = daysLeft(n, now);
      for (const step of steps) {
        now += step;
        if (now >= endsAt) break;
        const current = daysLeft(n, now);
        assertEquals(current, Math.max(1, serverDaysRemaining(endsAt, now)));
        assert(current <= previous);
        previous = current;
      }
    },
  ));
});

Deno.test("property: after a successful poll, showings only name standing or recent notices", () => {
  fc.assert(fc.property(run, (events) => {
    let state = AccountNoticeState.empty();
    let now = T0;
    for (const { step, poll } of events) {
      now += step;
      const shown = noticeToShow(state, now);
      if (shown) state = recordNoticeShown(state, shown.notice, now);
      if (poll?.kind === "ok") {
        state = applyPollOutcome(state, { ...poll, sentAt: now }, now);
        const standing = new Set(
          effectiveNotices(state.snapshot, now).map(noticeKey),
        );
        for (const [key, at] of Object.entries(state.shown)) {
          assert(standing.has(key) || now - at < NOTICE_REPEAT_MS);
        }
      }
    }
  }));
});
