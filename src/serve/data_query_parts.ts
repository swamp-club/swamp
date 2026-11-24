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

import type { DataRecord } from "../domain/data/data_record.ts";
import { UserError } from "../domain/errors.ts";
import type { DataQueryData } from "../libswamp/data/query.ts";

// well under the WebSocket frame cap even when escaping multiplies the estimate
export const QUERY_PART_BUDGET_BYTES = 4 * 1024 * 1024;

/** the matches a reply carries: records, or the projected values or rows */
export function queryItems(data: DataQueryData): readonly unknown[] {
  if (data.projected === undefined) return data.results;
  return data.projected.shape === "scalar"
    ? data.projected.values
    : data.projected.rows;
}

/** a copy of data carrying items in place of its matches */
export function withQueryItems(
  data: DataQueryData,
  items: unknown[],
): DataQueryData {
  const projected = data.projected;
  if (projected === undefined) {
    return { ...data, results: items as DataRecord[] };
  }
  switch (projected.shape) {
    case "scalar":
      return { ...data, projected: { ...projected, values: items } };
    case "map":
      return {
        ...data,
        projected: { ...projected, rows: items as Record<string, unknown>[] },
      };
    case "list":
      return {
        ...data,
        projected: { ...projected, rows: items as unknown[][] },
      };
  }
}

/** a rough size of value as JSON, without serializing it; stops once past cap */
export function estimateJsonBytes(value: unknown, cap: number): number {
  let total = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0 && total <= cap) {
    const next = pending.pop();
    if (typeof next === "string") {
      total += next.length + 2;
    } else if (Array.isArray(next)) {
      total += 2 + next.length;
      for (const element of next) pending.push(element);
    } else if (next !== null && typeof next === "object") {
      if (typeof (next as { toJSON?: unknown }).toJSON === "function") {
        total += 32;
        continue;
      }
      total += 2;
      for (const [key, entry] of Object.entries(next)) {
        total += key.length + 4;
        pending.push(entry);
      }
    } else {
      total += 24;
    }
  }
  return total;
}

/** items in order, in batches of about budget bytes; an item over it goes alone */
export function* queryPartBatches(
  items: readonly unknown[],
  budget: number = QUERY_PART_BUDGET_BYTES,
): Generator<unknown[]> {
  let batch: unknown[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = estimateJsonBytes(item, budget);
    if (batch.length > 0 && bytes + size > budget) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}

/** names a match for an error: the record, or its position when projected */
export function describeQueryItem(item: unknown, index: number): string {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const record = item as Partial<DataRecord>;
    if (
      typeof record.modelName === "string" && typeof record.name === "string" &&
      typeof record.version === "number"
    ) {
      return `${record.modelName}/${record.name} version ${record.version}`;
    }
  }
  return `match ${index + 1}`;
}

/**
 * the reply the parts were cut from; a count that differs from partItems means
 * the parts were not all received, and is refused rather than shown short
 */
export function assembleQueryReply(
  summary: DataQueryData,
  parts: readonly unknown[],
  partItems: number,
): DataQueryData {
  const items: unknown[] = [];
  for (const part of parts) {
    const batch = part !== null && typeof part === "object"
      ? (part as { items?: unknown }).items
      : undefined;
    if (!Array.isArray(batch)) {
      throw new UserError(
        "The server sent a query result part without items. Run the query again.",
      );
    }
    for (const item of batch) items.push(item);
  }
  if (items.length !== partItems) {
    throw new UserError(
      `The server sent ${items.length} of the ${partItems} query results it reported. Run the query again.`,
    );
  }
  return withQueryItems(summary, items);
}
