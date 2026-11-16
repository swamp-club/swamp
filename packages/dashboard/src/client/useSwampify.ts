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
 * The Swampify page's requests. Payloads and parsing live in `swampify.ts`;
 * this file only sends them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRequest } from "./useRequest.ts";
import { useSwamp } from "./SwampProvider.tsx";
import { replyData } from "./agent_sessions.ts";
import { extractArray } from "./extract.ts";
import {
  candidateSetListPayload,
  candidateSetProbePayload,
  comparisonListPayload,
  comparisonsByOption,
  hasSwampifyBehavior,
  itemPayload,
  offerListPayload,
  parseCandidateSetReply,
  parseComparisonReply,
  parseOfferReply,
  parseReadingProgress,
  parseSwampifyRows,
  refetchOnReturn,
  shownCandidateSet,
  shownOffer,
  swampifyPollMs,
  swampifyReadingPayload,
  type SwampifyReadingProgress,
  type SwampifyRow,
  swampifyRowKey,
  swampifyStage,
} from "./swampify.ts";
import { tabDocument, useDocumentVisible } from "./run_activity.ts";
import {
  SWAMPIFY_GENERATED_AT_TAG,
  type SwampifyCandidateSetReading,
  type SwampifyComparisonReading,
  type SwampifyOfferReading,
} from "../lib/agent_sessions/swampify.ts";

/**
 * Whether the viewer can read a candidate set: one query, limit 1, rerun on
 * reconnect like the Agent sessions probe.
 */
/**
 * Whether the sidebar offers Swampify: a candidate set exists, a swampify
 * behavior means one is coming, or the page is open.
 */
export function useSwampifyVisible(onPage = false): boolean {
  const probe = useRequest("data.query", candidateSetProbePayload());
  const models = useRequest("model.search");
  // The first assessment lands while the user is in their agent's window.
  useListsOnReturn([probe.refetch, models.refetch]);
  return onPage ||
    parseSwampifyRows(replyData(probe.data)).rows.length > 0 ||
    hasSwampifyBehavior(extractArray<{ type?: unknown }>(models.data));
}

/** Calls the latest `refetches` each time the tab comes back into view. */
function useListsOnReturn(refetches: readonly (() => void)[]): void {
  const latest = useRef(refetches);
  latest.current = refetches;
  useEffect(
    () =>
      refetchOnReturn(tabDocument(), [
        () => {
          for (const refetch of latest.current) refetch();
        },
      ]),
    [],
  );
}

/** Calls the latest `refetches` every `intervalMs`; null stops the clock. */
function useListsOnInterval(
  refetches: readonly (() => void)[],
  intervalMs: number | null,
): void {
  const latest = useRef(refetches);
  latest.current = refetches;
  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => {
      for (const refetch of latest.current) refetch();
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export interface Loadable<T> {
  readonly value: T;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

function useShownItem<R>(
  listPayload: Record<string, unknown>,
  pick: (rows: readonly SwampifyRow[]) => SwampifyRow | undefined,
  parse: (data: unknown) => R,
): {
  readonly list: Loadable<SwampifyRow | undefined>;
  readonly body: Loadable<R | null>;
  readonly answered: boolean;
} {
  const listReq = useRequest("data.query", listPayload);
  const row = useMemo(
    () => pick(parseSwampifyRows(replyData(listReq.data)).rows),
    [listReq.data],
  );
  const key = row ? swampifyRowKey(row) : null;
  const bodyReq = useRequest(
    "data.get",
    row ? itemPayload(row) : undefined,
    { enabled: row !== undefined },
  );
  // A body belongs to the row version it was read for, so a newer version
  // never shows the previous one's content while it loads.
  const [read, setRead] = useState<{ key: string | null; reading: R } | null>(
    null,
  );
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    if (bodyReq.data) {
      setRead({ key: keyRef.current, reading: parse(replyData(bodyReq.data)) });
    }
  }, [bodyReq.data]);
  // A rewrite keeps the item's name, so the payload is unchanged and the
  // request would not re-run on its own.
  const previous = useRef(row);
  useEffect(() => {
    const before = previous.current;
    previous.current = row;
    if (
      row && before && key !== swampifyRowKey(before) &&
      row.modelName === before.modelName && row.name === before.name
    ) {
      bodyReq.refetch();
    }
  }, [key]);
  const reading = read !== null && read.key === key ? read.reading : null;
  return {
    answered: listReq.data !== null || listReq.error !== null,
    list: {
      value: row,
      loading: listReq.loading,
      error: listReq.error,
      refetch: listReq.refetch,
    },
    body: {
      value: row ? reading : null,
      loading: row !== undefined && bodyReq.loading,
      error: row ? bodyReq.error : null,
      refetch: bodyReq.refetch,
    },
  };
}

export interface SwampifyState {
  readonly setRow: Loadable<SwampifyRow | undefined>;
  readonly set: Loadable<SwampifyCandidateSetReading | null>;
  readonly offerRow: Loadable<SwampifyRow | undefined>;
  readonly offer: Loadable<SwampifyOfferReading | null>;
  readonly comparisons: Loadable<ReadonlyMap<string, SwampifyRow>>;
  readonly comparisonsLimited: boolean;
  /** The readers' run for the shown set, read only while it is being read. */
  readonly reading: SwampifyReadingProgress | null;
}

/** The shown candidate set and offer, their bodies, and comparisons by option. */
export function useSwampify(): SwampifyState {
  const set = useShownItem(
    candidateSetListPayload(),
    shownCandidateSet,
    parseCandidateSetReply,
  );
  const offer = useShownItem(offerListPayload(), shownOffer, parseOfferReply);
  const comparisonReq = useRequest("data.query", comparisonListPayload());
  const parsed = useMemo(
    () => parseSwampifyRows(replyData(comparisonReq.data)),
    [comparisonReq.data],
  );
  const byOption = useMemo(() => comparisonsByOption(parsed.rows), [parsed]);
  const stage = swampifyStage({
    answered: set.answered && offer.answered &&
      (comparisonReq.data !== null || comparisonReq.error !== null),
    setRow: set.list.value,
    offerRow: offer.list.value,
    offer: offer.body.value,
    comparisons: byOption,
  });
  const setGeneratedAt = set.list.value?.tags[SWAMPIFY_GENERATED_AT_TAG];
  const readingReq = useRequest(
    "workflow.run.search",
    setGeneratedAt ? swampifyReadingPayload(setGeneratedAt) : undefined,
    { enabled: stage === "reading" && setGeneratedAt !== undefined },
  );
  // The agent writes from its own process, so the page re-reads its lists
  // when the tab comes back, and on a clock while the work is unfinished.
  // Bodies follow: a list row with a new version re-reads its body.
  const lists = [
    set.list.refetch,
    offer.list.refetch,
    comparisonReq.refetch,
    ...(stage === "reading" ? [readingReq.refetch] : []),
  ];
  useListsOnReturn(lists);
  useListsOnInterval(lists, swampifyPollMs(stage, useDocumentVisible()));
  const reading = useMemo(
    () => stage === "reading" ? parseReadingProgress(readingReq.data) : null,
    [stage, readingReq.data],
  );
  return {
    setRow: set.list,
    set: set.body,
    offerRow: offer.list,
    offer: offer.body,
    comparisons: {
      value: byOption,
      loading: comparisonReq.loading,
      error: comparisonReq.error,
      refetch: comparisonReq.refetch,
    },
    comparisonsLimited: parsed.limited,
    reading,
  };
}

export type ComparisonRecord =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly error: string }
  | { readonly state: "read"; readonly reading: SwampifyComparisonReading };

/**
 * Comparison bodies, each read when first expanded and kept by data name.
 * A failed read can be asked for again.
 */
export function useComparisonRecords(): {
  readonly records: ReadonlyMap<string, ComparisonRecord>;
  readonly load: (row: SwampifyRow) => Promise<void>;
} {
  const { request } = useSwamp();
  const [records, setRecords] = useState<ReadonlyMap<string, ComparisonRecord>>(
    () => new Map(),
  );
  // Read synchronously, so two clicks before a re-render send one request.
  const asked = useRef(new Set<string>());
  const put = useCallback((name: string, value: ComparisonRecord) => {
    setRecords((current) => new Map(current).set(name, value));
  }, []);
  const load = useCallback(async (row: SwampifyRow) => {
    const key = comparisonKey(row);
    if (asked.current.has(key)) return;
    asked.current.add(key);
    put(key, { state: "loading" });
    try {
      const reply = await request("data.get", itemPayload(row));
      put(key, {
        state: "read",
        reading: parseComparisonReply(replyData(reply)),
      });
    } catch (error) {
      asked.current.delete(key);
      put(key, {
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [request, put]);
  return { records, load };
}

/**
 * The key `useComparisonRecords` keeps a row's body under: one per version,
 * so a rewritten comparison is read again when opened.
 */
export function comparisonKey(row: SwampifyRow): string {
  return swampifyRowKey(row);
}
