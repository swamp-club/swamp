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

import { getLogger } from "@logtape/logtape";
import type { LibSwampContext } from "../context.ts";
import { type SwampError, validationFailed } from "../errors.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

const logger = getLogger(["swamp", "data", "query"]);

/**
 * Projected data shape, determined by the first projected value's type.
 */
export type ProjectedData =
  | { shape: "scalar"; values: unknown[] }
  | { shape: "map"; columns: string[]; rows: Record<string, unknown>[] }
  | { shape: "list"; rows: unknown[][] };

/**
 * Points a query that matched no data instance name at the data whose spec
 * name it named. `suggestedPredicate` is a predicate that was verified to
 * match before it was suggested.
 */
export interface SpecNameHint {
  suggestedPredicate: string;
}

/**
 * Data payload for the completed event.
 */
export interface DataQueryData {
  predicate: string;
  select?: string;
  results: DataRecord[];
  projected?: ProjectedData;
  total: number;
  limited: boolean;
  /** Set only when nothing matched and the spec-name fallback does. */
  specNameHint?: SpecNameHint;
}

export type DataQueryEvent =
  | { kind: "resolving" }
  | { kind: "match"; record: DataRecord }
  | { kind: "projected_match"; value: unknown }
  | { kind: "completed"; data: DataQueryData }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the data query generator.
 */
export interface DataQueryDeps {
  query(
    predicate: string,
    options?: {
      limit?: number;
      select?: string;
      include?: (record: DataRecord) => Promise<boolean>;
    },
  ): Promise<DataRecord[] | unknown[]>;
  /**
   * Returns the spec-name counterpart of a predicate that matches one
   * instance name exactly, or null. Without it, no hint is offered.
   */
  specNameFallback?(predicate: string): string | null;
}

/**
 * Input for the data query generator.
 */
export interface DataQueryInput {
  predicate: string;
  select?: string;
  limit?: number;
  /**
   * Requires exactly one match: zero or several matches yield an error event
   * instead of `completed`. Cannot be combined with `limit`.
   */
  single?: boolean;
  /** Keeps only the matched records this accepts, before any projection. */
  include?: (record: DataRecord) => Promise<boolean>;
}

/**
 * Checks that a query matched exactly one data artifact. Returns the error to
 * report when it did not, or undefined when it did. Any count above one is
 * several matches; a missing count is none. A spec-name hint for a query that
 * matched nothing is carried into the no-match message.
 */
export function requireSingleResult(
  data: { predicate: string; total: number; specNameHint?: SpecNameHint },
): SwampError | undefined {
  if (data.total === 1) return undefined;
  if (data.total > 1) {
    return {
      code: "QUERY_MULTIPLE_MATCHES",
      message: "More than one data artifact matched the predicate:\n" +
        `  ${data.predicate}\n` +
        "Narrow it to one, for example by adding the data name or a version, " +
        "or run the query without --single to see the matches.",
    };
  }
  // Zero, or a count missing from a malformed server response.
  return {
    code: "QUERY_NO_MATCH",
    message: "No data artifact matched the predicate:\n" +
      `  ${data.predicate}\n` +
      "Check the names and values in it. Only each artifact's latest version " +
      "is matched unless the predicate names version or isLatest." +
      (data.specNameHint
        ? "\nNo data matched that instance name, but data with that spec " +
          `name exists. Match it with:\n  ${data.specNameHint.suggestedPredicate}`
        : ""),
  };
}

/**
 * Determines the projected data shape from the first value's type.
 */
function classifyProjection(
  value: unknown,
): "scalar" | "map" | "list" {
  if (Array.isArray(value)) return "list";
  if (value !== null && typeof value === "object") return "map";
  return "scalar";
}

/**
 * Checks whether a query that matched nothing would match by spec name. The
 * probe applies the caller's `include`, so the hint never reveals data the
 * caller may not read. A failed probe only omits the hint.
 */
async function findSpecNameHint(
  deps: DataQueryDeps,
  input: DataQueryInput,
): Promise<SpecNameHint | undefined> {
  const fallback = deps.specNameFallback?.(input.predicate);
  if (!fallback) return undefined;
  try {
    const matches = await deps.query(fallback, {
      limit: 1,
      include: input.include,
    });
    return matches.length > 0 ? { suggestedPredicate: fallback } : undefined;
  } catch (error) {
    logger.debug`Spec-name fallback query ${fallback} failed: ${error}`;
    return undefined;
  }
}

/**
 * Queries data artifacts using a CEL predicate, with optional projection.
 */
export async function* dataQuery(
  _ctx: LibSwampContext,
  deps: DataQueryDeps,
  input: DataQueryInput,
): AsyncGenerator<DataQueryEvent> {
  yield* withGeneratorSpan(
    "swamp.data.query",
    { "query.predicate": input.predicate },
    (async function* () {
      yield { kind: "resolving" as const };

      if (input.single && input.limit !== undefined) {
        yield {
          kind: "error" as const,
          error: validationFailed(
            "A single-result query cannot also set a limit.",
          ),
        };
        return;
      }

      // Unlimited by default — callers pass an explicit limit when they
      // need a cap. `limited` in the completed event reflects whether
      // the query service actually hit the supplied limit. A single-result
      // query stays unlimited: the query service applies a limit before it
      // drops stale catalog rows, so a limit of 2 could keep one live match
      // and miss a second, reporting it as the only one.
      const limit = input.single ? undefined : input.limit;

      try {
        const rawResults = await deps.query(input.predicate, {
          limit,
          select: input.select,
          include: input.include,
        });
        const total = rawResults.length;
        const limited = limit !== undefined && total >= limit;
        const specNameHint = total === 0
          ? await findSpecNameHint(deps, input)
          : undefined;
        const hint = specNameHint ? { specNameHint } : {};

        if (input.single) {
          const error = requireSingleResult({
            predicate: input.predicate,
            total,
            specNameHint,
          });
          if (error) {
            yield { kind: "error" as const, error };
            return;
          }
        }

        if (!input.select) {
          // No projection — results are DataRecord[]
          const results = rawResults as DataRecord[];
          for (const record of results) {
            yield { kind: "match" as const, record };
          }
          yield {
            kind: "completed" as const,
            data: {
              predicate: input.predicate,
              results,
              total,
              limited,
              ...hint,
            },
          };
          return;
        }

        // Projected results — classify shape for the renderer
        const projected = rawResults as unknown[];
        for (const value of projected) {
          yield { kind: "projected_match" as const, value };
        }

        // Find first non-null value to determine shape — null values come
        // from records where the projection failed (e.g. missing attribute key)
        const firstNonNull = projected.find((v) => v != null);
        const shape = firstNonNull !== undefined
          ? classifyProjection(firstNonNull)
          : "scalar";

        let projectedData: ProjectedData;
        switch (shape) {
          case "map": {
            const firstObj = firstNonNull as Record<string, unknown>;
            const columns = Object.keys(firstObj);
            const rows = projected.map((v) =>
              (v ?? {}) as Record<string, unknown>
            );
            projectedData = { shape: "map", columns, rows };
            break;
          }
          case "list": {
            const rows = projected.map((v) => v as unknown[]);
            projectedData = { shape: "list", rows };
            break;
          }
          default: {
            projectedData = { shape: "scalar", values: projected };
            break;
          }
        }

        yield {
          kind: "completed" as const,
          data: {
            predicate: input.predicate,
            select: input.select,
            results: [],
            projected: projectedData,
            total,
            limited,
            ...hint,
          },
        };
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "QUERY_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })(),
  );
}
