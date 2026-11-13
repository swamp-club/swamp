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
  SWAMPIFY_CANDIDATES_QUERY_PREDICATE,
  SWAMPIFY_COMPARISON_QUERY_PREDICATE,
  SWAMPIFY_LIST_SELECT,
  SWAMPIFY_OFFER_QUERY_PREDICATE,
  swampifyCandidateSetTags,
  swampifyComparisonTags,
  swampifyOfferTags,
} from "../../../../src/domain/agent_sessions/swampify.ts";
import {
  fixtureCandidateSet,
  fixtureComparison,
  fixtureOffer,
  OPTION_IDS,
} from "../views/swampify/swampify_fixtures.ts";
import {
  candidateSetListPayload,
  candidateSetProbePayload,
  candidateSetSummaryOf,
  comparisonListPayload,
  comparisonsByOption,
  comparisonSummaryOf,
  itemPayload,
  offerListPayload,
  offerSummaryOf,
  parseCandidateSetReply,
  parseComparisonReply,
  parseOfferReply,
  parseSwampifyRows,
  shownCandidateSet,
  shownOffer,
  SWAMPIFY_COMPARISON_LIMIT,
  SWAMPIFY_ITEM_LIMIT,
  type SwampifyRow,
  swampifyRowKey,
} from "./swampify.ts";

function row(
  name: string,
  modelName: string,
  tags: Record<string, string>,
): SwampifyRow {
  return { name, modelName, tags };
}

Deno.test("candidateSetProbePayload: one candidate set by its type tag, tags only", () => {
  assertEquals(candidateSetProbePayload(), {
    predicate: SWAMPIFY_CANDIDATES_QUERY_PREDICATE,
    select: SWAMPIFY_LIST_SELECT,
    limit: 1,
  });
});

Deno.test("list payloads: each kind by its contract predicate and select, newest first by its time tag, bounded", () => {
  assertEquals(candidateSetListPayload(), {
    predicate: SWAMPIFY_CANDIDATES_QUERY_PREDICATE,
    select: SWAMPIFY_LIST_SELECT,
    limit: SWAMPIFY_ITEM_LIMIT,
    sort: { field: "tags.generatedAt", direction: "desc" },
  });
  assertEquals(offerListPayload(), {
    predicate: SWAMPIFY_OFFER_QUERY_PREDICATE,
    select: SWAMPIFY_LIST_SELECT,
    limit: SWAMPIFY_ITEM_LIMIT,
    sort: { field: "tags.updatedAt", direction: "desc" },
  });
  assertEquals(comparisonListPayload(), {
    predicate: SWAMPIFY_COMPARISON_QUERY_PREDICATE,
    select: SWAMPIFY_LIST_SELECT,
    limit: SWAMPIFY_COMPARISON_LIMIT,
    sort: { field: "tags.generatedAt", direction: "desc" },
  });
});

Deno.test("itemPayload: opens an item by the owner the list returned", () => {
  assertEquals(itemPayload(row("swampify-candidates", "swampify", {})), {
    modelIdOrName: "swampify",
    dataName: "swampify-candidates",
    includeContent: true,
  });
});

Deno.test("parseSwampifyRows: keeps rows with a string name and owner, and string tags only", () => {
  const parsed = parseSwampifyRows({
    limited: true,
    projected: {
      rows: [
        { name: "a", modelName: "swampify", tags: { generatedAt: "x", n: 3 } },
        { name: "b", tags: {} },
        { name: 4, modelName: "m", tags: {} },
        "junk",
        { name: "c", modelName: "other", tags: null },
      ],
    },
  });
  assertEquals(parsed, {
    rows: [
      row("a", "swampify", { generatedAt: "x" }),
      row("c", "other", {}),
    ],
    limited: true,
  });
  assertEquals(parseSwampifyRows(null), { rows: [], limited: false });
});

Deno.test("shownCandidateSet: the newest by generatedAt across behaviors, by the contract's rule", () => {
  const older = row("swampify-candidates", "swampify", {
    generatedAt: "2026-11-09T00:00:00.000Z",
  });
  const newer = row("swampify-candidates", "elsewhere", {
    generatedAt: "2026-11-10T00:00:00.000Z",
  });
  const undated = row("swampify-candidates", "undated", {});
  assertEquals(shownCandidateSet([older, newer, undated]), newer);
  assertEquals(shownCandidateSet([undated]), undefined);
});

Deno.test("shownOffer: the newest by updatedAt; a tie goes to the swampify behavior", () => {
  const at = "2026-11-10T00:00:00.000Z";
  const other = row("swampify-offer", "aaa", { updatedAt: at });
  const owned = row("swampify-offer", "swampify", { updatedAt: at });
  assertEquals(shownOffer([other, owned]), owned);
});

Deno.test("comparisonsByOption: the newest per optionId tag; rows without one are left out", () => {
  const a1 = row("swampify-comparison-a", "swampify", {
    optionId: OPTION_IDS[0],
    generatedAt: "2026-11-09T00:00:00.000Z",
  });
  const a2 = row("swampify-comparison-a", "other", {
    optionId: OPTION_IDS[0],
    generatedAt: "2026-11-10T00:00:00.000Z",
  });
  const b = row("swampify-comparison-b", "swampify", {
    optionId: OPTION_IDS[1],
    generatedAt: "2026-11-08T00:00:00.000Z",
  });
  const none = row("swampify-comparison-c", "swampify", {
    generatedAt: "2026-11-10T00:00:00.000Z",
  });
  const shown = comparisonsByOption([a1, a2, b, none]);
  assertEquals([...shown.entries()], [[OPTION_IDS[0], a2], [OPTION_IDS[1], b]]);
});

Deno.test("summaries: read from the summary tag, undefined when it does not read", () => {
  const set = fixtureCandidateSet();
  assertEquals(
    candidateSetSummaryOf(row("s", "m", swampifyCandidateSetTags(set)))
      ?.candidates,
    6,
  );
  assertEquals(
    offerSummaryOf(row("o", "m", swampifyOfferTags(fixtureOffer("built"))))
      ?.state,
    "built",
  );
  assertEquals(
    comparisonSummaryOf(
      row("c", "m", swampifyComparisonTags(fixtureComparison())),
    )?.optionId,
    OPTION_IDS[0],
  );
  assertEquals(
    candidateSetSummaryOf(row("s", "m", { summary: "{" })),
    undefined,
  );
});

Deno.test("parse replies: bodies go through the contract readers", () => {
  const set = fixtureCandidateSet();
  assertEquals(parseCandidateSetReply({ content: JSON.stringify(set) }), {
    kind: "record",
    record: set,
  });
  const offer = fixtureOffer("picked");
  assertEquals(parseOfferReply({ content: JSON.stringify(offer) }), {
    kind: "record",
    record: offer,
  });
  const comparison = fixtureComparison();
  assertEquals(
    parseComparisonReply({ content: JSON.stringify(comparison) }),
    { kind: "record", record: comparison },
  );
});

Deno.test("parse replies: never throw, and a skip repeats nothing from the content", () => {
  assertEquals(parseCandidateSetReply({ content: "{secret" }), {
    kind: "skipped",
    reason: "invalid",
    note: "the stored item is not valid JSON",
  });
  assertEquals(parseOfferReply({ content: "x", contentEncoding: "base64" }), {
    kind: "skipped",
    reason: "invalid",
    note: "the stored item is not JSON text",
  });
  assertEquals(parseComparisonReply(undefined).kind, "skipped");
  const newer = parseCandidateSetReply({
    content: JSON.stringify({ ...fixtureCandidateSet(), schemaVersion: 99 }),
  });
  assertEquals(newer.kind === "skipped" && newer.reason, "newer");
});

Deno.test("swampifyRowKey: a rewrite of the same item is a new key; the same version keeps its key", () => {
  const first = row("swampify-comparison-a", "swampify", {
    generatedAt: "2026-11-09T00:00:00.000Z",
  });
  const again = row("swampify-comparison-a", "swampify", {
    generatedAt: "2026-11-09T00:00:00.000Z",
  });
  const rewritten = row("swampify-comparison-a", "swampify", {
    generatedAt: "2026-11-10T00:00:00.000Z",
  });
  const otherOwner = row("swampify-comparison-a", "elsewhere", first.tags);
  assertEquals(swampifyRowKey(first), swampifyRowKey(again));
  assertEquals(swampifyRowKey(first) === swampifyRowKey(rewritten), false);
  assertEquals(swampifyRowKey(first) === swampifyRowKey(otherOwner), false);
});
