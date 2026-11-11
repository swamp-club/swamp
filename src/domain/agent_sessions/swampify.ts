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
 * experimental: core owns these contracts and @swamp/agent-sessions copies
 * them verbatim, so this module imports nothing but zod and uses no Deno or
 * Node APIs; a new field, even an optional one, is a new version
 */

import { z } from "zod";

export const SWAMPIFY_CANDIDATE_SET_SCHEMA_VERSION = 2;

export const SUPPORTED_SWAMPIFY_CANDIDATE_SET_SCHEMA_VERSIONS:
  readonly number[] = [2];

export const SWAMPIFY_OFFER_SCHEMA_VERSION = 1;

export const SUPPORTED_SWAMPIFY_OFFER_SCHEMA_VERSIONS: readonly number[] = [1];

export const SWAMPIFY_COMPARISON_SCHEMA_VERSION = 2;

export const SUPPORTED_SWAMPIFY_COMPARISON_SCHEMA_VERSIONS: readonly number[] =
  [2];

/** writers use this behavior by convention; readers never filter on it */
export const SWAMPIFY_BEHAVIOR_NAME = "swampify";

export const SWAMPIFY_CANDIDATES_TYPE_TAG = "swampify-candidates";

export const SWAMPIFY_OFFER_TYPE_TAG = "swampify-offer";

export const SWAMPIFY_COMPARISON_TYPE_TAG = "swampify-comparison";

export const SWAMPIFY_CANDIDATES_DATA_NAME = "swampify-candidates";

export const SWAMPIFY_OFFER_DATA_NAME = "swampify-offer";

export const SWAMPIFY_GENERATED_AT_TAG = "generatedAt";

export const SWAMPIFY_UPDATED_AT_TAG = "updatedAt";

export const SWAMPIFY_SUMMARY_TAG = "summary";

export const SWAMPIFY_OPTION_ID_TAG = "optionId";

export const SWAMPIFY_CANDIDATES_QUERY_PREDICATE =
  `tags.type == "${SWAMPIFY_CANDIDATES_TYPE_TAG}"`;

export const SWAMPIFY_OFFER_QUERY_PREDICATE =
  `tags.type == "${SWAMPIFY_OFFER_TYPE_TAG}"`;

export const SWAMPIFY_COMPARISON_QUERY_PREDICATE =
  `tags.type == "${SWAMPIFY_COMPARISON_TYPE_TAG}"`;

/**
 * reads only name, owning behavior and tags, so with a tag predicate the
 * query never loads a body
 */
export const SWAMPIFY_LIST_SELECT =
  `{"name": name, "modelName": modelName, "tags": tags}`;

/**
 * sized on a heavy machine: 368 interactive and 20,759 headless sessions in
 * 30 days, whose largest repeat spanned 585 sessions; counts carry true
 * totals and only lists are capped
 */
export const SWAMPIFY_LIMITS = {
  harnessLength: 32,
  sessionIdLength: 128,
  nameLength: 200,
  pathLength: 1000,
  harnesses: 8,
  scopePaths: 1000,
  candidates: 100,
  sessionRefs: 50,
  excerpts: 5,
  // interactive prompts' first lines: median 40 characters, p99 465
  excerptLength: 300,
  minSteps: 2,
  steps: 8,
  stepLength: 200,
  labelLength: 200,
  programLength: 200,
  // the normalised key a candidate id hashes; only the hash is stored
  keyLength: 4000,
  whyLength: 300,
  options: 5,
  candidatesPerOption: 10,
  summaryTagLength: 4096,
} as const;

const L = SWAMPIFY_LIMITS;

/** cache reads cost about a tenth of fresh input */
export const SWAMPIFY_CACHE_READ_WEIGHT = 0.1;

/** a set with fewer candidates than this is thin */
export const SWAMPIFY_THIN_BELOW = 3;

/** the figure assess ranks by, so the stored range is exactly that figure */
export function swampifyWeightedTokens(tokens: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}): number {
  return tokens.input + tokens.output + tokens.cacheWrite +
    SWAMPIFY_CACHE_READ_WEIGHT * tokens.cacheRead;
}

// the session record's harness and session id shapes, so a reference names a
// record the way the importer stores it
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SESSION_ID = /^[a-z0-9][a-z0-9_-]*$/;
const CANDIDATE_ID = /^[0-9a-f]{32}$/;
const OPTION_ID = /^[0-9a-f]{16}$/;

const HarnessSchema = z.string().max(L.harnessLength).regex(SLUG);
const SessionIdSchema = z.string().max(L.sessionIdLength).regex(SESSION_ID);
const NameSchema = z.string().min(1).max(L.nameLength);
const CountSchema = z.number().int().nonnegative();
const AmountSchema = z.number().nonnegative();
const StepSchema = z.string().min(1).max(L.stepLength);

export const SwampifyCandidateIdSchema = z.string().regex(CANDIDATE_ID);

/** writer-derived with swampifyOptionId; readers check only the shape */
export const SwampifyOptionIdSchema = z.string().regex(OPTION_ID);

export const SwampifyCandidateKindSchema = z.enum([
  "prompt-repeat",
  "call-sequence",
  "covered-cli",
  "headless-job",
]);

export const SwampifyInvocationSchema = z.enum(["interactive", "headless"]);

export const SwampifyTargetSchema = z.strictObject({
  kind: z.enum(["behavior", "workflow"]),
  name: NameSchema,
});

export const SwampifyRangeSchema = z.strictObject({
  min: AmountSchema,
  median: AmountSchema,
  max: AmountSchema,
}).superRefine((range, ctx) => {
  if (range.min > range.median || range.median > range.max) {
    ctx.addIssue({
      code: "custom",
      message: "a range needs min <= median <= max",
      path: ["median"],
    });
  }
});

const TokenRangesSchema = z.strictObject({
  input: SwampifyRangeSchema,
  output: SwampifyRangeSchema,
  cacheRead: SwampifyRangeSchema,
  cacheWrite: SwampifyRangeSchema,
});

export const SwampifyCostRangeSchema = z.strictObject({
  tokens: TokenRangesSchema,
  toolCalls: SwampifyRangeSchema,
  activeMs: SwampifyRangeSchema,
});

/**
 * weightedTokens is the range of swampifyWeightedTokens per occurrence; it is
 * not derivable from the token ranges, since medians do not add
 */
export const SwampifyCandidateCostRangeSchema = z.strictObject({
  tokens: TokenRangesSchema,
  weightedTokens: SwampifyRangeSchema,
  toolCalls: SwampifyRangeSchema,
  activeMs: SwampifyRangeSchema,
});

// swamp-quality-ignore credentials-sensitive-field
const TokenTotalsSchema = z.strictObject({
  input: CountSchema,
  output: CountSchema,
  cacheRead: CountSchema,
  cacheWrite: CountSchema,
});

export const SwampifySessionRefSchema = z.strictObject({
  harness: HarnessSchema,
  sessionId: SessionIdSchema,
});

/** the writer redacts text; truncated marks one cut to fit */
export const SwampifyExcerptSchema = z.strictObject({
  source: z.enum(["prompt", "call"]),
  session: SwampifySessionRefSchema,
  text: z.string().min(1).max(L.excerptLength),
  truncated: z.literal(true).optional(),
});

// a repeated headless prompt is a headless-job, so a prompt-repeat is always
// interactive; call sequences and covered CLIs can be either
const KIND_INVOCATION: Readonly<
  Record<SwampifyCandidateKind, SwampifyInvocation | undefined>
> = {
  "prompt-repeat": "interactive",
  "headless-job": "headless",
  "call-sequence": undefined,
  "covered-cli": undefined,
};

/**
 * directories can exceed sessions, since a session can change directory;
 * rank is the 1-based position in the stored list, and score is what assess
 * ranked by, which need not fall with rank across invocations
 */
export const SwampifyCandidateSchema = z.strictObject({
  id: SwampifyCandidateIdSchema,
  kind: SwampifyCandidateKindSchema,
  invocation: SwampifyInvocationSchema,
  label: z.string().min(1).max(L.labelLength),
  score: AmountSchema,
  rank: CountSchema.min(1),
  occurrences: CountSchema.min(1),
  sessions: CountSchema.min(1),
  directories: CountSchema,
  firstSeen: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  perOccurrence: SwampifyCandidateCostRangeSchema,
  failureRate: z.number().min(0).max(1),
  sessionRefs: z.array(SwampifySessionRefSchema).max(L.sessionRefs),
  steps: z.array(StepSchema).min(L.minSteps).max(L.steps).optional(),
  program: z.string().min(1).max(L.programLength).optional(),
  excerpts: z.array(SwampifyExcerptSchema).max(L.excerpts),
}).superRefine((candidate, ctx) => {
  const sequence = candidate.kind === "call-sequence";
  if ((candidate.steps !== undefined) !== sequence) {
    ctx.addIssue({
      code: "custom",
      message: sequence
        ? "a call-sequence needs steps"
        : "only a call-sequence has steps",
      path: ["steps"],
    });
  }
  const cli = candidate.kind === "covered-cli";
  if ((candidate.program !== undefined) !== cli) {
    ctx.addIssue({
      code: "custom",
      message: cli
        ? "a covered-cli needs a program"
        : "only a covered-cli has a program",
      path: ["program"],
    });
  }
  const fixed = KIND_INVOCATION[candidate.kind];
  if (fixed !== undefined && candidate.invocation !== fixed) {
    ctx.addIssue({
      code: "custom",
      message: `a ${candidate.kind} is ${fixed}`,
      path: ["invocation"],
    });
  }
  if (candidate.sessions > candidate.occurrences) {
    ctx.addIssue({
      code: "custom",
      message: "more sessions than occurrences",
      path: ["sessions"],
    });
  }
  if (candidate.sessionRefs.length > candidate.sessions) {
    ctx.addIssue({
      code: "custom",
      message: "more session refs than sessions",
      path: ["sessionRefs"],
    });
  }
  if (Date.parse(candidate.firstSeen) > Date.parse(candidate.lastSeen)) {
    ctx.addIssue({
      code: "custom",
      message: "firstSeen is after lastSeen",
      path: ["lastSeen"],
    });
  }
});

/** paths show the home directory as ~ */
export const SwampifyScopeSchema = z.strictObject({
  harnesses: z.array(HarnessSchema).min(1).max(L.harnesses),
  all: z.boolean(),
  include: z.array(z.string().min(1).max(L.pathLength)).max(L.scopePaths),
  exclude: z.array(z.string().min(1).max(L.pathLength)).max(L.scopePaths),
}).superRefine((scope, ctx) => {
  if (scope.all && scope.include.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: "include is empty when all is set",
      path: ["include"],
    });
  }
  if (new Set(scope.harnesses).size !== scope.harnesses.length) {
    ctx.addIssue({
      code: "custom",
      message: "duplicate harness",
      path: ["harnesses"],
    });
  }
});

export const SwampifyCandidateSetV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  generatedAt: z.iso.datetime(),
  importerVersion: NameSchema,
  window: z.strictObject({
    since: z.iso.datetime(),
    until: z.iso.datetime(),
  }),
  scope: SwampifyScopeSchema,
  candidates: z.array(SwampifyCandidateSchema).max(L.candidates),
}).superRefine((set, ctx) => {
  if (Date.parse(set.window.since) > Date.parse(set.window.until)) {
    ctx.addIssue({
      code: "custom",
      message: "since is after until",
      path: ["window", "until"],
    });
  }
  const ids = new Set<string>();
  set.candidates.forEach((candidate, i) => {
    if (ids.has(candidate.id)) {
      ctx.addIssue({
        code: "custom",
        message: "duplicate candidate id",
        path: ["candidates", i, "id"],
      });
    }
    ids.add(candidate.id);
    if (candidate.rank !== i + 1) {
      ctx.addIssue({
        code: "custom",
        message: "rank is not the candidate's position",
        path: ["candidates", i, "rank"],
      });
    }
  });
});

/** the harness that read the example sessions, as session records name it */
export const SwampifyReadingHarnessSchema = z.enum(["claude-code", "codex"]);

export const SwampifyOfferOptionSchema = z.strictObject({
  id: SwampifyOptionIdSchema,
  name: z.string().min(1).max(L.labelLength),
  why: z.string().min(1).max(L.whyLength),
  becomes: z.enum(["behavior", "workflow"]),
  registryType: NameSchema.optional(),
  outline: z.array(StepSchema).min(1).max(L.steps).optional(),
  candidateIds: z.array(SwampifyCandidateIdSchema).min(1).max(
    L.candidatesPerOption,
  ),
});

/** into names the offered or considered candidate a merged one was folded into */
export const SwampifyConsideredSchema = z.strictObject({
  candidateId: SwampifyCandidateIdSchema,
  reason: z.enum(["not-a-chore", "merged", "low-value"]),
  into: SwampifyCandidateIdSchema.optional(),
}).superRefine((considered, ctx) => {
  const merged = considered.reason === "merged";
  if ((considered.into !== undefined) !== merged) {
    ctx.addIssue({
      code: "custom",
      message: merged
        ? "a merged candidate needs into"
        : "only merged has into",
      path: ["into"],
    });
  }
  if (considered.into === considered.candidateId) {
    ctx.addIssue({
      code: "custom",
      message: "a candidate is not merged into itself",
      path: ["into"],
    });
  }
});

export const SwampifyOfferStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("offered") }),
  z.strictObject({
    kind: z.literal("picked"),
    optionId: SwampifyOptionIdSchema,
    pickedAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal("built"),
    optionId: SwampifyOptionIdSchema,
    pickedAt: z.iso.datetime(),
    target: SwampifyTargetSchema,
    builtAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal("declined"),
    declinedAt: z.iso.datetime(),
  }),
]);

/**
 * the candidate set it was built from lives on the same behavior and is named
 * by its generatedAt; Zod cannot see that set, so the writer checks it
 */
export const SwampifyOfferV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  writerVersion: NameSchema,
  candidateSet: z.strictObject({ generatedAt: z.iso.datetime() }),
  reading: z.strictObject({
    harness: SwampifyReadingHarnessSchema,
    model: NameSchema.regex(/^\S+$/),
    candidates: CountSchema.max(L.candidates),
    sessions: CountSchema,
  }),
  options: z.array(SwampifyOfferOptionSchema).min(1).max(L.options),
  considered: z.array(SwampifyConsideredSchema).max(L.candidates),
  state: SwampifyOfferStateSchema,
}).superRefine((offer, ctx) => {
  const optionIds = new Set<string>();
  const candidateIds = new Set<string>();
  const claim = (id: string, path: (string | number)[]) => {
    if (candidateIds.has(id)) {
      ctx.addIssue({
        code: "custom",
        message: "a candidate appears more than once in the offer",
        path,
      });
    }
    candidateIds.add(id);
  };
  offer.options.forEach((option, i) => {
    if (optionIds.has(option.id)) {
      ctx.addIssue({
        code: "custom",
        message: "duplicate option id",
        path: ["options", i, "id"],
      });
    }
    optionIds.add(option.id);
    option.candidateIds.forEach((id, j) =>
      claim(id, ["options", i, "candidateIds", j])
    );
  });
  offer.considered.forEach((considered, i) =>
    claim(considered.candidateId, ["considered", i, "candidateId"])
  );
  offer.considered.forEach((considered, i) => {
    if (considered.into !== undefined && !candidateIds.has(considered.into)) {
      ctx.addIssue({
        code: "custom",
        message: "merged into a candidate the offer does not hold",
        path: ["considered", i, "into"],
      });
    }
  });
  if (candidateIds.size !== offer.reading.candidates) {
    ctx.addIssue({
      code: "custom",
      message: "offered and considered candidates do not add up to those read",
      path: ["reading", "candidates"],
    });
  }
  const at = (value: string) => Date.parse(value);
  const order = (
    earlier: string,
    later: string,
    path: (string | number)[],
    message: string,
  ) => {
    if (at(earlier) > at(later)) {
      ctx.addIssue({ code: "custom", message, path });
    }
  };
  order(
    offer.candidateSet.generatedAt,
    offer.createdAt,
    ["createdAt"],
    "created before its candidate set",
  );
  order(
    offer.createdAt,
    offer.updatedAt,
    ["updatedAt"],
    "updatedAt is before createdAt",
  );
  const state = offer.state;
  const within = (value: string, key: string) => {
    order(offer.createdAt, value, ["state", key], `${key} is before createdAt`);
    order(value, offer.updatedAt, ["state", key], `${key} is after updatedAt`);
  };
  if (state.kind === "picked" || state.kind === "built") {
    if (!optionIds.has(state.optionId)) {
      ctx.addIssue({
        code: "custom",
        message: "picks an option the offer does not hold",
        path: ["state", "optionId"],
      });
    }
    within(state.pickedAt, "pickedAt");
  }
  if (state.kind === "built") {
    within(state.builtAt, "builtAt");
    order(
      state.pickedAt,
      state.builtAt,
      ["state", "builtAt"],
      "built before it was picked",
    );
  }
  if (state.kind === "declined") within(state.declinedAt, "declinedAt");
});

const SwampifyOccurrencesSchema = z.strictObject({
  occurrences: CountSchema,
  perOccurrence: SwampifyCostRangeSchema.optional(),
});

const SwampifyHistoryCostSchema = z.strictObject({
  chore: SwampifyCostRangeSchema,
  wholeTurns: SwampifyCostRangeSchema,
});

/**
 * low is against whole turns and high against the chore's own calls, so low
 * <= high; null when the swamp side never recovers the build cost
 */
export const SwampifyBreakEvenSchema = z.strictObject({
  low: CountSchema.nullable(),
  high: CountSchema.nullable(),
}).superRefine(({ low, high }, ctx) => {
  if (low === null ? high !== null : high !== null && low > high) {
    ctx.addIssue({
      code: "custom",
      message: "breakEven needs low <= high, and high null when low is",
      path: ["high"],
    });
  }
});

// a chore's calls are part of their turns, so per occurrence the chore never
// costs more than its whole turns, nor do its min, median or max
function rangeWithin(inner: SwampifyRange, outer: SwampifyRange): boolean {
  return inner.min <= outer.min && inner.median <= outer.median &&
    inner.max <= outer.max;
}

function costMetrics(
  cost: SwampifyCostRange,
): ReadonlyArray<readonly [readonly string[], SwampifyRange]> {
  return [
    [["tokens", "input"], cost.tokens.input],
    [["tokens", "output"], cost.tokens.output],
    [["tokens", "cacheRead"], cost.tokens.cacheRead],
    [["tokens", "cacheWrite"], cost.tokens.cacheWrite],
    [["toolCalls"], cost.toolCalls],
    [["activeMs"], cost.activeMs],
  ];
}

/**
 * one offer option that was swamped; history is summed over all its
 * candidates, and estimatedUsd comes from a price table the writer supplies
 */
export const SwampifyComparisonV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  generatedAt: z.iso.datetime(),
  importerVersion: NameSchema,
  optionId: SwampifyOptionIdSchema,
  candidateIds: z.array(SwampifyCandidateIdSchema).min(1).max(
    L.candidatesPerOption,
  ),
  target: SwampifyTargetSchema,
  build: z.strictObject({
    tokens: TokenTotalsSchema,
    activeMs: AmountSchema,
  }),
  history: z.strictObject({
    occurrences: CountSchema,
    perOccurrence: SwampifyHistoryCostSchema.optional(),
  }),
  swampRun: z.strictObject({
    wallMs: AmountSchema,
    tokens: TokenTotalsSchema,
    outcome: z.enum(["succeeded", "failed"]),
  }),
  forward: z.strictObject({
    since: z.iso.datetime(),
    raw: SwampifyOccurrencesSchema,
    swamp: SwampifyOccurrencesSchema,
  }),
  breakEven: SwampifyBreakEvenSchema,
  estimatedUsd: z.strictObject({
    build: AmountSchema.optional(),
    historyPerOccurrence: z.strictObject({
      chore: SwampifyRangeSchema,
      wholeTurns: SwampifyRangeSchema,
    }).optional(),
    swampRun: AmountSchema.optional(),
  }).optional(),
}).superRefine((comparison, ctx) => {
  const seen = new Set<string>();
  comparison.candidateIds.forEach((id, i) => {
    if (seen.has(id)) {
      ctx.addIssue({
        code: "custom",
        message: "duplicate candidate id",
        path: ["candidateIds", i],
      });
    }
    seen.add(id);
  });
  const sides = [
    ["history", comparison.history],
    ["forward.raw", comparison.forward.raw],
    ["forward.swamp", comparison.forward.swamp],
  ] as const;
  for (const [where, side] of sides) {
    if ((side.perOccurrence !== undefined) !== (side.occurrences > 0)) {
      ctx.addIssue({
        code: "custom",
        message: side.occurrences > 0
          ? "occurrences need a perOccurrence cost"
          : "a perOccurrence cost needs occurrences",
        path: [...where.split("."), "perOccurrence"],
      });
    }
  }
  const history = comparison.history.perOccurrence;
  if (history !== undefined) {
    const whole = costMetrics(history.wholeTurns);
    costMetrics(history.chore).forEach(([metric, chore], i) => {
      if (!rangeWithin(chore, whole[i][1])) {
        ctx.addIssue({
          code: "custom",
          message: "the chore costs more than its whole turns",
          path: ["history", "perOccurrence", "chore", ...metric],
        });
      }
    });
  }
  const usd = comparison.estimatedUsd?.historyPerOccurrence;
  if (usd !== undefined && !rangeWithin(usd.chore, usd.wholeTurns)) {
    ctx.addIssue({
      code: "custom",
      message: "the chore costs more than its whole turns",
      path: ["estimatedUsd", "historyPerOccurrence", "chore"],
    });
  }
  if (usd !== undefined && comparison.history.perOccurrence === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "an estimate per occurrence needs history occurrences",
      path: ["estimatedUsd", "historyPerOccurrence"],
    });
  }
});

export type SwampifyCandidateKind = z.infer<typeof SwampifyCandidateKindSchema>;
export type SwampifyInvocation = z.infer<typeof SwampifyInvocationSchema>;
export type SwampifyRange = z.infer<typeof SwampifyRangeSchema>;
export type SwampifyCostRange = z.infer<typeof SwampifyCostRangeSchema>;
export type SwampifyCandidate = z.infer<typeof SwampifyCandidateSchema>;
export type SwampifyCandidateSet = z.infer<typeof SwampifyCandidateSetV2Schema>;
export type SwampifyOfferOption = z.infer<typeof SwampifyOfferOptionSchema>;
export type SwampifyOfferState = z.infer<typeof SwampifyOfferStateSchema>;
export type SwampifyOffer = z.infer<typeof SwampifyOfferV1Schema>;
export type SwampifyComparison = z.infer<typeof SwampifyComparisonV2Schema>;

export type SwampifySkipReason = "newer" | "older" | "invalid";

export interface SwampifySkipped {
  readonly kind: "skipped";
  readonly reason: SwampifySkipReason;
  readonly schemaVersion?: number;
  readonly note: string;
}

export type SwampifyCandidateSetReading =
  | { readonly kind: "record"; readonly record: SwampifyCandidateSet }
  | SwampifySkipped;

export type SwampifyOfferReading =
  | { readonly kind: "record"; readonly record: SwampifyOffer }
  | SwampifySkipped;

export type SwampifyComparisonReading =
  | { readonly kind: "record"; readonly record: SwampifyComparison }
  | SwampifySkipped;

interface ItemSpec<T> {
  readonly newest: number;
  readonly supported: readonly number[];
  readonly rerun: string;
  readonly schema: z.ZodType<T>;
  readonly oversized: (content: Record<string, unknown>) => string | undefined;
}

/**
 * never throws; a note names field paths, never values, except the integer
 * schemaVersion, and lists are counted before parsing so an oversized item
 * costs only those counts
 */
function readItem<T>(
  content: unknown,
  spec: ItemSpec<T>,
): { readonly kind: "record"; readonly record: T } | SwampifySkipped {
  const version = isObject(content) ? content.schemaVersion : undefined;
  if (
    typeof version !== "number" || !Number.isInteger(version) || version < 1
  ) {
    return skipped(
      "invalid",
      undefined,
      "no integer schemaVersion of 1 or more",
    );
  }
  if (version > spec.newest) {
    return skipped(
      "newer",
      version,
      `written as version ${version}; this reader reads up to version ${spec.newest}. Upgrade swamp and @swamp/agent-sessions to read it.`,
    );
  }
  if (!spec.supported.includes(version)) {
    return skipped(
      "older",
      version,
      `written as version ${version}, which this reader no longer reads. ${spec.rerun}`,
    );
  }
  const oversized = spec.oversized(content as Record<string, unknown>);
  if (oversized !== undefined) {
    return skipped(
      "invalid",
      version,
      `does not match version ${version}: too_big at ${oversized}`,
    );
  }
  const parsed = spec.schema.safeParse(content);
  if (parsed.success) return { kind: "record", record: parsed.data };
  const first = parsed.error.issues[0];
  const where = first && first.path.length > 0
    ? first.path.map(String).join(".")
    : "the record";
  return skipped(
    "invalid",
    version,
    `does not match version ${version}: ${
      first?.code ?? "invalid"
    } at ${where}`,
  );
}

function over(value: unknown, max: number): boolean {
  return Array.isArray(value) && value.length > max;
}

function oversizedInList(
  list: unknown,
  path: string,
  lists: ReadonlyArray<readonly [string, number]>,
): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!isObject(item)) continue;
    for (const [key, max] of lists) {
      if (over(item[key], max)) return `${path}.${i}.${key}`;
    }
  }
  return undefined;
}

function oversizedCandidateSet(
  content: Record<string, unknown>,
): string | undefined {
  const scope = isObject(content.scope) ? content.scope : {};
  const scopeLists = [
    ["harnesses", L.harnesses],
    ["include", L.scopePaths],
    ["exclude", L.scopePaths],
  ] as const;
  for (const [key, max] of scopeLists) {
    if (over(scope[key], max)) return `scope.${key}`;
  }
  if (over(content.candidates, L.candidates)) return "candidates";
  return oversizedInList(content.candidates, "candidates", [
    ["sessionRefs", L.sessionRefs],
    ["excerpts", L.excerpts],
    ["steps", L.steps],
  ]);
}

function oversizedOffer(content: Record<string, unknown>): string | undefined {
  if (over(content.options, L.options)) return "options";
  if (over(content.considered, L.candidates)) return "considered";
  return oversizedInList(content.options, "options", [
    ["outline", L.steps],
    ["candidateIds", L.candidatesPerOption],
  ]);
}

function oversizedComparison(
  content: Record<string, unknown>,
): string | undefined {
  return over(content.candidateIds, L.candidatesPerOption)
    ? "candidateIds"
    : undefined;
}

export function readSwampifyCandidateSet(
  content: unknown,
): SwampifyCandidateSetReading {
  return readItem(content, {
    newest: SWAMPIFY_CANDIDATE_SET_SCHEMA_VERSION,
    supported: SUPPORTED_SWAMPIFY_CANDIDATE_SET_SCHEMA_VERSIONS,
    rerun: "Run the assessment again.",
    schema: SwampifyCandidateSetV2Schema,
    oversized: oversizedCandidateSet,
  });
}

export function readSwampifyOffer(content: unknown): SwampifyOfferReading {
  return readItem(content, {
    newest: SWAMPIFY_OFFER_SCHEMA_VERSION,
    supported: SUPPORTED_SWAMPIFY_OFFER_SCHEMA_VERSIONS,
    rerun: "Ask the agent to offer again.",
    schema: SwampifyOfferV1Schema,
    oversized: oversizedOffer,
  });
}

export function readSwampifyComparison(
  content: unknown,
): SwampifyComparisonReading {
  return readItem(content, {
    newest: SWAMPIFY_COMPARISON_SCHEMA_VERSION,
    supported: SUPPORTED_SWAMPIFY_COMPARISON_SCHEMA_VERSIONS,
    rerun: "Run the comparison again.",
    schema: SwampifyComparisonV2Schema,
    oversized: oversizedComparison,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skipped(
  reason: SwampifySkipReason,
  schemaVersion: number | undefined,
  note: string,
): SwampifySkipped {
  return schemaVersion === undefined
    ? { kind: "skipped", reason, note }
    : { kind: "skipped", reason, schemaVersion, note };
}

/** a list row as SWAMPIFY_LIST_SELECT returns it */
export interface SwampifyListRow {
  readonly name: unknown;
  readonly modelName: unknown;
  readonly tags: unknown;
}

/**
 * the item a reader shows: newest by the given time tag, compared as instants
 * so a tag not written by toISOString still sorts; ties go to the swampify
 * behavior, then modelName, then name; rows that cannot be opened or whose tag
 * does not parse are passed over
 */
export function newestSwampifyItem<T extends SwampifyListRow>(
  rows: readonly T[],
  timeTag: typeof SWAMPIFY_GENERATED_AT_TAG | typeof SWAMPIFY_UPDATED_AT_TAG,
): T | undefined {
  let best: { row: T; at: number; owner: string; name: string } | undefined;
  for (const row of rows) {
    if (typeof row.name !== "string" || typeof row.modelName !== "string") {
      continue;
    }
    const tag = isObject(row.tags) ? row.tags[timeTag] : undefined;
    const at = typeof tag === "string" ? Date.parse(tag) : NaN;
    if (Number.isNaN(at)) continue;
    const candidate = { row, at, owner: row.modelName, name: row.name };
    if (best === undefined || beats(candidate, best)) best = candidate;
  }
  return best?.row;
}

function beats(
  a: { at: number; owner: string; name: string },
  b: { at: number; owner: string; name: string },
): boolean {
  if (a.at !== b.at) return a.at > b.at;
  const aOwned = a.owner === SWAMPIFY_BEHAVIOR_NAME;
  const bOwned = b.owner === SWAMPIFY_BEHAVIOR_NAME;
  if (aOwned !== bOwned) return aOwned;
  if (a.owner !== b.owner) return a.owner < b.owner;
  return a.name < b.name;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * 32 hex digits of SHA-256 over [kind, invocation, key]; key is normalised
 * before redaction so a change to the redaction rules never changes an id
 */
export async function swampifyCandidateId(
  kind: SwampifyCandidateKind,
  invocation: SwampifyInvocation,
  key: string,
): Promise<string> {
  if (!SwampifyCandidateKindSchema.safeParse(kind).success) {
    throw new Error("unknown candidate kind");
  }
  if (!SwampifyInvocationSchema.safeParse(invocation).success) {
    throw new Error("candidate invocation must be interactive or headless");
  }
  if (key.length === 0 || key.length > L.keyLength) {
    throw new Error(`candidate key must be 1 to ${L.keyLength} characters`);
  }
  return (await sha256Hex(JSON.stringify([kind, invocation, key]))).slice(
    0,
    32,
  );
}

/**
 * 16 hex digits of SHA-256 over the sorted candidate ids, so the same chore
 * keeps its id, and its comparison, across offers and re-assessments
 */
export async function swampifyOptionId(
  candidateIds: readonly string[],
): Promise<string> {
  if (
    candidateIds.length === 0 || candidateIds.length > L.candidatesPerOption
  ) {
    throw new Error(
      `an option needs 1 to ${L.candidatesPerOption} candidate ids`,
    );
  }
  for (const id of candidateIds) {
    if (!SwampifyCandidateIdSchema.safeParse(id).success) {
      throw new Error("candidate id must be 32 lowercase hex digits");
    }
  }
  const sorted = [...candidateIds].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("an option's candidate ids must be distinct");
  }
  return (await sha256Hex(JSON.stringify(sorted))).slice(0, 16);
}

function assertOptionId(optionId: string): void {
  if (!SwampifyOptionIdSchema.safeParse(optionId).success) {
    throw new Error("option id must be 16 lowercase hex digits");
  }
}

/** throws on anything but an option id, so nothing else reaches a name */
export function swampifyComparisonDataName(optionId: string): string {
  assertOptionId(optionId);
  return `swampify-comparison-${optionId}`;
}

/** throws on anything but an option id, so nothing else reaches a predicate */
export function swampifyComparisonPredicate(optionId: string): string {
  assertOptionId(optionId);
  return `${SWAMPIFY_COMPARISON_QUERY_PREDICATE} && tags.${SWAMPIFY_OPTION_ID_TAG} == "${optionId}"`;
}

/** counts only: no labels or excerpts */
export const SwampifyCandidateSetSummaryV2Schema = z.strictObject({
  since: z.iso.datetime(),
  until: z.iso.datetime(),
  harnesses: z.array(HarnessSchema).min(1).max(L.harnesses),
  candidates: CountSchema.max(L.candidates),
  thin: z.boolean(),
  interactive: CountSchema,
  headless: CountSchema,
  kinds: z.strictObject({
    "prompt-repeat": CountSchema,
    "call-sequence": CountSchema,
    "covered-cli": CountSchema,
    "headless-job": CountSchema,
  }),
}).superRefine((summary, ctx) => {
  if (summary.thin !== summary.candidates < SWAMPIFY_THIN_BELOW) {
    ctx.addIssue({
      code: "custom",
      message:
        `thin is set exactly when there are fewer than ${SWAMPIFY_THIN_BELOW} candidates`,
      path: ["thin"],
    });
  }
  if (summary.interactive + summary.headless !== summary.candidates) {
    ctx.addIssue({
      code: "custom",
      message: "interactive and headless do not add up to candidates",
      path: ["headless"],
    });
  }
  if (summary.kinds["prompt-repeat"] > summary.interactive) {
    ctx.addIssue({
      code: "custom",
      message: "more prompt-repeat candidates than interactive ones",
      path: ["kinds", "prompt-repeat"],
    });
  }
  if (summary.kinds["headless-job"] > summary.headless) {
    ctx.addIssue({
      code: "custom",
      message: "more headless-job candidates than headless ones",
      path: ["kinds", "headless-job"],
    });
  }
  const kinds = Object.values(summary.kinds).reduce((a, b) => a + b, 0);
  if (kinds !== summary.candidates) {
    ctx.addIssue({
      code: "custom",
      message: "kinds do not add up to candidates",
      path: ["kinds"],
    });
  }
  if (new Set(summary.harnesses).size !== summary.harnesses.length) {
    ctx.addIssue({
      code: "custom",
      message: "duplicate harness",
      path: ["harnesses"],
    });
  }
});

export const SwampifyOfferSummaryV1Schema = z.strictObject({
  state: z.enum(["offered", "picked", "built", "declined"]),
  options: CountSchema.min(1).max(L.options),
  pickedOptionId: SwampifyOptionIdSchema.optional(),
  target: SwampifyTargetSchema.optional(),
}).superRefine((summary, ctx) => {
  const picked = summary.state === "picked" || summary.state === "built";
  if ((summary.pickedOptionId !== undefined) !== picked) {
    ctx.addIssue({
      code: "custom",
      message: picked
        ? "a picked or built offer names its option"
        : "only a picked or built offer names an option",
      path: ["pickedOptionId"],
    });
  }
  if ((summary.target !== undefined) !== (summary.state === "built")) {
    ctx.addIssue({
      code: "custom",
      message: summary.state === "built"
        ? "a built offer names its target"
        : "only a built offer names a target",
      path: ["target"],
    });
  }
});

export const SwampifyComparisonSummaryV2Schema = z.strictObject({
  optionId: SwampifyOptionIdSchema,
  target: SwampifyTargetSchema,
  outcome: z.enum(["succeeded", "failed"]),
  historyOccurrences: CountSchema,
  forwardRaw: CountSchema,
  forwardSwamp: CountSchema,
  breakEven: SwampifyBreakEvenSchema,
});

export type SwampifyCandidateSetSummary = z.infer<
  typeof SwampifyCandidateSetSummaryV2Schema
>;
export type SwampifyOfferSummary = z.infer<typeof SwampifyOfferSummaryV1Schema>;
export type SwampifyComparisonSummary = z.infer<
  typeof SwampifyComparisonSummaryV2Schema
>;

export function swampifyCandidateSetSummary(
  set: SwampifyCandidateSet,
): SwampifyCandidateSetSummary {
  const kinds = {
    "prompt-repeat": 0,
    "call-sequence": 0,
    "covered-cli": 0,
    "headless-job": 0,
  };
  let interactive = 0;
  for (const candidate of set.candidates) {
    kinds[candidate.kind]++;
    if (candidate.invocation === "interactive") interactive++;
  }
  return {
    since: set.window.since,
    until: set.window.until,
    harnesses: [...set.scope.harnesses],
    candidates: set.candidates.length,
    thin: set.candidates.length < SWAMPIFY_THIN_BELOW,
    interactive,
    headless: set.candidates.length - interactive,
    kinds,
  };
}

export function swampifyOfferSummary(
  offer: SwampifyOffer,
): SwampifyOfferSummary {
  const state = offer.state;
  return {
    state: state.kind,
    options: offer.options.length,
    ...(state.kind === "picked" || state.kind === "built"
      ? { pickedOptionId: state.optionId }
      : {}),
    ...(state.kind === "built" ? { target: { ...state.target } } : {}),
  };
}

export function swampifyComparisonSummary(
  comparison: SwampifyComparison,
): SwampifyComparisonSummary {
  return {
    optionId: comparison.optionId,
    target: { ...comparison.target },
    outcome: comparison.swampRun.outcome,
    historyOccurrences: comparison.history.occurrences,
    forwardRaw: comparison.forward.raw.occurrences,
    forwardSwamp: comparison.forward.swamp.occurrences,
    breakEven: { ...comparison.breakEven },
  };
}

/** derived from the set so the tags cannot drift from it */
export function swampifyCandidateSetTags(
  set: SwampifyCandidateSet,
): Record<string, string> {
  return {
    [SWAMPIFY_GENERATED_AT_TAG]: new Date(set.generatedAt).toISOString(),
    [SWAMPIFY_SUMMARY_TAG]: JSON.stringify(swampifyCandidateSetSummary(set)),
  };
}

/** derived from the offer so the tags cannot drift from it */
export function swampifyOfferTags(
  offer: SwampifyOffer,
): Record<string, string> {
  return {
    [SWAMPIFY_UPDATED_AT_TAG]: new Date(offer.updatedAt).toISOString(),
    [SWAMPIFY_SUMMARY_TAG]: JSON.stringify(swampifyOfferSummary(offer)),
  };
}

/** derived from the comparison so the tags cannot drift from it */
export function swampifyComparisonTags(
  comparison: SwampifyComparison,
): Record<string, string> {
  return {
    [SWAMPIFY_GENERATED_AT_TAG]: new Date(comparison.generatedAt)
      .toISOString(),
    [SWAMPIFY_OPTION_ID_TAG]: comparison.optionId,
    [SWAMPIFY_SUMMARY_TAG]: JSON.stringify(
      swampifyComparisonSummary(comparison),
    ),
  };
}

function readSummaryTag<T>(
  value: unknown,
  schema: z.ZodType<T>,
): T | undefined {
  if (typeof value !== "string" || value.length > L.summaryTagLength) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const summary = schema.safeParse(parsed);
  return summary.success ? summary.data : undefined;
}

/**
 * never throws; tags are self-reported, so a reader shows a summary but
 * always validates the body with the item's reader when it opens it
 */
export function readSwampifyCandidateSetSummary(
  value: unknown,
): SwampifyCandidateSetSummary | undefined {
  return readSummaryTag(value, SwampifyCandidateSetSummaryV2Schema);
}

export function readSwampifyOfferSummary(
  value: unknown,
): SwampifyOfferSummary | undefined {
  return readSummaryTag(value, SwampifyOfferSummaryV1Schema);
}

export function readSwampifyComparisonSummary(
  value: unknown,
): SwampifyComparisonSummary | undefined {
  return readSummaryTag(value, SwampifyComparisonSummaryV2Schema);
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
}

export function swampifyCandidateSetJsonSchema(): Record<string, unknown> {
  return jsonSchema(SwampifyCandidateSetV2Schema);
}

export function swampifyCandidateSetSummaryJsonSchema(): Record<
  string,
  unknown
> {
  return jsonSchema(SwampifyCandidateSetSummaryV2Schema);
}

export function swampifyOfferJsonSchema(): Record<string, unknown> {
  return jsonSchema(SwampifyOfferV1Schema);
}

export function swampifyOfferSummaryJsonSchema(): Record<string, unknown> {
  return jsonSchema(SwampifyOfferSummaryV1Schema);
}

export function swampifyComparisonJsonSchema(): Record<string, unknown> {
  return jsonSchema(SwampifyComparisonV2Schema);
}

export function swampifyComparisonSummaryJsonSchema(): Record<
  string,
  unknown
> {
  return jsonSchema(SwampifyComparisonSummaryV2Schema);
}

/** the checked-in files under design/surfaces/ and what generates each */
export const SWAMPIFY_JSON_SCHEMA_FILES: ReadonlyArray<
  readonly [string, () => Record<string, unknown>]
> = [
  ["swampify-candidate-set.schema.json", swampifyCandidateSetJsonSchema],
  [
    "swampify-candidate-set-summary.schema.json",
    swampifyCandidateSetSummaryJsonSchema,
  ],
  ["swampify-offer.schema.json", swampifyOfferJsonSchema],
  ["swampify-offer-summary.schema.json", swampifyOfferSummaryJsonSchema],
  ["swampify-comparison.schema.json", swampifyComparisonJsonSchema],
  [
    "swampify-comparison-summary.schema.json",
    swampifyComparisonSummaryJsonSchema,
  ],
];
