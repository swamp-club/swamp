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
 * How the Swampify panel asks for candidate sets, offers and comparisons,
 * and how it reads the answers. Pure: no React, so tests and the serve
 * integration test drive the same payloads the panel sends.
 *
 * Every list reads names, owners and tags only, so no body loads until the
 * panel opens the item the contract's rule picks (`newestSwampifyItem`).
 */

import {
  newestSwampifyItem,
  readSwampifyCandidateSet,
  readSwampifyCandidateSetSummary,
  readSwampifyComparison,
  readSwampifyComparisonSummary,
  readSwampifyOffer,
  readSwampifyOfferSummary,
  SWAMPIFY_CANDIDATES_QUERY_PREDICATE,
  SWAMPIFY_COMPARISON_QUERY_PREDICATE,
  SWAMPIFY_GENERATED_AT_TAG,
  SWAMPIFY_LIST_SELECT,
  SWAMPIFY_OFFER_QUERY_PREDICATE,
  SWAMPIFY_OPTION_ID_TAG,
  SWAMPIFY_SUMMARY_TAG,
  SWAMPIFY_UPDATED_AT_TAG,
  type SwampifyCandidateSetReading,
  type SwampifyCandidateSetSummary,
  type SwampifyComparisonReading,
  type SwampifyComparisonSummary,
  type SwampifyOfferReading,
  type SwampifyOfferSummary,
  type SwampifySkipped,
} from "../lib/agent_sessions/swampify.ts";

/** Candidate sets or offers one list reads: one per owning behavior. */
export const SWAMPIFY_ITEM_LIMIT = 50;
/** Comparisons one list reads; an offer holds at most five options. */
export const SWAMPIFY_COMPARISON_LIMIT = 500;

/** One listed item: its name, owner and string tags, never its body. */
export interface SwampifyRow {
  readonly name: string;
  readonly modelName: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface SwampifyRows {
  readonly rows: readonly SwampifyRow[];
  /** The list stopped at its limit, so more items exist. */
  readonly limited: boolean;
}

type TimeTag =
  | typeof SWAMPIFY_GENERATED_AT_TAG
  | typeof SWAMPIFY_UPDATED_AT_TAG;

function listOf(
  predicate: string,
  timeTag: TimeTag,
  limit: number,
): Record<string, unknown> {
  return {
    predicate,
    select: SWAMPIFY_LIST_SELECT,
    limit,
    sort: { field: `tags.${timeTag}`, direction: "desc" },
  };
}

/** The visibility check: is there one candidate set this viewer can read? */
export function candidateSetProbePayload(): Record<string, unknown> {
  return {
    predicate: SWAMPIFY_CANDIDATES_QUERY_PREDICATE,
    select: SWAMPIFY_LIST_SELECT,
    limit: 1,
  };
}

export function candidateSetListPayload(): Record<string, unknown> {
  return listOf(
    SWAMPIFY_CANDIDATES_QUERY_PREDICATE,
    SWAMPIFY_GENERATED_AT_TAG,
    SWAMPIFY_ITEM_LIMIT,
  );
}

export function offerListPayload(): Record<string, unknown> {
  return listOf(
    SWAMPIFY_OFFER_QUERY_PREDICATE,
    SWAMPIFY_UPDATED_AT_TAG,
    SWAMPIFY_ITEM_LIMIT,
  );
}

export function comparisonListPayload(): Record<string, unknown> {
  return listOf(
    SWAMPIFY_COMPARISON_QUERY_PREDICATE,
    SWAMPIFY_GENERATED_AT_TAG,
    SWAMPIFY_COMPARISON_LIMIT,
  );
}

/**
 * Names one version of a listed item: its owner, name and tags, which a
 * rewrite of the same item changes.
 */
export function swampifyRowKey(row: SwampifyRow): string {
  return JSON.stringify([row.modelName, row.name, row.tags]);
}

/** Opens one listed item by its owner and name. */
export function itemPayload(row: SwampifyRow): Record<string, unknown> {
  return {
    modelIdOrName: row.modelName,
    dataName: row.name,
    includeContent: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRow(value: unknown): SwampifyRow | null {
  if (!isRecord(value)) return null;
  const { name, modelName, tags } = value;
  if (typeof name !== "string" || typeof modelName !== "string") return null;
  const strings: Record<string, string> = {};
  if (isRecord(tags)) {
    for (const [key, tag] of Object.entries(tags)) {
      if (typeof tag === "string") strings[key] = tag;
    }
  }
  return { name, modelName, tags: strings };
}

/**
 * Reads a `data.query` reply for the list select. A row without a string
 * name and owner is dropped; tags that are not strings are left out.
 */
export function parseSwampifyRows(data: unknown): SwampifyRows {
  if (!isRecord(data)) return { rows: [], limited: false };
  const projected = isRecord(data.projected) ? data.projected : undefined;
  const raw = Array.isArray(projected?.rows) ? projected.rows : [];
  return {
    rows: raw.map(readRow).filter((r): r is SwampifyRow => r !== null),
    limited: data.limited === true,
  };
}

/** The candidate set the contract's rule shows, or undefined. */
export function shownCandidateSet(
  rows: readonly SwampifyRow[],
): SwampifyRow | undefined {
  return newestSwampifyItem(rows, SWAMPIFY_GENERATED_AT_TAG);
}

/** The offer the contract's rule shows, or undefined. */
export function shownOffer(
  rows: readonly SwampifyRow[],
): SwampifyRow | undefined {
  return newestSwampifyItem(rows, SWAMPIFY_UPDATED_AT_TAG);
}

/**
 * Each option's comparison, by the `optionId` tag: the newest by the
 * contract's rule when several behaviors wrote one.
 */
export function comparisonsByOption(
  rows: readonly SwampifyRow[],
): ReadonlyMap<string, SwampifyRow> {
  const groups = new Map<string, SwampifyRow[]>();
  for (const row of rows) {
    const optionId = row.tags[SWAMPIFY_OPTION_ID_TAG];
    if (optionId === undefined) continue;
    const group = groups.get(optionId);
    if (group) group.push(row);
    else groups.set(optionId, [row]);
  }
  const shown = new Map<string, SwampifyRow>();
  for (const [optionId, group] of groups) {
    const row = newestSwampifyItem(group, SWAMPIFY_GENERATED_AT_TAG);
    if (row) shown.set(optionId, row);
  }
  return shown;
}

export function candidateSetSummaryOf(
  row: SwampifyRow,
): SwampifyCandidateSetSummary | undefined {
  return readSwampifyCandidateSetSummary(row.tags[SWAMPIFY_SUMMARY_TAG]);
}

export function offerSummaryOf(
  row: SwampifyRow,
): SwampifyOfferSummary | undefined {
  return readSwampifyOfferSummary(row.tags[SWAMPIFY_SUMMARY_TAG]);
}

export function comparisonSummaryOf(
  row: SwampifyRow,
): SwampifyComparisonSummary | undefined {
  return readSwampifyComparisonSummary(row.tags[SWAMPIFY_SUMMARY_TAG]);
}

/**
 * The JSON a `data.get` reply holds, or a skip whose note repeats nothing
 * from the content.
 */
function replyContent(
  data: unknown,
): { readonly content: unknown } | SwampifySkipped {
  const content = isRecord(data) ? data.content : undefined;
  const encoding = isRecord(data) ? data.contentEncoding : undefined;
  if (typeof content !== "string" || (encoding ?? "utf-8") !== "utf-8") {
    return {
      kind: "skipped",
      reason: "invalid",
      note: "the stored item is not JSON text",
    };
  }
  try {
    return { content: JSON.parse(content) };
  } catch {
    return {
      kind: "skipped",
      reason: "invalid",
      note: "the stored item is not valid JSON",
    };
  }
}

/** Reads a `data.get` reply for a candidate set. Never throws. */
export function parseCandidateSetReply(
  data: unknown,
): SwampifyCandidateSetReading {
  const read = replyContent(data);
  return "content" in read ? readSwampifyCandidateSet(read.content) : read;
}

/** Reads a `data.get` reply for an offer. Never throws. */
export function parseOfferReply(data: unknown): SwampifyOfferReading {
  const read = replyContent(data);
  return "content" in read ? readSwampifyOffer(read.content) : read;
}

/** Reads a `data.get` reply for a comparison. Never throws. */
export function parseComparisonReply(
  data: unknown,
): SwampifyComparisonReading {
  const read = replyContent(data);
  return "content" in read ? readSwampifyComparison(read.content) : read;
}
