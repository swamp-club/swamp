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
import {
  comparisonKey,
  type ComparisonRecord,
  type Loadable,
  type SwampifyState,
} from "../../client/useSwampify.ts";
import {
  CANDIDATE_IDS,
  emptyCandidateSet,
  fixtureCandidateSet,
  fixtureComparison,
  fixtureOffer,
  hostileCandidateSet,
  OPTION_IDS,
  thinCandidateSet,
} from "./swampify_fixtures.ts";
import { SwampifyPage } from "./SwampifyPage.tsx";
import { type LaunchState, OptionReview } from "./SwampifyReview.tsx";
import { builtOptions, BuiltPane } from "./SwampifyBuilt.tsx";
import { offerView, type SwampifyLauncher } from "../../lib/swampify_view.ts";

const noop = () => {};

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
  { open, optionId, tab, records = new Map() }: {
    open?: string;
    optionId?: string;
    tab?: "candidates" | "built";
    records?: ReadonlyMap<string, ComparisonRecord>;
  } = {},
): string {
  return renderToStaticMarkup(
    <SwampifyPage
      state={s}
      records={records}
      onLoadComparison={noop}
      initialOpen={open}
      optionId={optionId ?? null}
      onOpenOption={noop}
      initialTab={tab}
    />,
  );
}

function review(
  offer: SwampifyOffer,
  {
    set = fixtureCandidateSet(),
    optionId = OPTION_IDS[0],
    behavior = "swampify",
    briefShown = true,
    row,
    launch,
    launchState,
  }: {
    set?: SwampifyCandidateSet;
    optionId?: string;
    behavior?: string;
    briefShown?: boolean;
    row?: SwampifyRow;
    launch?: SwampifyLauncher;
    launchState?: LaunchState;
  } = {},
): string {
  const view = offerView(offer, set, set.generatedAt);
  const option = view.options.find((o) => o.option.id === optionId);
  assert(option);
  return renderToStaticMarkup(
    <OptionReview
      option={option}
      offer={view}
      behavior={behavior}
      comparison={row}
      records={new Map()}
      onLoadComparison={noop}
      onBack={noop}
      initialBriefShown={briefShown}
      launch={launch}
      initialLaunch={launchState}
    />,
  );
}

const launcher: SwampifyLauncher = () =>
  Promise.resolve({ opened: true, command: "claude" });

function read(reading: SwampifyComparisonReading): ComparisonRecord {
  return { state: "read", reading };
}

Deno.test("SwampifyPage: with no candidate set listed it says how to get one", () => {
  const html = render({
    ...state({ setRow: loadable(undefined) }),
    set: loadable(null),
  });
  assertStringIncludes(html, "No assessment yet.");
  assert(!html.includes("<table"));
});

Deno.test("SwampifyPage: a set with no offer shows its window, a note and ranked candidates", () => {
  const html = render(state());
  assertStringIncludes(
    html,
    "Turn prompts and tool calls into Swamp powered automation",
  );
  // one sentence, with the exact times and paths kept for hover
  assertStringIncludes(html, "Assessed <time");
  assertStringIncludes(
    html,
    ">Nov 10</time> from Claude Code and Codex sessions between",
  );
  assertStringIncludes(html, ">Oct 11</time> and <time");
  assertStringIncludes(html, ">Nov 9</time>, in every repo except");
  assertStringIncludes(html, 'title="~/private">1 path</span>.');
  assertStringIncludes(html, "Your agent hasn&#x27;t made its offer yet");
  assertStringIncludes(html, "release the docs site and post the changelog");
  assert(!html.includes("Top candidates"));
  // median weighted tokens and the failure rate, as stored
  assertStringIncludes(html, ">44.4K<");
  assertStringIncludes(html, ">22%<");
});

const CARD_NAME = (name: string) => `<span class="sw-option-name">${name}<`;

Deno.test("SwampifyPage: the offer leads as option cards, in each state, built ones aside", () => {
  for (const kind of ["offered", "picked", "built", "declined"] as const) {
    const html = render(state({ offer: fixtureOffer(kind) }));
    assert(html.indexOf("Top candidates") < html.indexOf("<table"));
    assertStringIncludes(
      html,
      "Claude Code (claude-sonnet-5-5) read 18 example sessions for 6 candidates and offered 2 options.",
    );
    assertEquals(
      html.includes(CARD_NAME("Release the docs site")),
      kind !== "built",
    );
    assertStringIncludes(html, "Create a behavior using @acme/ci-report<");
    assert(!html.includes("one in five runs fails"));
    // the card's button reads like the open row's: words, then the arrow
    assertStringIncludes(
      html,
      'Review and build<span class="sw-icon-btn" aria-hidden="true"><svg',
    );
    assertEquals(html.includes(">Picked</span>"), kind === "picked");
    assertEquals(html.includes(">Built</span>"), false);
    assertEquals(
      html.includes("You declined this offer."),
      kind === "declined",
    );
  }
});

Deno.test("SwampifyPage: with an offer, only candidates it can build are listed, with no placement column", () => {
  const html = render(state({ offer: fixtureOffer("offered") }));
  const table = html.slice(html.indexOf("<table"));
  for (
    const label of ["release the docs site", "summarise yesterday", "make lint"]
  ) {
    assertStringIncludes(table, label);
  }
  for (
    const label of [
      "kubectl run directly",
      "publish the docs and announce it",
      "what does this error mean",
    ]
  ) {
    assert(!table.includes(label), label);
  }
  assertStringIncludes(html, 'Candidates <span class="sw-muted">· 3, ranked');
  assert(!html.includes("In the offer"));
  assert(!html.includes("Left out"));
  assertEquals(table.match(/<th /g)?.length, 7);
});

Deno.test("SwampifyPage: before an offer every candidate is listed, with no action", () => {
  const html = render(state(), { open: CANDIDATE_IDS[0] });
  assertStringIncludes(html, "what does this error mean");
  assert(!html.includes("Review and build"));
});

Deno.test("SwampifyPage: an open row names its option and has the Review and build icon button", () => {
  const closed = render(state({ offer: fixtureOffer("offered") }));
  assert(!closed.includes("sw-detail-action"));
  const html = render(state({ offer: fixtureOffer("offered") }), {
    open: CANDIDATE_IDS[0],
  });
  assertStringIncludes(html, "Part of <strong>Release the docs site</strong>");
  assertStringIncludes(
    html,
    '<button type="button" class="sw-icon-btn" aria-label="Review and build Release the docs site" title="Review and build">',
  );
});

Deno.test("SwampifyPage: an open row shows its excerpts, ranges and where it was seen", () => {
  const html = render(state(), { open: CANDIDATE_IDS[0] });
  assertStringIncludes(html, "Weighted tokens:");
  assertStringIncludes(
    html,
    "release the docs site again, the last build failed",
  );
  assertStringIncludes(html, "Seen in");
  assert(!html.includes("Agent sessions"));
});

Deno.test("SwampifyPage: a thin set and an empty set say so", () => {
  const thin = render(state({ set: thinCandidateSet() }));
  assertStringIncludes(thin, "A thin assessment: only 2 chores");
  const empty = render(state({ set: emptyCandidateSet() }));
  assertStringIncludes(empty, "Nothing repeated often enough in this window");
  assert(!empty.includes("<table"));
});

Deno.test("SwampifyPage: a skipped set shows the note, never content", () => {
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
  assertStringIncludes(html, "Its candidates are not in the shown assessment.");
});

Deno.test("SwampifyPage: a skipped offer shows the note, never content", () => {
  const html = render(state({
    offerReading: {
      kind: "skipped",
      reason: "invalid",
      schemaVersion: 1,
      note: "does not match version 1: custom at options",
    },
  }));
  assertStringIncludes(html, "This offer was skipped, not valid");
  assert(!html.includes("Top candidates"));
  assert(!html.includes("hasn&#x27;t made its offer"));
});

Deno.test("SwampifyPage: opening an option shows its review in place of the list", () => {
  const html = render(state({ offer: fixtureOffer("offered") }), {
    optionId: OPTION_IDS[0],
  });
  assertStringIncludes(html, "← Swampify");
  assertStringIncludes(html, "What swamp would build");
  assert(!html.includes("<table"));
});

Deno.test("OptionReview: shows what swamp would build and the evidence", () => {
  const html = review(fixtureOffer("offered"));
  assertStringIncludes(html, "Release the docs site");
  assertStringIncludes(html, "one in five runs fails");
  assertStringIncludes(html, "Create a workflow, in these steps:");
  assertStringIncludes(html, "<li>publish it</li>");
  assertStringIncludes(html, "It stands for 2 candidates:");
  assertStringIncludes(html, "release the docs site and post the changelog");
  assertStringIncludes(html, "Hand it to your agent");
  assertStringIncludes(html, "Hide brief");
  // building and handing off come first, the evidence after
  assert(html.indexOf("Hide brief") < html.indexOf("The evidence"));
  assert(html.indexOf("What swamp would build") < html.indexOf("Hide brief"));
});

Deno.test("OptionReview: the brief records the pick and leaves out labels and excerpts", () => {
  const html = review(fixtureOffer("offered"));
  const brief =
    html.match(/<pre id="sw-brief" class="sw-brief">([\s\S]*?)<\/pre>/)?.[1] ??
      "";
  assertStringIncludes(brief, "&lt;!-- swamp start brief v1 --&gt;");
  assertStringIncludes(
    brief,
    `swamp behavior run swampify pick --input optionId=${OPTION_IDS[0]}`,
  );
  assertStringIncludes(
    brief,
    "Automate this repeated chore as a swamp workflow",
  );
  assert(!brief.includes("release the docs site and post the changelog"));
  assert(!brief.includes(CANDIDATE_IDS[0]));
});

Deno.test("OptionReview: the brief stays hidden until asked for", () => {
  const html = review(fixtureOffer("offered"), { briefShown: false });
  assertStringIncludes(html, ">Show brief</button>");
  assert(!html.includes('<pre id="sw-brief"'));
  assert(!html.includes("Copy brief"));
});

Deno.test("OptionReview: a behavior name unsafe for a command gives no brief", () => {
  const html = review(fixtureOffer("offered"), { behavior: "bad name`x" });
  assert(!html.includes("Copy brief"));
  assertStringIncludes(html, "can&#x27;t be written into a brief safely");
});

Deno.test("OptionReview: the shown brief has a copy icon button in it", () => {
  const html = review(fixtureOffer("offered"));
  assertStringIncludes(html, '<div class="sw-brief-wrap"><pre id="sw-brief"');
  assertStringIncludes(
    html,
    'class="sw-icon-btn sw-copy" aria-label="Copy brief" title="Copy brief"><svg',
  );
});

Deno.test("OptionReview: under serve there is no Swampify! and Show brief is the action", () => {
  const html = review(fixtureOffer("offered"));
  assert(!html.includes("Swampify!"));
  assertStringIncludes(
    html,
    'class="sw-btn sw-btn-primary" aria-expanded="true" aria-controls="sw-brief">Hide brief</button>',
  );
});

Deno.test("OptionReview: on the local dashboard Swampify! leads, names the agent and asks for trust", () => {
  const html = review(fixtureOffer("offered"), {
    launch: launcher,
    briefShown: false,
  });
  assertStringIncludes(
    html,
    '<button type="button" class="sw-btn sw-btn-primary">Swampify!</button>',
  );
  assertStringIncludes(
    html,
    'class="sw-btn" aria-expanded="false" aria-controls="sw-brief">Show brief</button>',
  );
  assert(html.indexOf("Swampify!") < html.indexOf("Show brief"));
  assertStringIncludes(html, "Swampify! opens Claude Code in this repo");
  assertStringIncludes(
    html,
    "Clicking Swampify! confirms you trust this folder.",
  );
});

Deno.test("OptionReview: an opened agent is said, and Swampify! can't run twice", () => {
  const html = review(fixtureOffer("offered"), {
    launch: launcher,
    launchState: { kind: "opened" },
    briefShown: false,
  });
  assertStringIncludes(html, "Opened Claude Code");
  assertStringIncludes(html, "in a new terminal.");
  assertStringIncludes(html, 'disabled="">Swampify!</button>');
  assert(!html.includes("confirms you trust"));
});

Deno.test("OptionReview: with no terminal to open, the command to run is shown", () => {
  const html = review(fixtureOffer("offered"), {
    launch: launcher,
    launchState: { kind: "command", command: "cd /repo && claude" },
    briefShown: false,
  });
  assertStringIncludes(html, "No terminal could be opened.");
  assertStringIncludes(
    html,
    '<pre class="sw-brief">cd /repo &amp;&amp; claude</pre>',
  );
});

Deno.test("OptionReview: a refused launch says why and leaves Show brief", () => {
  const html = review(fixtureOffer("offered"), {
    launch: launcher,
    launchState: { kind: "failed", message: "Sign in to Swamp Club first." },
    briefShown: false,
  });
  assertStringIncludes(html, 'role="alert">Sign in to Swamp Club first.');
  assertStringIncludes(html, "You can still show the brief and copy it.");
  assertStringIncludes(html, ">Show brief</button>");
  assert(!html.includes('disabled="">Swampify!'));
});

Deno.test("OptionReview: a built option shows what was built and its comparison, with no brief", () => {
  const html = review(fixtureOffer("built"), { row: comparisonRow });
  assertStringIncludes(html, ">Built</span>");
  assertStringIncludes(
    html,
    "Your agent built the workflow <code>release-docs</code>",
  );
  assertStringIncludes(html, "Raw against swamp");
  assertStringIncludes(html, "Compared: workflow <code>release-docs</code>");
  assert(!html.includes("Copy brief"));
});

Deno.test("SwampifyPage: a skipped comparison shows the note when opened, never its figures", () => {
  const skipped = new Map([[
    comparisonKey(comparisonRow),
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
    { optionId: OPTION_IDS[0], records: skipped },
  );
  assertStringIncludes(html, "Show comparison");
  assert(!html.includes("Past runs"));
});

Deno.test("SwampifyPage: text from an item renders as text, and the page has no links", () => {
  const set = hostileCandidateSet();
  const pages = [
    render(state({ set }), { open: CANDIDATE_IDS[0] }),
    render(state({ set }), { open: CANDIDATE_IDS[2] }),
    review(fixtureOffer("offered"), { set }),
  ];
  for (const html of pages) {
    for (const raw of ["<img", "<script", "<b>", 'javascript:alert(4)"']) {
      assert(!html.includes(raw), `rendered ${raw} as markup`);
    }
    assertEquals([...html.matchAll(/href="/g)].length, 0);
  }
  assertStringIncludes(pages[0], "&lt;img src=x onerror=");
  assertStringIncludes(pages[0], "&lt;script&gt;alert(3)&lt;/script&gt;");
  assertStringIncludes(pages[1], "&lt;b&gt;bold&lt;/b&gt;");
});

Deno.test("SwampifyPage: loading and errors show where they happen, with a retry", () => {
  const html = render({ ...state(), set: loadable(null, { loading: true }) });
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

Deno.test("SwampifyPage: an offer from an earlier assessment says so", () => {
  const offer = fixtureOffer("offered");
  const set = fixtureCandidateSet({ generatedAt: "2026-11-11T09:00:00.000Z" });
  const html = render(state({ set, offer }));
  assertStringIncludes(html, "This offer was made from an earlier assessment");
});

Deno.test("SwampifyPage: a limited comparison list says so on Built", () => {
  const html = render(state({ limited: true }), { tab: "built" });
  assertStringIncludes(html, "More comparisons exist than this page reads");
});

Deno.test("SwampifyPage: Candidates comes first with a to-build count; Built lists what was built", () => {
  const s = state({
    offer: fixtureOffer("built"),
    comparisons: new Map([[OPTION_IDS[0], comparisonRow]]),
  });
  const first = render(s);
  assertStringIncludes(
    first,
    'class="sw-tab active">Candidates<span class="sw-tab-count sw-tab-count-todo">1<span class="sw-sr-only">to build</span>',
  );
  assertStringIncludes(
    first,
    'class="sw-tab">Built<span class="sw-tab-count">1<span class="sw-sr-only">built</span>',
  );

  const built = render(s, { tab: "built" });
  assertStringIncludes(built, 'id="sw-panel-built"');
  assertStringIncludes(
    built,
    '<span class="sw-built-name">Release the docs site</span>',
  );
  assertStringIncludes(
    built,
    "workflow <code>release-docs</code> · built Nov 10",
  );
  assertStringIncludes(built, 'aria-expanded="false"');
  assertStringIncludes(built, "Run <span");
  assert(!built.includes("Open its review"));
  assert(!built.includes("Nightly failed-build summary"));
  assert(!built.includes("<table"));
});

Deno.test("BuiltPane: an open row shows its comparison body", () => {
  const offer = fixtureOffer("built");
  const set = fixtureCandidateSet();
  const view = offerView(offer, set, set.generatedAt);
  const html = renderToStaticMarkup(
    <BuiltPane
      view={view}
      options={builtOptions(view, new Map([[OPTION_IDS[0], comparisonRow]]))}
      comparisons={new Map([[OPTION_IDS[0], comparisonRow]])}
      records={new Map([[
        comparisonKey(comparisonRow),
        read({ kind: "record", record: comparison }),
      ]])}
      onLoadComparison={noop}
      initialOpen={OPTION_IDS[0]}
    />,
  );
  assertStringIncludes(html, 'aria-expanded="true"');
  assertStringIncludes(html, "Past runs");
});

Deno.test("SwampifyPage: Built says so when nothing is built yet", () => {
  const html = render(state({ offer: fixtureOffer("picked") }), {
    tab: "built",
  });
  assertStringIncludes(html, "Nothing built yet");
  assert(!html.includes('<span class="sw-tab-count">'));
});

Deno.test("SwampifyPage: when every option is built, Candidates says so", () => {
  const offer = fixtureOffer("built");
  const html = render(
    state({
      offer,
      comparisons: new Map([[OPTION_IDS[1], comparisonRow]]),
    }),
  );
  assertStringIncludes(html, "Every option in this offer is built; see Built.");
});
