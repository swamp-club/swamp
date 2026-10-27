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
  MAX_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  NOTICE_LIFETIME_MS,
  noticeToShow,
  recordNoticeShown,
  shouldPoll,
} from "./inbox_policy.ts";
import { InboxState, type PollOutcome } from "./inbox_state.ts";

const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const MIN_GAP_MS = MIN_POLL_INTERVAL_SECONDS * SECOND;
const MAX_GAP_MS = MAX_POLL_INTERVAL_SECONDS * SECOND;

/** Ascending ULIDs, so later entries are newer messages. */
const IDS = ["A0", "A1", "A2", "A3", "A4"].map((s) =>
  `01JBQ0000000000000000000${s}`
);

const okOutcome: fc.Arbitrary<PollOutcome> = fc.record({
  unread: fc.integer({ min: 0, max: 4 }),
  newestId: fc.constantFrom(null, ...IDS),
  pollAfterSeconds: fc.constantFrom(0, 300, 900, 3600, 1e9),
  etag: fc.constantFrom(null, '"e1"', '"e2"'),
}).map((s) => ({
  kind: "ok" as const,
  snapshot: { ...s, newestAt: null },
}));

const outcome: fc.Arbitrary<PollOutcome> = fc.oneof(
  { arbitrary: okOutcome, weight: 12 },
  { arbitrary: fc.constant({ kind: "not_modified" as const }), weight: 3 },
  {
    arbitrary: fc.constantFrom(undefined, 5, 900, 7200, 1e9).map((r) =>
      r === undefined
        ? { kind: "backoff" as const }
        : { kind: "backoff" as const, retryAfterSeconds: r }
    ),
    weight: 2,
  },
  {
    arbitrary: fc.constant({ kind: "failed" as const, reason: "HTTP 500" }),
    weight: 2,
  },
  {
    arbitrary: fc.constantFrom(
      { kind: "unsupported" as const },
      { kind: "unavailable" as const },
      { kind: "rejected" as const },
    ),
    weight: 1,
  },
);

type Op =
  | { readonly op: "advance"; readonly ms: number }
  | { readonly op: "poll"; readonly outcome: PollOutcome }
  | { readonly op: "notice" };

function ops(minStepMs: number): fc.Arbitrary<Op[]> {
  const step = fc.oneof(
    fc.constantFrom(0, MIN_GAP_MS - 1, MIN_GAP_MS, DAY - 1, DAY, MAX_GAP_MS),
    fc.integer({ min: minStepMs, max: 8 * DAY }),
  );
  return fc.array(
    fc.oneof(
      step.map((ms): Op => ({ op: "advance", ms })),
      outcome.map((o): Op => ({ op: "poll", outcome: o })),
      fc.constant<Op>({ op: "notice" }),
    ),
    { minLength: 20, maxLength: 60 },
  );
}

type NoticeBranch = "new" | "repeat" | "retired" | "superseded" | "silent";

interface Coverage {
  outcomes: Record<string, number>;
  notices: Record<string, number>;
  blocked: number;
}

function newCoverage(): Coverage {
  return { outcomes: {}, notices: {}, blocked: 0 };
}

function noticeBranch(state: InboxState, now: number): NoticeBranch {
  const { snapshot, announcement } = state;
  if (snapshot === null || snapshot.unread <= 0 || snapshot.newestId === null) {
    return "silent";
  }
  if (announcement === null || snapshot.newestId > announcement.id) {
    return "new";
  }
  if (snapshot.newestId < announcement.id) return "superseded";
  return now - announcement.at < NOTICE_LIFETIME_MS ? "repeat" : "retired";
}

/**
 * Plays a sequence and returns the first broken invariant, or undefined. With
 * a monotonic clock it also checks the rules that a clock going back may
 * legitimately bend: poll spacing and a retired notice staying retired.
 */
function play(
  sequence: Op[],
  monotonic: boolean,
  coverage: Coverage,
): string | undefined {
  let state = InboxState.empty();
  let now = T0;
  let lastPollTime: number | null = null;
  const firstShown = new Map<string, number>();
  const superseded = new Set<string>();
  for (const step of sequence) {
    const stopBefore = state.schedule.stop;
    if (step.op === "advance") {
      now += step.ms;
    } else if (step.op === "poll") {
      const { lastPolledAt, stop } = state.schedule;
      const due = shouldPoll(state, now);
      if (
        stop === null && lastPolledAt !== null && lastPolledAt <= now &&
        now - lastPolledAt >= MAX_GAP_MS && !due
      ) {
        return "a key not stopped was not due 7 days after its last poll";
      }
      if (!due) {
        coverage.blocked++;
        continue;
      }
      if (stop !== null) return "a stopped key polled";
      if (
        monotonic && lastPollTime !== null && now - lastPollTime < MIN_GAP_MS
      ) {
        return `two polls ${now - lastPollTime} ms apart`;
      }
      const next = applyPollOutcome(state, step.outcome, now);
      if (next.announcement !== state.announcement) {
        return "a poll changed the announcement";
      }
      coverage.outcomes[step.outcome.kind] =
        (coverage.outcomes[step.outcome.kind] ?? 0) + 1;
      state = next;
      lastPollTime = now;
    } else {
      const branch = noticeBranch(state, now);
      coverage.notices[branch] = (coverage.notices[branch] ?? 0) + 1;
      const notice = noticeToShow(state, now);
      const shouldShow = branch === "new" || branch === "repeat";
      if ((notice !== null) !== shouldShow) {
        return `notice ${notice === null ? "hidden" : "shown"} for ${branch}`;
      }
      const next = recordNoticeShown(state, now);
      if (
        next.snapshot !== state.snapshot || next.schedule !== state.schedule
      ) {
        return "the notice changed the snapshot or schedule";
      }
      if (notice === null) {
        if (next !== state) return "recording a hidden notice changed state";
        continue;
      }
      if (notice.unread !== state.snapshot?.unread) {
        return "the notice reported a different unread count";
      }
      const id = state.snapshot.newestId;
      if (id === null) return "a notice shown without a newest message";
      const { announcement } = next;
      if (announcement === null) return "a shown notice was not recorded";
      if (now - announcement.at >= NOTICE_LIFETIME_MS) {
        return "a notice shown 24 hours after it was announced";
      }
      if (monotonic) {
        if (superseded.has(id)) return `superseded ${id} showed again`;
        const first = firstShown.get(id);
        if (first !== undefined && now - first >= NOTICE_LIFETIME_MS) {
          return `retired ${id} showed again`;
        }
      }
      const previous = state.announcement;
      if (previous !== null && previous.id !== announcement.id) {
        superseded.add(previous.id);
      }
      if (!firstShown.has(id)) firstShown.set(id, now);
      state = next;
    }
    if (stopBefore !== null && state.schedule.stop !== stopBefore) {
      return "a stop was cleared or replaced";
    }
  }
  return undefined;
}

function assertCovered(coverage: Coverage, notices: NoticeBranch[]): void {
  console.log(
    "poll outcomes:",
    JSON.stringify(coverage.outcomes),
    "notice branches:",
    JSON.stringify(coverage.notices),
    "polls not due:",
    coverage.blocked,
  );
  for (
    const kind of [
      "ok",
      "not_modified",
      "unsupported",
      "unavailable",
      "rejected",
      "backoff",
      "failed",
    ]
  ) {
    assert((coverage.outcomes[kind] ?? 0) > 0, `never tried: ${kind}`);
  }
  for (const branch of notices) {
    assert((coverage.notices[branch] ?? 0) > 0, `never tried: ${branch}`);
  }
  assert(coverage.blocked > 0, "never tried: a poll that was not due");
}

Deno.test("inbox policy (property): with a monotonic clock, polls stay 900 s apart and retired notices stay retired", () => {
  const coverage = newCoverage();
  fc.assert(
    fc.property(ops(0), (sequence) => {
      const broken = play(sequence, true, coverage);
      assertEquals(broken, undefined, broken);
    }),
    { numRuns: 1000 },
  );
  assertCovered(coverage, ["new", "repeat", "retired", "superseded", "silent"]);
});

Deno.test("inbox policy (property): when the clock goes back, stopped keys stay stopped and notices never outlive 24 h", () => {
  const coverage = newCoverage();
  fc.assert(
    fc.property(ops(-2 * DAY), (sequence) => {
      const broken = play(sequence, false, coverage);
      assertEquals(broken, undefined, broken);
    }),
    { numRuns: 1000 },
  );
  assertCovered(coverage, ["new", "repeat", "silent"]);
});
