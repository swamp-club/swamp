// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { useEffect, useRef, useState } from "react";
import {
  createLibSwampContext,
  dataQuery,
  type DataQueryDeps,
  type DataRecord,
  type ProjectedData,
} from "../../../../libswamp/mod.ts";

export interface QueryState {
  results: DataRecord[];
  projected?: ProjectedData;
  error: string | null;
  isLoading: boolean;
  elapsedMs: number;
  total: number;
  limited: boolean;
}

const INITIAL_STATE: QueryState = {
  results: [],
  projected: undefined,
  error: null,
  isLoading: false,
  elapsedMs: 0,
  total: 0,
  limited: false,
};

/**
 * Hook that debounces query execution and manages result state.
 *
 * On each change to predicate or select, waits `debounceMs` then:
 * 1. Aborts the previous in-flight query
 * 2. Creates a fresh AbortController + LibSwampContext
 * 3. Invokes the dataQuery() generator and consumes events
 * 4. Updates state on completion or error
 */
export function useDebouncedQuery(
  predicate: string,
  select: string | undefined,
  queryDeps: DataQueryDeps,
  debounceMs: number = 150,
  limit: number = 100,
): QueryState {
  const [state, setState] = useState<QueryState>(INITIAL_STATE);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!predicate.trim()) {
      setState(INITIAL_STATE);
      return;
    }

    const generation = ++generationRef.current;

    const timer = setTimeout(async () => {
      // Abort any in-flight query
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setState((prev) => ({ ...prev, isLoading: true, error: null }));
      const start = performance.now();

      try {
        const ctx = createLibSwampContext({ signal: controller.signal });
        const stream = dataQuery(ctx, queryDeps, {
          predicate,
          select: select?.trim() || undefined,
          limit,
        });

        const records: DataRecord[] = [];
        let completed = false;

        for await (const event of stream) {
          // Stale generation — stop processing
          if (generationRef.current !== generation) break;

          switch (event.kind) {
            case "match":
              records.push(event.record);
              break;
            case "completed":
              completed = true;
              setState({
                results: event.data.results.length > 0
                  ? event.data.results
                  : records,
                projected: event.data.projected,
                error: null,
                isLoading: false,
                elapsedMs: performance.now() - start,
                total: event.data.total,
                limited: event.data.limited,
              });
              break;
            case "error":
              if (event.error.code === "cancelled") {
                // Silently discard — user typed something new
                return;
              }
              setState((prev) => ({
                ...prev,
                error: event.error.message,
                isLoading: false,
                elapsedMs: performance.now() - start,
              }));
              break;
          }
        }

        if (!completed && generationRef.current === generation) {
          setState((prev) => ({ ...prev, isLoading: false }));
        }
      } catch (err) {
        if (
          err instanceof DOMException && err.name === "AbortError"
        ) {
          return; // Cancelled, ignore
        }
        if (generationRef.current === generation) {
          setState((prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : String(err),
            isLoading: false,
            elapsedMs: performance.now() - start,
          }));
        }
      }
    }, debounceMs);

    return () => {
      clearTimeout(timer);
    };
  }, [predicate, select, debounceMs, limit]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  return state;
}
