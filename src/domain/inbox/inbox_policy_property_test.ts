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
/** Pinned rather than imported, so a change to the policy's retry fails here. */
const RETRY_GAP_MS = DAY;

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
  /**
   * A background poll, sent `lag` ms before it is applied. `refresh` is the
   * `inbox read` refresh, which applies its answer whether a poll is due.
   */
  | {
    readonly op: "poll" | "refresh";
    readonly outcome: PollOutcome;
    readonly lag: number;
  }
  | { readonly op: "notice" };

const lag = fc.constantFrom(0, SECOND, MIN_GAP_MS, DAY);

function ops(minStepMs: number): fc.Arbitrary<Op[]> {
  const step = fc.oneof(
    fc.constantFrom(0, MIN_GAP_MS - 1, MIN_GAP_MS, DAY - 1, DAY, MAX_GAP_MS),
    fc.integer({ min: minStepMs, max: 8 * DAY }),
  );
  return fc.array(
    fc.oneof(
      step.map((ms): Op => ({ op: "advance", ms })),
      fc.tuple(outcome, lag).map(([o, l]): Op => ({
        op: "poll",
        outcome: o,
        lag: l,
      })),
      fc.tuple(outcome, lag).map(([o, l]): Op => ({
        op: "refresh",
        outcome: o,
        lag: l,
      })),
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
  retried: number;
  /** A stop cleared by an answer the key earned. */
  unstopped: number;
  /** A snapshot fetched earlier that lost to the one held. */
  olderLost: number;
  /** A stop kept against an answer sent before it. */
  staleKept: number;
}

function newCoverage(): Coverage {
  return {
    outcomes: {},
    notices: {},
    blocked: 0,
    retried: 0,
    unstopped: 0,
    olderLost: 0,
    staleKept: 0,
  };
}

/** Stamps the outcome with when its request was sent. */
function sent(outcome: PollOutcome, at: number): PollOutcome {
  if (outcome.kind === "ok") {
    return { ...outcome, snapshot: { ...outcome.snapshot, fetchedAt: at } };
  }
  return outcome.kind === "not_modified" ? { ...outcome, sentAt: at } : outcome;
}

/**
 * The invariants every applied answer keeps, poll or refresh: a working key
 * is never left stopped, any other answer never clears or replaces a stop,
 * and an older snapshot never replaces a newer one held.
 */
function checkApplied(
  before: InboxState,
  outcome: PollOutcome,
  after: InboxState,
  now: number,
  coverage: Coverage,
): string | undefined {
  const stop = before.schedule.stop;
  if (outcome.kind === "ok" || outcome.kind === "not_modified") {
    const sentAt = outcome.kind === "ok"
      ? outcome.snapshot.fetchedAt
      : outcome.sentAt;
    if (stop !== null && sentAt !== undefined && sentAt < stop.at) {
      // Sent before the stop: it says nothing about the key now.
      if (after.schedule.stop !== stop) return "a stale answer cleared a stop";
      coverage.staleKept++;
    } else {
      if (after.schedule.stop !== null) return "a working key stayed stopped";
      if (stop !== null) coverage.unstopped++;
    }
  } else if (stop !== null && after.schedule.stop !== stop) {
    return "a stop was cleared or replaced";
  }
  if (outcome.kind !== "ok") {
    if (after.snapshot !== before.snapshot) {
      return `${outcome.kind} changed the snapshot`;
    }
    return undefined;
  }
  const held = before.snapshot?.fetchedAt;
  const fetched = outcome.snapshot.fetchedAt!;
  const keepHeld = held !== undefined && held <= now && held > fetched;
  if (keepHeld) {
    if (after.snapshot !== before.snapshot) {
      return "an older snapshot replaced a newer one";
    }
    coverage.olderLost++;
  } else if (after.snapshot !== outcome.snapshot) {
    return "a newer snapshot was not kept";
  }
  return undefined;
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
  // An announcement dated after now means the clock went back.
  if (announcement.at > now) return "retired";
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
  let lastOutcome: PollOutcome["kind"] | null = null;
  const firstShown = new Map<string, number>();
  const superseded = new Set<string>();
  for (const step of sequence) {
    const stopBefore = state.schedule.stop;
    if (step.op === "advance") {
      now += step.ms;
    } else if (step.op === "refresh") {
      const applied = sent(step.outcome, now - step.lag);
      const next = applyPollOutcome(state, applied, now);
      const broken = checkApplied(state, applied, next, now, coverage);
      if (broken) return `refresh: ${broken}`;
      if (next.announcement !== state.announcement) {
        return "a refresh changed the announcement";
      }
      state = next;
      // Not a poll: it neither spaces nor follows the poll schedule.
      lastPollTime = null;
      lastOutcome = null;
      continue;
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
      if (lastOutcome === "unsupported" && lastPollTime !== null) {
        if (monotonic && now - lastPollTime < RETRY_GAP_MS) {
          return `polled ${now - lastPollTime} ms after unsupported`;
        }
        coverage.retried++;
      }
      if (
        monotonic && lastPollTime !== null && now - lastPollTime < MIN_GAP_MS
      ) {
        return `two polls ${now - lastPollTime} ms apart`;
      }
      const applied = sent(step.outcome, now - step.lag);
      const next = applyPollOutcome(state, applied, now);
      const broken = checkApplied(state, applied, next, now, coverage);
      if (broken) return `poll: ${broken}`;
      if (next.announcement !== state.announcement) {
        return "a poll changed the announcement";
      }
      coverage.outcomes[step.outcome.kind] =
        (coverage.outcomes[step.outcome.kind] ?? 0) + 1;
      state = next;
      lastPollTime = now;
      lastOutcome = step.outcome.kind;
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
      if (announcement.at > now) {
        return "a notice shown for an announcement dated after now";
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
      return "a notice cleared or replaced a stop";
    }
  }
  return undefined;
}

/**
 * Always played, so `assertCovered` does not depend on the random sequences
 * reaching the retry: unsupported, a wait of the retry gap, then a poll.
 */
const RETRY_EXAMPLE: [Op[]] = [[
  { op: "poll", outcome: { kind: "unsupported" }, lag: 0 },
  { op: "advance", ms: RETRY_GAP_MS },
  { op: "poll", outcome: { kind: "unsupported" }, lag: 0 },
]];

function assertCovered(coverage: Coverage, notices: NoticeBranch[]): void {
  console.log(
    "poll outcomes:",
    JSON.stringify(coverage.outcomes),
    "notice branches:",
    JSON.stringify(coverage.notices),
    "polls not due:",
    coverage.blocked,
    "polls after unsupported:",
    coverage.retried,
    "stops cleared:",
    coverage.unstopped,
    "older snapshots lost:",
    coverage.olderLost,
    "stale answers kept a stop:",
    coverage.staleKept,
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
  assert(coverage.retried > 0, "never tried: a poll after unsupported");
  assert(coverage.unstopped > 0, "never tried: a stop cleared");
  assert(coverage.olderLost > 0, "never tried: an older snapshot losing");
  assert(coverage.staleKept > 0, "never tried: a stale answer and a stop");
}

Deno.test("inbox policy (property): with a monotonic clock, polls stay 900 s apart and retired notices stay retired", () => {
  const coverage = newCoverage();
  fc.assert(
    fc.property(ops(0), (sequence) => {
      const broken = play(sequence, true, coverage);
      assertEquals(broken, undefined, broken);
    }),
    { numRuns: 1000, examples: [RETRY_EXAMPLE] },
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
    { numRuns: 1000, examples: [RETRY_EXAMPLE] },
  );
  assertCovered(coverage, ["new", "repeat", "silent"]);
});

Deno.test("inbox policy (property): a key that only ever sees unsupported keeps polling, once per 24 h", () => {
  const advance = fc.oneof(
    fc.constantFrom(0, MIN_GAP_MS, RETRY_GAP_MS - 1, RETRY_GAP_MS),
    fc.integer({ min: 0, max: 3 * DAY }),
  );
  let retries = 0;
  fc.assert(
    fc.property(fc.array(advance, { minLength: 5, maxLength: 40 }), (steps) => {
      let state = InboxState.empty();
      let now = T0;
      let lastPollTime: number | null = null;
      for (const ms of steps) {
        now += ms;
        const due = shouldPoll(state, now);
        const expected = lastPollTime === null ||
          now - lastPollTime >= RETRY_GAP_MS;
        assertEquals(due, expected, `due at ${now - (lastPollTime ?? now)} ms`);
        if (!due) continue;
        if (lastPollTime !== null) retries++;
        state = applyPollOutcome(state, { kind: "unsupported" }, now);
        assertEquals(state.schedule.stop, null);
        lastPollTime = now;
      }
    }),
    { numRuns: 500 },
  );
  assert(retries > 0, "never polled again after unsupported");
});
