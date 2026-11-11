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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { agentSessionDataName } from "../../../../../src/domain/agent_sessions/session_record.ts";
import {
  type SwampifyCandidateSet,
  swampifyCandidateSetTags,
  type SwampifyComparisonReading,
  swampifyComparisonTags,
  type SwampifyOffer,
  swampifyOfferTags,
  type SwampifySkipped,
} from "../../../../../src/domain/agent_sessions/swampify.ts";
import type { SwampifyRow } from "../../client/swampify.ts";
import type {
  ComparisonRecord,
  Loadable,
  SwampifyState,
} from "../../client/useSwampify.ts";
import { fixtureSessions } from "./fixtures.ts";
import {
  CANDIDATE_IDS,
  emptyCandidateSet,
  fixtureCandidateSet,
  fixtureComparison,
  fixtureOffer,
  HOSTILE_TEXT,
  hostileCandidateSet,
  OPTION_IDS,
  thinCandidateSet,
} from "./swampify_fixtures.ts";
import { candidateComparisonKey } from "./SwampifyCandidates.tsx";
import { SwampifyView } from "./SwampifyPanel.tsx";

const noop = () => {};
const [, long] = fixtureSessions();
const LONG_NAME = agentSessionDataName(long.harness, long.id);

function loadable<T>(value: T, extra: Partial<Loadable<T>> = {}): Loadable<T> {
  return { value, loading: false, error: null, refetch: noop, ...extra };
}

const comparison = fixtureComparison();
const comparisonRow: SwampifyRow = {
  name: `swampify-comparison-${OPTION_IDS[0]}`,
  modelName: "swampify",
  tags: swampifyComparisonTags(comparison),
};

function state(
  {
    set = fixtureCandidateSet(),
    setReading,
    offer,
    offerReading,
    comparisons = new Map(),
    limited = false,
    setRow,
  }: {
    set?: SwampifyCandidateSet;
    setReading?: SwampifyState["set"]["value"];
    offer?: SwampifyOffer;
    offerReading?: SwampifySkipped;
    comparisons?: ReadonlyMap<string, SwampifyRow>;
    limited?: boolean;
    setRow?: Loadable<SwampifyRow | undefined>;
  } = {},
): SwampifyState {
  const hasOffer = offer !== undefined || offerReading !== undefined;
  return {
    setRow: setRow ?? loadable<SwampifyRow | undefined>({
      name: "swampify-candidates",
      modelName: "swampify",
      tags: swampifyCandidateSetTags(set),
    }),
    set: loadable(setReading ?? { kind: "record", record: set }),
    offerRow: loadable<SwampifyRow | undefined>(
      hasOffer
        ? {
          name: "swampify-offer",
          modelName: "swampify",
          tags: offer ? swampifyOfferTags(offer) : {},
        }
        : undefined,
    ),
    offer: loadable(
      offer ? { kind: "record", record: offer } : offerReading ?? null,
    ),
    comparisons: loadable(comparisons),
    comparisonsLimited: limited,
  };
}

function render(
  s: SwampifyState,
  {
    open = [],
    openComparisons = [],
    records = new Map(),
    loaded = new Set([LONG_NAME]),
  }: {
    open?: string[];
    openComparisons?: string[];
    records?: ReadonlyMap<string, ComparisonRecord>;
    loaded?: ReadonlySet<string>;
  } = {},
): string {
  return renderToStaticMarkup(
    <SwampifyView
      state={s}
      records={records}
      onLoadComparison={noop}
      loadedSessions={loaded}
      onOpenSession={noop}
      initialOpen={open}
      initialOpenComparisons={openComparisons}
    />,
  );
}

function read(reading: SwampifyComparisonReading): ComparisonRecord {
  return { state: "read", reading };
}

const records = new Map([[
  `swampify/${comparisonRow.name}`,
  read({ kind: "record", record: comparison }),
]]);

Deno.test("SwampifyView: absent when no candidate set is listed", () => {
  const html = render(state({ setRow: loadable(undefined) }));
  assertEquals(html, "");
});

Deno.test("SwampifyView: a set with no offer shows its header and ranked candidates", () => {
  const html = render(state());
  assertStringIncludes(html, "Swampify: chores worth automating");
  assertStringIncludes(html, "Sessions from 2026-10-11 to 2026-11-09");
  assertStringIncludes(html, "claude-code, codex");
  assertStringIncludes(html, "every repo");
  assertStringIncludes(html, "1 excluded path");
  assertStringIncludes(html, "by behavior <code>swampify</code>");
  assertStringIncludes(html, "release the docs site and post the changelog");
  assertStringIncludes(
    html,
    "the repo and session filters above apply to sessions",
  );
  assert(!html.includes('aria-label="Offer"'));
  // median weighted tokens and calls, and the failure rate, as stored
  assertStringIncludes(html, ">44.4K<");
  assertStringIncludes(html, ">27<");
  assertStringIncludes(html, ">22%<");
});

Deno.test("SwampifyView: an offer leads, in each state", () => {
  const texts = {
    offered: "Offered: waiting for a pick",
    picked: "Picked: not built yet",
    built: "Built",
    declined: "Declined: nothing was picked",
  } as const;
  for (const kind of ["offered", "picked", "built", "declined"] as const) {
    const html = render(state({ offer: fixtureOffer(kind) }));
    assertStringIncludes(html, texts[kind]);
    assert(html.indexOf('aria-label="Offer"') < html.indexOf("<table"));
    assertStringIncludes(html, "Claude Code read the example sessions with");
    assertStringIncludes(html, "claude-sonnet-5-5");
    assertStringIncludes(html, "Release the docs site");
    assertStringIncludes(
      html,
      "Becomes a behavior using <code>@acme/ci-report</code>",
    );
    const picked = html.includes(">Picked</span>");
    assertEquals(picked, kind === "picked" || kind === "built");
    assertEquals(
      html.includes("built as workflow <code>release-docs</code>"),
      kind === "built",
    );
  }
});

Deno.test("SwampifyView: candidates show where the offer placed them", () => {
  const html = render(state({ offer: fixtureOffer("built") }));
  assertStringIncludes(html, "In the offer: Release the docs site");
  assertStringIncludes(html, "Left out: Low value");
  assertStringIncludes(
    html,
    "Left out: Merged into release the docs site and post the changelog",
  );
  assertStringIncludes(html, "Left out: Not a chore");
});

Deno.test("SwampifyView: a thin set and an empty set say so", () => {
  const thin = render(state({ set: thinCandidateSet() }));
  assertStringIncludes(thin, "A thin assessment: only 2 chores");
  const empty = render(state({ set: emptyCandidateSet() }));
  assertStringIncludes(empty, "Nothing repeated often enough in this window");
  assert(!empty.includes("<table"));
});

Deno.test("SwampifyView: a skipped set shows the note, never content, and the offer cannot resolve candidates", () => {
  const html = render(state({
    setReading: {
      kind: "skipped",
      reason: "newer",
      schemaVersion: 3,
      note: "written as version 3; upgrade swamp",
    },
    offer: fixtureOffer("offered"),
  }));
  assertStringIncludes(
    html,
    "This candidate set was skipped, written by a newer version: written as version 3; upgrade swamp",
  );
  assert(!html.includes("release the docs site and post the changelog"));
  assertStringIncludes(html, "the assessment did not load");
});

Deno.test("SwampifyView: a skipped offer shows the note, never content", () => {
  const html = render(state({
    offerReading: {
      kind: "skipped",
      reason: "invalid",
      schemaVersion: 1,
      note: "does not match version 1: custom at options",
    },
  }));
  assertStringIncludes(html, "This offer was skipped, not valid");
  assert(!html.includes('aria-label="Offer"'));
});

Deno.test("SwampifyView: a candidate with a comparison opens it; one without says not compared", () => {
  const html = render(
    state({
      offer: fixtureOffer("built"),
      comparisons: new Map([[OPTION_IDS[0], comparisonRow]]),
    }),
    {
      open: [CANDIDATE_IDS[0], CANDIDATE_IDS[1], CANDIDATE_IDS[3]],
      openComparisons: [candidateComparisonKey(CANDIDATE_IDS[0])],
      records,
    },
  );
  assertStringIncludes(html, "Compared: workflow <code>release-docs</code>");
  assertStringIncludes(html, "Hide comparison");
  assertStringIncludes(html, "Past runs: the chore&#x27;s calls");
  assertStringIncludes(html, "After 4 – 11 runs");
  assertStringIncludes(html, "an estimate from the writer");
  // option 2 holds candidate 2 and has no comparison
  assertStringIncludes(html, "Not compared yet.");
  // candidate 4 is in no option
  assertStringIncludes(html, "Not compared: no offer option holds it.");
});

Deno.test("SwampifyView: a skipped comparison shows the note, never its figures", () => {
  const skipped = new Map([[
    `swampify/${comparisonRow.name}`,
    read({
      kind: "skipped",
      reason: "older",
      schemaVersion: 1,
      note: "written as version 1, which this reader no longer reads.",
    }),
  ]]);
  const html = render(
    state({
      offer: fixtureOffer("built"),
      comparisons: new Map([[OPTION_IDS[0], comparisonRow]]),
    }),
    { openComparisons: [OPTION_IDS[0]], records: skipped },
  );
  assertStringIncludes(
    html,
    "This comparison was skipped, written by an older version",
  );
  assert(!html.includes("Past runs"));
});

Deno.test("SwampifyView: an opened row shows ranges, excerpts and session refs; a ref links only to a loaded session", () => {
  const html = render(state(), { open: [CANDIDATE_IDS[0]] });
  assertStringIncludes(html, "Weighted tokens");
  assertStringIncludes(
    html,
    "release the docs site again, the last build failed",
  );
  assertStringIncludes(
    html,
    `href="?session=${encodeURIComponent(LONG_NAME)}"`,
  );
  assertStringIncludes(html, "not in the sessions this page loaded");
  const anchors = html.match(/<a /g) ?? [];
  assertEquals(anchors.length, 1);
});

Deno.test("SwampifyView: text from an item renders as text, and session refs are the only links", () => {
  const html = render(state({ set: hostileCandidateSet() }), {
    open: [CANDIDATE_IDS[0], CANDIDATE_IDS[2]],
  });
  for (const raw of ["<img", "<script", "<b>", 'href="javascript']) {
    assert(!html.includes(raw), `rendered ${raw} as markup`);
  }
  assertStringIncludes(html, "&lt;img src=x onerror=");
  assertStringIncludes(html, "&lt;script&gt;alert(3)&lt;/script&gt;");
  assertStringIncludes(html, "&lt;b&gt;bold&lt;/b&gt;");
  assertStringIncludes(html, "https://evil.example/path");
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assertEquals(hrefs, [`?session=${encodeURIComponent(LONG_NAME)}`]);
  assert(HOSTILE_TEXT.label.length > 0);
});

Deno.test("SwampifyView: loading and errors show where they happen, with a retry", () => {
  const loading = state();
  const html = render({
    ...loading,
    set: loadable(null, { loading: true }),
  });
  assertStringIncludes(html, "Loading the assessment…");
  const failed = render(state({
    setRow: loadable<SwampifyRow | undefined>(undefined, { error: "boom" }),
  }));
  assertStringIncludes(failed, "Couldn&#x27;t load Swampify candidates.");
  assertStringIncludes(failed, "Retry");
  const comparisonsFailed = render({
    ...state(),
    comparisons: loadable(new Map(), { error: "down" }),
  });
  assertStringIncludes(comparisonsFailed, "Couldn&#x27;t load comparisons.");
});

Deno.test("SwampifyView: an offer from an earlier assessment says so", () => {
  const offer = fixtureOffer("offered");
  const set = fixtureCandidateSet({ generatedAt: "2026-11-11T09:00:00.000Z" });
  const html = render(state({ set, offer }));
  assertStringIncludes(html, "Built from an earlier assessment");
});

Deno.test("SwampifyView: a limited comparison list says so", () => {
  const html = render(state({ limited: true }));
  assertStringIncludes(html, "More comparisons exist than this page reads");
});
