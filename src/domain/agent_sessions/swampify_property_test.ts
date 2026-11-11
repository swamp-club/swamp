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
  readSwampifyCandidateSet,
  readSwampifyCandidateSetSummary,
  readSwampifyComparison,
  readSwampifyComparisonSummary,
  readSwampifyOffer,
  readSwampifyOfferSummary,
  SWAMPIFY_LIMITS,
  swampifyCandidateSetSummary,
  swampifyCandidateSetTags,
  swampifyComparisonSummary,
  swampifyComparisonTags,
  swampifyOfferSummary,
  swampifyOfferTags,
} from "./swampify.ts";

const L = SWAMPIFY_LIMITS;

const arbCount = fc.integer({ min: 0, max: 1_000_000 });
const arbAmount = fc.double({ min: 0, max: 1e9, noNaN: true });
const arbHex32 = fc.stringMatching(/^[0-9a-f]{32}$/);
const arbHex16 = fc.stringMatching(/^[0-9a-f]{16}$/);
const arbSlug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/);
const arbSessionId = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,30}$/);
const arbText = (max: number) => fc.string({ minLength: 1, maxLength: max });
const arbIso = fc.date({ min: new Date(0), max: new Date(4e12) }).map((d) =>
  d.toISOString()
);

// n datetimes in order, as toISOString writes them
const arbOrderedDates = (n: number) =>
  fc.array(fc.integer({ min: 0, max: 4_000_000_000_000 }), {
    minLength: n,
    maxLength: n,
  }).map((values) =>
    [...values].sort((a, b) => a - b).map((v) => new Date(v).toISOString())
  );

const arbRange = fc.array(arbAmount, { minLength: 3, maxLength: 3 }).map((
  values,
) => {
  const [min, median, max] = [...values].sort((a, b) => a - b);
  return { min, median, max };
});

const arbCost = fc.record({
  tokens: fc.record({
    input: arbRange,
    output: arbRange,
    cacheRead: arbRange,
    cacheWrite: arbRange,
  }),
  toolCalls: arbRange,
  activeMs: arbRange,
});

// the chore is the whole turns' cost scaled down, so each of its statistics
// is at most theirs
const scale = (r: { min: number; median: number; max: number }, f: number) => ({
  min: r.min * f,
  median: r.median * f,
  max: r.max * f,
});
const arbFraction = fc.double({ min: 0, max: 1, noNaN: true });
const arbHistoryCost = fc.tuple(arbCost, arbFraction).map(([whole, f]) => ({
  chore: {
    tokens: {
      input: scale(whole.tokens.input, f),
      output: scale(whole.tokens.output, f),
      cacheRead: scale(whole.tokens.cacheRead, f),
      cacheWrite: scale(whole.tokens.cacheWrite, f),
    },
    toolCalls: scale(whole.toolCalls, f),
    activeMs: scale(whole.activeMs, f),
  },
  wholeTurns: whole,
}));
const arbUsdRanges = fc.tuple(arbRange, arbFraction).map(([whole, f]) => ({
  chore: scale(whole, f),
  wholeTurns: whole,
}));

const arbRef = fc.record({ harness: arbSlug, sessionId: arbSessionId });

const arbKindFields = fc.oneof(
  fc.constant({ kind: "prompt-repeat", invocation: "interactive" }),
  fc.constant({ kind: "headless-job", invocation: "headless" }),
  fc.record({
    kind: fc.constant("call-sequence"),
    invocation: fc.constantFrom("interactive", "headless"),
    steps: fc.array(arbText(40), { minLength: L.minSteps, maxLength: L.steps }),
  }),
  fc.record({
    kind: fc.constant("covered-cli"),
    invocation: fc.constantFrom("interactive", "headless"),
    program: arbText(20),
  }),
);

const arbCandidate = fc.record({
  kindFields: arbKindFields,
  label: arbText(60),
  score: arbAmount,
  counts: fc.array(fc.integer({ min: 1, max: 1_000_000 }), {
    minLength: 3,
    maxLength: 3,
  }),
  seen: arbOrderedDates(2),
  perOccurrence: arbCost,
  weightedTokens: arbRange,
  failureRate: fc.double({ min: 0, max: 1, noNaN: true }),
  refs: fc.array(arbRef, { maxLength: 6 }),
  excerpts: fc.array(
    fc.record({
      source: fc.constantFrom("prompt", "call"),
      session: arbRef,
      text: arbText(80),
      truncated: fc.option(fc.constant(true as const), { nil: undefined }),
    }, { requiredKeys: ["source", "session", "text"] }),
    { maxLength: L.excerpts },
  ),
}).map((c) => {
  const [directories, sessions, occurrences] = [...c.counts].sort((a, b) =>
    a - b
  );
  return {
    id: "",
    ...c.kindFields,
    label: c.label,
    score: c.score,
    rank: 0,
    occurrences,
    sessions: Math.max(sessions, c.refs.length),
    directories,
    firstSeen: c.seen[0],
    lastSeen: c.seen[1],
    perOccurrence: { ...c.perOccurrence, weightedTokens: c.weightedTokens },
    failureRate: c.failureRate,
    sessionRefs: c.refs,
    excerpts: c.excerpts,
  };
}).filter((c) => c.occurrences >= c.sessions);

const arbCandidateSet = fc.record({
  generatedAt: arbIso,
  importerVersion: arbText(30),
  window: arbOrderedDates(2),
  harnesses: fc.uniqueArray(arbSlug, { minLength: 1, maxLength: L.harnesses }),
  all: fc.boolean(),
  include: fc.array(arbText(60), { maxLength: 4 }),
  exclude: fc.array(arbText(60), { maxLength: 4 }),
  candidates: fc.array(arbCandidate, { maxLength: 6 }),
  ids: fc.uniqueArray(arbHex32, { minLength: 6, maxLength: 6 }),
}).map((s) => ({
  schemaVersion: 2,
  generatedAt: s.generatedAt,
  importerVersion: s.importerVersion,
  window: { since: s.window[0], until: s.window[1] },
  scope: {
    harnesses: s.harnesses,
    all: s.all,
    include: s.all ? [] : s.include,
    exclude: s.exclude,
  },
  candidates: s.candidates.map((c, i) => ({ ...c, id: s.ids[i], rank: i + 1 })),
}));

const arbTarget = fc.record({
  kind: fc.constantFrom("behavior", "workflow"),
  name: arbText(60),
});

// candidate ids are unique across options and considered; a merged
// candidate folds into the first offered one
const arbOffer = fc.record({
  sizes: fc.array(fc.integer({ min: 1, max: 3 }), {
    minLength: 1,
    maxLength: L.options,
  }),
  considered: fc.array(
    fc.constantFrom("not-a-chore", "merged", "low-value"),
    { maxLength: 5 },
  ),
  ids: fc.uniqueArray(arbHex32, { minLength: 20, maxLength: 20 }),
  optionIds: fc.uniqueArray(arbHex16, {
    minLength: L.options,
    maxLength: L.options,
  }),
  options: fc.array(
    fc.record({
      name: arbText(60),
      why: arbText(80),
      becomes: fc.constantFrom("behavior", "workflow"),
      registryType: fc.option(arbText(40), { nil: undefined }),
      outline: fc.option(
        fc.array(arbText(40), { minLength: 1, maxLength: 8 }),
        {
          nil: undefined,
        },
      ),
    }, { requiredKeys: ["name", "why", "becomes"] }),
    { minLength: L.options, maxLength: L.options },
  ),
  dates: arbOrderedDates(5),
  writerVersion: arbText(30),
  harness: fc.constantFrom("claude-code", "codex"),
  model: fc.stringMatching(/^[a-z0-9.:-]{1,40}$/),
  sessions: arbCount,
  state: fc.constantFrom("offered", "picked", "built", "declined"),
  pick: fc.nat(),
  target: arbTarget,
}).map((o) => {
  const [generatedAt, createdAt, pickedAt, builtAt, updatedAt] = o.dates;
  let next = 0;
  const options = o.sizes.map((size, i) => ({
    id: o.optionIds[i],
    ...o.options[i],
    candidateIds: o.ids.slice(next, next += size),
  }));
  const considered = o.considered.map((reason) => ({
    candidateId: o.ids[next++],
    reason,
    ...(reason === "merged" ? { into: options[0].candidateIds[0] } : {}),
  }));
  const optionId = options[o.pick % options.length].id;
  const state = o.state === "offered"
    ? { kind: "offered" }
    : o.state === "picked"
    ? { kind: "picked", optionId, pickedAt }
    : o.state === "built"
    ? { kind: "built", optionId, pickedAt, target: o.target, builtAt }
    : { kind: "declined", declinedAt: pickedAt };
  return {
    schemaVersion: 1,
    createdAt,
    updatedAt,
    writerVersion: o.writerVersion,
    candidateSet: { generatedAt },
    reading: {
      harness: o.harness,
      model: o.model,
      candidates: next,
      sessions: o.sessions,
    },
    options,
    considered,
    state,
  };
});

const arbTokens = fc.record({
  input: arbCount,
  output: arbCount,
  cacheRead: arbCount,
  cacheWrite: arbCount,
});

const arbSide = arbCount.chain((occurrences) =>
  occurrences > 0
    ? fc.record({
      occurrences: fc.constant(occurrences),
      perOccurrence: arbCost,
    })
    : fc.constant({ occurrences })
);

const arbBreakEven = fc.option(
  fc.tuple(arbCount, fc.option(arbCount, { nil: null })),
  { nil: null },
).map((pair) => {
  if (pair === null) return { low: null, high: null };
  const [low, extra] = pair;
  return { low, high: extra === null ? null : low + extra };
});

const arbComparison = fc.record({
  generatedAt: arbIso,
  importerVersion: arbText(30),
  optionId: arbHex16,
  candidateIds: fc.uniqueArray(arbHex32, {
    minLength: 1,
    maxLength: L.candidatesPerOption,
  }),
  target: arbTarget,
  build: fc.record({ tokens: arbTokens, activeMs: arbAmount }),
  history: arbCount.chain((occurrences) =>
    occurrences > 0
      ? fc.record({
        occurrences: fc.constant(occurrences),
        perOccurrence: arbHistoryCost,
      })
      : fc.constant({ occurrences })
  ),
  swampRun: fc.record({
    wallMs: arbAmount,
    tokens: arbTokens,
    outcome: fc.constantFrom("succeeded", "failed"),
  }),
  forward: fc.record({ since: arbIso, raw: arbSide, swamp: arbSide }),
  breakEven: arbBreakEven,
  usd: fc.option(
    fc.record({
      build: arbAmount,
      historyPerOccurrence: arbUsdRanges,
      swampRun: arbAmount,
    }, { requiredKeys: [] }),
    { nil: undefined },
  ),
}).map(({ usd, ...c }) => {
  const estimate = usd !== undefined && c.history.occurrences === 0
    ? (({ historyPerOccurrence: _, ...rest }) => rest)(usd)
    : usd;
  return {
    schemaVersion: 2,
    ...c,
    ...(estimate === undefined ? {} : { estimatedUsd: estimate }),
  };
});

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

Deno.test("swampify property: every item round-trips through JSON and its reader", () => {
  const items = [
    [arbCandidateSet, readSwampifyCandidateSet],
    [arbOffer, readSwampifyOffer],
    [arbComparison, readSwampifyComparison],
  ] as const;
  for (const [arb, read] of items) {
    fc.assert(
      fc.property(arb as fc.Arbitrary<unknown>, (item) => {
        const reading = read(json(item));
        assertEquals(reading.kind, "record", JSON.stringify(reading));
        if (reading.kind === "record") {
          assertEquals<unknown>(reading.record, json(item));
        }
      }),
    );
  }
});

Deno.test("swampify property: summary tags fit the cap and read back as the derived summary", () => {
  fc.assert(
    fc.property(arbCandidateSet, (set) => {
      const read = readSwampifyCandidateSet(json(set));
      assert(read.kind === "record");
      const tag = swampifyCandidateSetTags(read.record).summary;
      assert(tag.length <= L.summaryTagLength);
      assertEquals(
        readSwampifyCandidateSetSummary(tag),
        swampifyCandidateSetSummary(read.record),
      );
    }),
  );
  fc.assert(
    fc.property(arbOffer, (offer) => {
      const read = readSwampifyOffer(json(offer));
      assert(read.kind === "record");
      const tag = swampifyOfferTags(read.record).summary;
      assert(tag.length <= L.summaryTagLength);
      assertEquals(
        readSwampifyOfferSummary(tag),
        swampifyOfferSummary(read.record),
      );
    }),
  );
  fc.assert(
    fc.property(arbComparison, (comparison) => {
      const read = readSwampifyComparison(json(comparison));
      assert(read.kind === "record");
      const tag = swampifyComparisonTags(read.record).summary;
      assert(tag.length <= L.summaryTagLength);
      assertEquals(
        readSwampifyComparisonSummary(tag),
        swampifyComparisonSummary(read.record),
      );
    }),
  );
});

type Json = Record<string, unknown>;

const SET_OVER_BOUNDS: ReadonlyArray<readonly [string, (set: Json) => void]> = [
  ["candidates", (s) => {
    const list = s.candidates as Json[];
    s.candidates = Array.from({ length: L.candidates + 1 }, (_, i) => ({
      ...list[0],
      id: i.toString(16).padStart(32, "0"),
      rank: i + 1,
    }));
  }],
  ["sessionRefs", (s) => {
    const c = (s.candidates as Json[])[0];
    c.sessions = c.occurrences = L.sessionRefs + 1;
    c.sessionRefs = Array.from(
      { length: L.sessionRefs + 1 },
      (_, i) => ({ harness: "codex", sessionId: `s${i}` }),
    );
  }],
  ["excerpts", (s) => {
    (s.candidates as Json[])[0].excerpts = Array.from(
      { length: L.excerpts + 1 },
      () => ({
        source: "prompt",
        session: { harness: "codex", sessionId: "s" },
        text: "x",
      }),
    );
  }],
  ["excerpt text", (s) => {
    (s.candidates as Json[])[0].excerpts = [{
      source: "prompt",
      session: { harness: "codex", sessionId: "s" },
      text: "x".repeat(L.excerptLength + 1),
    }];
  }],
  ["steps", (s) => {
    const c = (s.candidates as Json[])[0];
    c.kind = "call-sequence";
    delete c.program;
    c.steps = Array.from({ length: L.steps + 1 }, () => "x");
  }],
  ["step text", (s) => {
    const c = (s.candidates as Json[])[0];
    c.kind = "call-sequence";
    delete c.program;
    c.steps = ["x", "x".repeat(L.stepLength + 1)];
  }],
  ["label", (s) => {
    (s.candidates as Json[])[0].label = "x".repeat(L.labelLength + 1);
  }],
  ["program", (s) => {
    const c = (s.candidates as Json[])[0];
    c.kind = "covered-cli";
    delete c.steps;
    c.program = "x".repeat(L.programLength + 1);
  }],
  ["harnesses", (s) => {
    (s.scope as Json).harnesses = Array.from(
      { length: L.harnesses + 1 },
      (_, i) => `h${i}`,
    );
  }],
  ["scope paths", (s) => {
    (s.scope as Json).exclude = Array.from(
      { length: L.scopePaths + 1 },
      () => "~/x",
    );
  }],
  ["path length", (s) => {
    (s.scope as Json).exclude = ["x".repeat(L.pathLength + 1)];
  }],
  ["importerVersion", (s) => {
    s.importerVersion = "x".repeat(L.nameLength + 1);
  }],
];

const OFFER_OVER_BOUNDS: ReadonlyArray<
  readonly [string, (offer: Json) => void]
> = [
  ["options", (o) => {
    const first = (o.options as Json[])[0];
    o.options = Array.from({ length: L.options + 1 }, () => first);
  }],
  ["considered", (o) => {
    o.considered = Array.from({ length: L.candidates + 1 }, (_, i) => ({
      candidateId: i.toString(16).padStart(32, "f"),
      reason: "low-value",
    }));
  }],
  ["candidateIds", (o) => {
    (o.options as Json[])[0].candidateIds = Array.from(
      { length: L.candidatesPerOption + 1 },
      (_, i) => i.toString(16).padStart(32, "e"),
    );
  }],
  ["outline", (o) => {
    (o.options as Json[])[0].outline = Array.from(
      { length: L.steps + 1 },
      () => "x",
    );
  }],
  ["outline step", (o) => {
    (o.options as Json[])[0].outline = ["x".repeat(L.stepLength + 1)];
  }],
  ["name", (o) => {
    (o.options as Json[])[0].name = "x".repeat(L.labelLength + 1);
  }],
  ["why", (o) => {
    (o.options as Json[])[0].why = "x".repeat(L.whyLength + 1);
  }],
  ["registryType", (o) => {
    (o.options as Json[])[0].registryType = "x".repeat(L.nameLength + 1);
  }],
  ["model", (o) => {
    (o.reading as Json).model = "x".repeat(L.nameLength + 1);
  }],
  ["reading.candidates", (o) => {
    (o.reading as Json).candidates = L.candidates + 1;
  }],
  ["writerVersion", (o) => {
    o.writerVersion = "x".repeat(L.nameLength + 1);
  }],
];

const COMPARISON_OVER_BOUNDS: ReadonlyArray<
  readonly [string, (comparison: Json) => void]
> = [
  ["candidateIds", (c) => {
    c.candidateIds = Array.from(
      { length: L.candidatesPerOption + 1 },
      (_, i) => i.toString(16).padStart(32, "0"),
    );
  }],
  ["target name", (c) => {
    (c.target as Json).name = "x".repeat(L.nameLength + 1);
  }],
];

function assertOverBoundsRefused<T>(
  arb: fc.Arbitrary<T>,
  bounds: ReadonlyArray<readonly [string, (item: Json) => void]>,
  read: (content: unknown) => { kind: string; reason?: string },
): void {
  for (const [name, push] of bounds) {
    fc.assert(
      fc.property(arb, (item) => {
        const copy = json(item) as Json;
        push(copy);
        const reading = read(copy);
        assert(
          reading.kind === "skipped" && reading.reason === "invalid",
          `${name}: ${JSON.stringify(reading).slice(0, 200)}`,
        );
      }),
      { numRuns: 20 },
    );
  }
}

Deno.test("swampify property: one past any bound is refused as invalid", () => {
  assertOverBoundsRefused(
    arbCandidateSet.filter((s) => s.candidates.length > 0),
    SET_OVER_BOUNDS,
    readSwampifyCandidateSet,
  );
  assertOverBoundsRefused(arbOffer, OFFER_OVER_BOUNDS, readSwampifyOffer);
  assertOverBoundsRefused(
    arbComparison,
    COMPARISON_OVER_BOUNDS,
    readSwampifyComparison,
  );
});

Deno.test("swampify property: readers never throw on arbitrary JSON", () => {
  const readers = [
    readSwampifyCandidateSet,
    readSwampifyOffer,
    readSwampifyComparison,
    readSwampifyCandidateSetSummary,
    readSwampifyOfferSummary,
    readSwampifyComparisonSummary,
  ];
  const arbContent = fc.oneof(
    fc.jsonValue(),
    fc.jsonValue().map((v) => JSON.stringify(v)),
    fc.dictionary(fc.string(), fc.jsonValue()).map((d) => ({
      ...d,
      schemaVersion: 1,
    })),
    fc.dictionary(fc.string(), fc.jsonValue()).map((d) => ({
      ...d,
      schemaVersion: 2,
    })),
  );
  fc.assert(
    fc.property(arbContent, (content) => {
      for (const read of readers) read(content);
    }),
  );
});

// the longest a summary can be: every name at its cap, written with a
// character JSON escapes to six, and the largest counts
Deno.test("swampify property: a summary at every cap still fits the tag", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const wide = "\u0001".repeat(L.nameLength);
  const target = { kind: "workflow", name: wide };
  const r0 = { min: 0, median: 0, max: 0 };
  const zero = {
    tokens: { input: r0, output: r0, cacheRead: r0, cacheWrite: r0 },
    toolCalls: r0,
    activeMs: r0,
  };
  const comparison = readSwampifyComparison({
    schemaVersion: 2,
    generatedAt: "2026-10-30T10:00:00.000Z",
    importerVersion: "test",
    optionId: "0".repeat(16),
    candidateIds: ["0".repeat(32)],
    target,
    build: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      activeMs: 0,
    },
    history: {
      occurrences: max,
      perOccurrence: { chore: zero, wholeTurns: zero },
    },
    swampRun: {
      wallMs: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      outcome: "succeeded",
    },
    forward: {
      since: "2026-10-30T10:00:00.000Z",
      raw: { occurrences: 0 },
      swamp: { occurrences: 0 },
    },
    breakEven: { low: max, high: max },
  });
  assert(comparison.kind === "record", JSON.stringify(comparison));
  const ctag = swampifyComparisonTags(comparison.record).summary;
  assert(ctag.length <= L.summaryTagLength);
  assert(readSwampifyComparisonSummary(ctag) !== undefined);

  const set = readSwampifyCandidateSet({
    schemaVersion: 2,
    generatedAt: "2026-10-30T10:00:00.000Z",
    importerVersion: "test",
    window: {
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-10-30T00:00:00.000Z",
    },
    scope: {
      harnesses: Array.from(
        { length: L.harnesses },
        (_, i) => `${i}`.padEnd(L.harnessLength, "a"),
      ),
      all: true,
      include: [],
      exclude: [],
    },
    candidates: [],
  });
  assert(set.kind === "record", JSON.stringify(set));
  const tag = swampifyCandidateSetTags(set.record).summary;
  assert(tag.length <= L.summaryTagLength);
  assert(readSwampifyCandidateSetSummary(tag) !== undefined);

  const otag = JSON.stringify({
    state: "built",
    options: L.options,
    pickedOptionId: "0".repeat(16),
    target,
  });
  assert(otag.length <= L.summaryTagLength);
  assert(readSwampifyOfferSummary(otag) !== undefined);
});
