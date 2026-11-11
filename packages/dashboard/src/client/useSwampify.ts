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
 * The Swampify panel's requests. Payloads and parsing live in `swampify.ts`;
 * this file only sends them.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useRequest } from "./useRequest.ts";
import { useSwamp } from "./SwampProvider.tsx";
import { replyData } from "./agent_sessions.ts";
import {
  candidateSetListPayload,
  candidateSetProbePayload,
  comparisonListPayload,
  comparisonsByOption,
  itemPayload,
  offerListPayload,
  parseCandidateSetReply,
  parseComparisonReply,
  parseOfferReply,
  parseSwampifyRows,
  shownCandidateSet,
  shownOffer,
  type SwampifyRow,
} from "./swampify.ts";
import type {
  SwampifyCandidateSetReading,
  SwampifyComparisonReading,
  SwampifyOfferReading,
} from "../lib/agent_sessions/swampify.ts";

/** Whether the viewer can read at least one candidate set: one query, limit 1. */
export function useCandidateSetVisible(): boolean {
  const probe = useRequest("data.query", candidateSetProbePayload());
  return parseSwampifyRows(replyData(probe.data)).rows.length > 0;
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
} {
  const listReq = useRequest("data.query", listPayload);
  const row = useMemo(
    () => pick(parseSwampifyRows(replyData(listReq.data)).rows),
    [listReq.data],
  );
  const bodyReq = useRequest(
    "data.get",
    row ? itemPayload(row) : undefined,
    { enabled: row !== undefined },
  );
  const reading = useMemo(
    () => (bodyReq.data ? parse(replyData(bodyReq.data)) : null),
    [bodyReq.data],
  );
  return {
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

/** The key `useComparisonRecords` keeps a row's body under. */
export function comparisonKey(row: SwampifyRow): string {
  return `${row.modelName}/${row.name}`;
}
