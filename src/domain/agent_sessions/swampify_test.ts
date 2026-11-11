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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  newestSwampifyItem,
  readSwampifyCandidateSet,
  readSwampifyCandidateSetSummary,
  readSwampifyComparison,
  readSwampifyComparisonSummary,
  readSwampifyOffer,
  readSwampifyOfferSummary,
  SWAMPIFY_COMPARISON_QUERY_PREDICATE,
  SWAMPIFY_GENERATED_AT_TAG,
  SWAMPIFY_LIMITS,
  SWAMPIFY_LIST_SELECT,
  SWAMPIFY_SUMMARY_TAG,
  SWAMPIFY_UPDATED_AT_TAG,
  swampifyCandidateId,
  type SwampifyCandidateSet,
  swampifyCandidateSetSummary,
  swampifyCandidateSetTags,
  type SwampifyComparison,
  swampifyComparisonDataName,
  swampifyComparisonPredicate,
  swampifyComparisonTags,
  type SwampifyOffer,
  swampifyOfferSummary,
  swampifyOfferTags,
  swampifyOptionId,
  swampifyWeightedTokens,
} from "./swampify.ts";

// synthetic fixtures only: no text from a real transcript
const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";
const ID_C = "00000000000000000000000000000000";
const OPT_A = "0123456789abcdef";
const OPT_B = "fedcba9876543210";
const SECRET = "hunter2-do-not-echo";

const range = (min = 1, median = 2, max = 3) => ({ min, median, max });
const tokenRanges = () => ({
  input: range(),
  output: range(),
  cacheRead: range(),
  cacheWrite: range(),
});
const cost = () => ({
  tokens: tokenRanges(),
  toolCalls: range(),
  activeMs: range(100, 200, 300),
});

function candidate(extra: Record<string, unknown> = {}) {
  return {
    id: ID_A,
    kind: "prompt-repeat",
    invocation: "interactive",
    label: "Ship the release notes",
    score: 1234.5,
    rank: 1,
    occurrences: 4,
    sessions: 3,
    directories: 2,
    firstSeen: "2026-10-01T09:00:00.000Z",
    lastSeen: "2026-10-20T09:00:00.000Z",
    perOccurrence: { ...cost(), weightedTokens: range(3.1, 4.2, 5.3) },
    failureRate: 0.25,
    sessionRefs: [{ harness: "claude-code", sessionId: "s1" }],
    excerpts: [{
      source: "prompt",
      session: { harness: "claude-code", sessionId: "s1" },
      text: "ship the release notes for demo",
    }],
    ...extra,
  };
}

function candidateSet(
  candidates: unknown[] = [candidate()],
  extra: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 2,
    generatedAt: "2026-10-30T10:00:00.000Z",
    importerVersion: "test",
    window: {
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-10-30T00:00:00.000Z",
    },
    scope: {
      harnesses: ["claude-code", "codex"],
      all: true,
      include: [],
      exclude: ["~/src/client"],
    },
    candidates,
    ...extra,
  };
}

function option(extra: Record<string, unknown> = {}) {
  return {
    id: OPT_A,
    name: "Release notes",
    why: "You ask for this every release",
    becomes: "workflow",
    outline: ["collect merged PRs", "draft notes"],
    candidateIds: [ID_A],
    ...extra,
  };
}

function offer(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    createdAt: "2026-10-30T11:00:00.000Z",
    updatedAt: "2026-10-30T12:00:00.000Z",
    writerVersion: "test",
    candidateSet: { generatedAt: "2026-10-30T10:00:00.000Z" },
    reading: {
      harness: "claude-code",
      model: "claude-haiku-5-5",
      candidates: 2,
      sessions: 9,
    },
    options: [option()],
    considered: [{ candidateId: ID_B, reason: "low-value" }],
    state: { kind: "offered" },
    ...extra,
  };
}

const tokens = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 };

function comparison(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    generatedAt: "2026-10-30T10:00:00.000Z",
    importerVersion: "test",
    optionId: OPT_A,
    candidateIds: [ID_A],
    target: { kind: "workflow", name: "release-notes" },
    build: { tokens, activeMs: 60000 },
    history: {
      occurrences: 4,
      perOccurrence: { chore: cost(), wholeTurns: cost() },
    },
    swampRun: { wallMs: 1200, tokens, outcome: "succeeded" },
    forward: {
      since: "2026-10-30T10:00:00.000Z",
      raw: { occurrences: 0 },
      swamp: { occurrences: 1, perOccurrence: cost() },
    },
    breakEven: { low: 2, high: 5 },
    ...extra,
  };
}

const readers = {
  "candidate set": {
    read: readSwampifyCandidateSet,
    valid: (extra: Record<string, unknown> = {}) =>
      candidateSet([candidate()], extra),
  },
  offer: { read: readSwampifyOffer, valid: offer },
  comparison: { read: readSwampifyComparison, valid: comparison },
} as const;

function noteOf(reading: { kind: string; note?: string }): string {
  assertEquals(reading.kind, "skipped");
  return reading.note ?? "";
}

for (const [label, { read, valid }] of Object.entries(readers)) {
  Deno.test(`swampify ${label} reader: reads a valid item`, () => {
    assertEquals(read(valid()).kind, "record");
  });

  Deno.test(`swampify ${label} reader: no integer schemaVersion is invalid`, () => {
    for (const content of [null, [], "x", {}, { schemaVersion: 1.5 }, 0]) {
      const reading = read(content);
      assertEquals(reading.kind === "skipped" && reading.reason, "invalid");
    }
  });

  Deno.test(`swampify ${label} reader: a newer version is skipped as newer`, () => {
    const current = valid().schemaVersion;
    const reading = read(valid({ schemaVersion: current + 1 }));
    assertEquals(reading.kind === "skipped" && reading.reason, "newer");
    assertEquals(
      reading.kind === "skipped" && reading.schemaVersion,
      current + 1,
    );
  });

  Deno.test(`swampify ${label} reader: a wrong field is invalid and the note names the path, not the value`, () => {
    const note = noteOf(
      read({ ...valid(), importerVersion: 7, extra: SECRET }),
    );
    assert(!note.includes(SECRET));
    assertStringIncludes(note, "does not match version");
  });
}

Deno.test("readSwampifyCandidateSet: v1 is older and says to rerun", () => {
  const reading = readSwampifyCandidateSet(
    candidateSet([], { schemaVersion: 1 }),
  );
  assertEquals(reading.kind === "skipped" && reading.reason, "older");
  assertStringIncludes(noteOf(reading), "Run the assessment again.");
});

Deno.test("readSwampifyComparison: v1 is older", () => {
  const reading = readSwampifyComparison(comparison({ schemaVersion: 1 }));
  assertEquals(reading.kind === "skipped" && reading.reason, "older");
});

Deno.test("readSwampifyCandidateSet: oversized lists are refused by count, naming the path", () => {
  const many = (n: number) => Array.from({ length: n }, () => ({}));
  const cases: Array<[unknown, string]> = [
    [candidateSet(many(SWAMPIFY_LIMITS.candidates + 1)), "candidates"],
    [
      candidateSet([candidate({
        excerpts: many(SWAMPIFY_LIMITS.excerpts + 1),
      })]),
      "candidates.0.excerpts",
    ],
    [
      candidateSet([], {
        scope: { harnesses: [], all: true, include: [], exclude: many(1001) },
      }),
      "scope.exclude",
    ],
  ];
  for (const [content, path] of cases) {
    assertEquals(
      noteOf(readSwampifyCandidateSet(content)),
      `does not match version 2: too_big at ${path}`,
    );
  }
});

Deno.test("readSwampifyOffer: oversized lists are refused by count, naming the path", () => {
  const many = (n: number) => Array.from({ length: n }, () => "x");
  const cases: Array<[unknown, string]> = [
    [offer({ options: many(SWAMPIFY_LIMITS.options + 1) }), "options"],
    [offer({ considered: many(SWAMPIFY_LIMITS.candidates + 1) }), "considered"],
    [
      offer({
        options: [option({ outline: many(SWAMPIFY_LIMITS.steps + 1) })],
      }),
      "options.0.outline",
    ],
    [
      offer({
        options: [option({
          candidateIds: many(SWAMPIFY_LIMITS.candidatesPerOption + 1),
        })],
      }),
      "options.0.candidateIds",
    ],
  ];
  for (const [content, path] of cases) {
    assertEquals(
      noteOf(readSwampifyOffer(content)),
      `does not match version 1: too_big at ${path}`,
    );
  }
});

Deno.test("readSwampifyComparison: oversized candidateIds are refused by count", () => {
  const ids = Array.from(
    { length: SWAMPIFY_LIMITS.candidatesPerOption + 1 },
    () => ID_A,
  );
  assertEquals(
    noteOf(readSwampifyComparison(comparison({ candidateIds: ids }))),
    "does not match version 2: too_big at candidateIds",
  );
});

function setInvalidAt(content: unknown): string {
  return noteOf(readSwampifyCandidateSet(content)).split(" at ")[1];
}

Deno.test("SwampifyCandidateSetV2Schema: rank must be the position", () => {
  const second = candidate({ id: ID_B, rank: 3 });
  assertEquals(
    setInvalidAt(candidateSet([candidate(), second])),
    "candidates.1.rank",
  );
  assertEquals(
    readSwampifyCandidateSet(candidateSet([candidate(), {
      ...second,
      rank: 2,
    }])).kind,
    "record",
  );
});

Deno.test("SwampifyCandidateSetV2Schema: a candidate needs weightedTokens, score and rank", () => {
  for (const key of ["score", "rank"]) {
    const c: Record<string, unknown> = candidate();
    delete c[key];
    assertEquals(setInvalidAt(candidateSet([c])), `candidates.0.${key}`);
  }
  assertEquals(
    setInvalidAt(candidateSet([candidate({ perOccurrence: cost() })])),
    "candidates.0.perOccurrence.weightedTokens",
  );
  assertEquals(
    setInvalidAt(candidateSet([candidate({ score: -1 })])),
    "candidates.0.score",
  );
});

Deno.test("SwampifyCandidateSchema: cross-field rules each refuse at their path", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ steps: ["a", "b"] }, "steps"],
    [{ kind: "call-sequence", invocation: "headless" }, "steps"],
    [{ program: "make" }, "program"],
    [{ kind: "covered-cli" }, "program"],
    [{ invocation: "headless" }, "invocation"],
    [{ sessions: 5 }, "sessions"],
    [{
      sessions: 1,
      occurrences: 1,
      sessionRefs: [
        { harness: "claude-code", sessionId: "s1" },
        { harness: "claude-code", sessionId: "s2" },
      ],
    }, "sessionRefs"],
    [{ firstSeen: "2026-10-21T00:00:00.000Z" }, "lastSeen"],
    [{
      perOccurrence: { ...cost(), weightedTokens: range(3, 2, 4) },
    }, "perOccurrence.weightedTokens.median"],
  ];
  for (const [extra, path] of cases) {
    assertEquals(
      setInvalidAt(candidateSet([candidate(extra)])),
      `candidates.0.${path}`,
    );
  }
});

Deno.test("SwampifyCandidateSetV2Schema: set rules refuse duplicates, a backwards window and include with all", () => {
  assertEquals(
    setInvalidAt(candidateSet([candidate(), candidate({ rank: 2 })])),
    "candidates.1.id",
  );
  assertEquals(
    setInvalidAt(candidateSet([], {
      window: {
        since: "2026-10-30T00:00:00.000Z",
        until: "2026-10-01T00:00:00.000Z",
      },
    })),
    "window.until",
  );
  assertEquals(
    setInvalidAt(candidateSet([], {
      scope: { harnesses: ["codex"], all: true, include: ["~/a"], exclude: [] },
    })),
    "scope.include",
  );
  assertEquals(
    setInvalidAt(candidateSet([], {
      scope: {
        harnesses: ["codex", "codex"],
        all: true,
        include: [],
        exclude: [],
      },
    })),
    "scope.harnesses",
  );
});

function offerInvalidAt(content: unknown): string {
  return noteOf(readSwampifyOffer(content)).split(" at ")[1];
}

Deno.test("SwampifyOfferV1Schema: option ids are unique", () => {
  assertEquals(
    offerInvalidAt(offer({
      options: [option(), option({ candidateIds: [ID_C] })],
      reading: { ...offer().reading, candidates: 3 },
    })),
    "options.1.id",
  );
});

Deno.test("SwampifyOfferV1Schema: a candidate appears once across options and considered", () => {
  assertEquals(
    offerInvalidAt(offer({
      options: [option(), option({ id: OPT_B })],
      reading: { ...offer().reading, candidates: 2 },
    })),
    "options.1.candidateIds.0",
  );
  assertEquals(
    offerInvalidAt(offer({
      considered: [{ candidateId: ID_A, reason: "not-a-chore" }],
      reading: { ...offer().reading, candidates: 1 },
    })),
    "considered.0.candidateId",
  );
});

Deno.test("SwampifyOfferV1Schema: merged needs into, naming another candidate in the offer", () => {
  const read = { ...offer().reading, candidates: 2 };
  assertEquals(
    offerInvalidAt(offer({
      considered: [{ candidateId: ID_B, reason: "merged" }],
    })),
    "considered.0.into",
  );
  assertEquals(
    offerInvalidAt(offer({
      considered: [{ candidateId: ID_B, reason: "low-value", into: ID_A }],
    })),
    "considered.0.into",
  );
  assertEquals(
    offerInvalidAt(offer({
      considered: [{ candidateId: ID_B, reason: "merged", into: ID_B }],
    })),
    "considered.0.into",
  );
  assertEquals(
    offerInvalidAt(offer({
      considered: [{ candidateId: ID_B, reason: "merged", into: ID_C }],
    })),
    "considered.0.into",
  );
  assertEquals(
    readSwampifyOffer(offer({
      reading: read,
      considered: [{ candidateId: ID_B, reason: "merged", into: ID_A }],
    })).kind,
    "record",
  );
});

Deno.test("SwampifyOfferV1Schema: offered and considered add up to the candidates read", () => {
  assertEquals(
    offerInvalidAt(offer({ reading: { ...offer().reading, candidates: 3 } })),
    "reading.candidates",
  );
});

Deno.test("SwampifyOfferV1Schema: picked and built name an option the offer holds", () => {
  const pickedAt = "2026-10-30T11:30:00.000Z";
  for (
    const state of [
      { kind: "picked", optionId: OPT_B, pickedAt },
      {
        kind: "built",
        optionId: OPT_B,
        pickedAt,
        target: { kind: "workflow", name: "release-notes" },
        builtAt: "2026-10-30T11:45:00.000Z",
      },
    ]
  ) {
    assertEquals(offerInvalidAt(offer({ state })), "state.optionId");
    assertEquals(
      readSwampifyOffer(offer({ state: { ...state, optionId: OPT_A } })).kind,
      "record",
    );
  }
});

Deno.test("SwampifyOfferV1Schema: built carries the pick, so built implies picked", () => {
  assertEquals(
    offerInvalidAt(offer({
      state: {
        kind: "built",
        target: { kind: "behavior", name: "notes" },
        builtAt: "2026-10-30T11:45:00.000Z",
      },
    })).startsWith("state."),
    true,
  );
});

Deno.test("SwampifyOfferV1Schema: timestamps run in order", () => {
  const target = { kind: "behavior", name: "notes" };
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      { candidateSet: { generatedAt: "2026-10-30T11:30:00.000Z" } },
      "createdAt",
    ],
    [{ updatedAt: "2026-10-30T10:30:00.000Z" }, "updatedAt"],
    [{
      state: {
        kind: "picked",
        optionId: OPT_A,
        pickedAt: "2026-10-30T10:30:00.000Z",
      },
    }, "state.pickedAt"],
    [{
      state: {
        kind: "picked",
        optionId: OPT_A,
        pickedAt: "2026-10-30T13:00:00.000Z",
      },
    }, "state.pickedAt"],
    [{
      state: {
        kind: "built",
        optionId: OPT_A,
        pickedAt: "2026-10-30T11:50:00.000Z",
        target,
        builtAt: "2026-10-30T11:40:00.000Z",
      },
    }, "state.builtAt"],
    [{
      state: { kind: "declined", declinedAt: "2026-10-30T13:00:00.000Z" },
    }, "state.declinedAt"],
  ];
  for (const [extra, path] of cases) {
    assertEquals(offerInvalidAt(offer(extra)), path);
  }
});

Deno.test("SwampifyOfferV1Schema: reading names a known harness and a model without whitespace", () => {
  assertEquals(
    offerInvalidAt(offer({
      reading: { ...offer().reading, harness: "opencode" },
    })),
    "reading.harness",
  );
  assertEquals(
    offerInvalidAt(offer({
      reading: { ...offer().reading, model: "claude haiku" },
    })),
    "reading.model",
  );
});

function comparisonInvalidAt(content: unknown): string {
  return noteOf(readSwampifyComparison(content)).split(" at ")[1];
}

Deno.test("SwampifyComparisonV2Schema: cross-field rules each refuse at their path", () => {
  const whole = cost();
  const chore = { ...cost(), toolCalls: range(5, 6, 7) };
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ candidateIds: [ID_A, ID_A] }, "candidateIds.1"],
    [{ candidateId: ID_A }, "the record"],
    [{
      history: {
        occurrences: 0,
        perOccurrence: { chore: whole, wholeTurns: whole },
      },
    }, "history.perOccurrence"],
    [{
      forward: {
        since: "2026-10-30T10:00:00.000Z",
        raw: { occurrences: 2 },
        swamp: { occurrences: 0 },
      },
    }, "forward.raw.perOccurrence"],
    [{
      history: { occurrences: 4, perOccurrence: { chore, wholeTurns: whole } },
    }, "history.perOccurrence.chore.toolCalls"],
    [{ breakEven: { low: 5, high: 2 } }, "breakEven.high"],
    [{ breakEven: { low: null, high: 2 } }, "breakEven.high"],
    [{
      estimatedUsd: {
        historyPerOccurrence: {
          chore: range(2, 3, 4),
          wholeTurns: range(1, 2, 3),
        },
      },
    }, "estimatedUsd.historyPerOccurrence.chore"],
    [{
      history: { occurrences: 0 },
      estimatedUsd: {
        historyPerOccurrence: { chore: range(), wholeTurns: range() },
      },
    }, "estimatedUsd.historyPerOccurrence"],
  ];
  for (const [extra, path] of cases) {
    assertEquals(comparisonInvalidAt(comparison(extra)), path);
  }
});

Deno.test("swampifyCandidateSetSummary: thin below three candidates, and the tag reads back", () => {
  const set = readSwampifyCandidateSet(candidateSet()).kind === "record"
    ? (readSwampifyCandidateSet(candidateSet()) as {
      record: SwampifyCandidateSet;
    }).record
    : undefined;
  assert(set);
  const summary = swampifyCandidateSetSummary(set);
  assertEquals(summary.thin, true);
  const tags = swampifyCandidateSetTags(set);
  assertEquals(
    readSwampifyCandidateSetSummary(tags[SWAMPIFY_SUMMARY_TAG]),
    summary,
  );
  assertEquals(tags[SWAMPIFY_GENERATED_AT_TAG], set.generatedAt);
});

Deno.test("readSwampifyCandidateSetSummary: thin must match the count", () => {
  const summary = {
    since: "2026-10-01T00:00:00.000Z",
    until: "2026-10-30T00:00:00.000Z",
    harnesses: ["codex"],
    candidates: 3,
    thin: false,
    interactive: 3,
    headless: 0,
    kinds: {
      "prompt-repeat": 3,
      "call-sequence": 0,
      "covered-cli": 0,
      "headless-job": 0,
    },
  };
  assert(readSwampifyCandidateSetSummary(JSON.stringify(summary)));
  assertEquals(
    readSwampifyCandidateSetSummary(JSON.stringify({ ...summary, thin: true })),
    undefined,
  );
  for (
    const bad of [
      { ...summary, headless: 1 },
      { ...summary, kinds: { ...summary.kinds, "prompt-repeat": 2 } },
      { ...summary, interactive: 0, headless: 3 },
      { ...summary, harnesses: ["codex", "codex"] },
    ]
  ) {
    assertEquals(
      readSwampifyCandidateSetSummary(JSON.stringify(bad)),
      undefined,
    );
  }
});

Deno.test("swampifyOfferSummary: carries state, count, pick and target, and the tag reads back", () => {
  const built = {
    kind: "built",
    optionId: OPT_A,
    pickedAt: "2026-10-30T11:30:00.000Z",
    target: { kind: "workflow", name: "release-notes" },
    builtAt: "2026-10-30T11:45:00.000Z",
  };
  const reading = readSwampifyOffer(offer({ state: built }));
  assert(reading.kind === "record");
  const record: SwampifyOffer = reading.record;
  const tags = swampifyOfferTags(record);
  assertEquals(tags[SWAMPIFY_UPDATED_AT_TAG], record.updatedAt);
  assertEquals(readSwampifyOfferSummary(tags[SWAMPIFY_SUMMARY_TAG]), {
    state: "built",
    options: 1,
    pickedOptionId: OPT_A,
    target: { kind: "workflow", name: "release-notes" },
  });
  assertEquals(swampifyOfferSummary(record).state, "built");
});

Deno.test("readSwampifyOfferSummary: pick and target only where the state carries them", () => {
  const target = { kind: "workflow", name: "x" };
  for (
    const bad of [
      { state: "offered", options: 1, pickedOptionId: OPT_A },
      { state: "picked", options: 1 },
      { state: "picked", options: 1, pickedOptionId: OPT_A, target },
      { state: "built", options: 1, pickedOptionId: OPT_A },
      { state: "declined", options: 0 },
    ]
  ) {
    assertEquals(readSwampifyOfferSummary(JSON.stringify(bad)), undefined);
  }
  assert(
    readSwampifyOfferSummary(JSON.stringify({ state: "declined", options: 2 })),
  );
});

Deno.test("swampifyComparisonTags: carry the option id and a summary that reads back", () => {
  const reading = readSwampifyComparison(comparison());
  assert(reading.kind === "record");
  const record: SwampifyComparison = reading.record;
  const tags = swampifyComparisonTags(record);
  assertEquals(tags.optionId, OPT_A);
  assertEquals(
    readSwampifyComparisonSummary(tags[SWAMPIFY_SUMMARY_TAG])?.optionId,
    OPT_A,
  );
});

Deno.test("summary readers: never throw, and refuse oversized, non-JSON and non-string tags", () => {
  const readersOfTags = [
    readSwampifyCandidateSetSummary,
    readSwampifyOfferSummary,
    readSwampifyComparisonSummary,
  ];
  for (const read of readersOfTags) {
    for (
      const value of [
        undefined,
        42,
        "{",
        "null",
        "[]",
        " ".repeat(SWAMPIFY_LIMITS.summaryTagLength + 1),
      ]
    ) {
      assertEquals(read(value), undefined);
    }
  }
});

const row = (modelName: unknown, name: unknown, at: unknown) => ({
  name,
  modelName,
  tags: { [SWAMPIFY_GENERATED_AT_TAG]: at },
});

Deno.test("newestSwampifyItem: newest wins whatever the owner", () => {
  const rows = [
    row("swampify", "swampify-candidates", "2026-10-01T00:00:00.000Z"),
    row("other", "swampify-candidates", "2026-10-02T00:00:00.000Z"),
  ];
  assertEquals(newestSwampifyItem(rows, SWAMPIFY_GENERATED_AT_TAG), rows[1]);
});

Deno.test("newestSwampifyItem: falls back to other owners when no swampify behavior exists", () => {
  const rows = [
    row("beta", "swampify-candidates", "2026-10-01T00:00:00.000Z"),
    row("alpha", "swampify-candidates", "2026-10-01T00:00:00.000Z"),
  ];
  assertEquals(newestSwampifyItem(rows, SWAMPIFY_GENERATED_AT_TAG), rows[1]);
});

Deno.test("newestSwampifyItem: a tie goes to swampify, then modelName, then name", () => {
  const at = "2026-10-01T00:00:00.000Z";
  const rows = [
    row("alpha", "a", at),
    row("swampify", "b", at),
    row("swampify", "a", at),
  ];
  assertEquals(newestSwampifyItem(rows, SWAMPIFY_GENERATED_AT_TAG), rows[2]);
  assertEquals(
    newestSwampifyItem([...rows].reverse(), SWAMPIFY_GENERATED_AT_TAG),
    rows[2],
  );
});

Deno.test("newestSwampifyItem: compares instants, not strings", () => {
  const rows = [
    row("swampify", "a", "2026-10-01T10:00:00.000Z"),
    row("alpha", "a", "2026-10-01T09:00:00-02:00"),
  ];
  assertEquals(newestSwampifyItem(rows, SWAMPIFY_GENERATED_AT_TAG), rows[1]);
});

Deno.test("newestSwampifyItem: passes over rows it cannot open or date", () => {
  const good = row("alpha", "a", "2026-10-01T00:00:00.000Z");
  const rows = [
    row("swampify", "a", "not a date"),
    row("swampify", "a", 12),
    row(undefined, "a", "2026-11-01T00:00:00.000Z"),
    row("swampify", null, "2026-11-01T00:00:00.000Z"),
    { name: "a", modelName: "swampify", tags: null },
    good,
  ];
  assertEquals(newestSwampifyItem(rows, SWAMPIFY_GENERATED_AT_TAG), good);
  assertEquals(newestSwampifyItem([], SWAMPIFY_UPDATED_AT_TAG), undefined);
  assertEquals(newestSwampifyItem([good], SWAMPIFY_UPDATED_AT_TAG), undefined);
});

Deno.test("swampifyOptionId: stable under reordering, 16 hex digits", async () => {
  const id = await swampifyOptionId([ID_A, ID_B]);
  assertEquals(id, await swampifyOptionId([ID_B, ID_A]));
  assert(/^[0-9a-f]{16}$/.test(id));
  assert(id !== await swampifyOptionId([ID_A]));
});

Deno.test("swampifyOptionId: refuses empty, oversized, duplicate and malformed ids", async () => {
  await assertRejects(() => swampifyOptionId([]));
  await assertRejects(() =>
    swampifyOptionId(
      Array.from(
        { length: SWAMPIFY_LIMITS.candidatesPerOption + 1 },
        (_, i) => i.toString(16).padStart(32, "0"),
      ),
    )
  );
  await assertRejects(() => swampifyOptionId([ID_A, ID_A]));
  await assertRejects(() => swampifyOptionId(["ABC"]));
});

Deno.test("swampifyCandidateId: stable, 32 hex digits, and refuses bad input", async () => {
  const id = await swampifyCandidateId("prompt-repeat", "interactive", "ship");
  assertEquals(
    id,
    await swampifyCandidateId("prompt-repeat", "interactive", "ship"),
  );
  assert(/^[0-9a-f]{32}$/.test(id));
  await assertRejects(() =>
    swampifyCandidateId("prompt-repeat", "interactive", "")
  );
  await assertRejects(() =>
    swampifyCandidateId(
      "prompt-repeat",
      "interactive",
      "x".repeat(SWAMPIFY_LIMITS.keyLength + 1),
    )
  );
});

Deno.test("swampifyComparisonDataName and predicate: take an option id and nothing else", () => {
  assertEquals(
    swampifyComparisonDataName(OPT_A),
    `swampify-comparison-${OPT_A}`,
  );
  assertEquals(
    swampifyComparisonPredicate(OPT_A),
    `${SWAMPIFY_COMPARISON_QUERY_PREDICATE} && tags.optionId == "${OPT_A}"`,
  );
  for (const bad of [ID_A, "", `${OPT_A}" || true`, "../etc"]) {
    assertThrows(() => swampifyComparisonDataName(bad));
    assertThrows(() => swampifyComparisonPredicate(bad));
  }
});

Deno.test("swampifyWeightedTokens: input + output + cache writes + a tenth of cache reads", () => {
  assertEquals(
    swampifyWeightedTokens({
      input: 100,
      output: 20,
      cacheRead: 1000,
      cacheWrite: 5,
    }),
    225,
  );
});

Deno.test("SWAMPIFY_LIST_SELECT: names the owner, as the agent session list does", () => {
  assertStringIncludes(SWAMPIFY_LIST_SELECT, `"modelName": modelName`);
});
