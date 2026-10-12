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

import { extractArray, extractTotal } from "./extract.ts";

export interface FetchAllPagesOptions {
  /** Items asked for per request. */
  pageSize?: number;
  /** Safety stop for a server whose `total` keeps moving. */
  maxPages?: number;
}

/**
 * Reads every page of a paged search (`{ data, total }` replies) so a list
 * is never silently cut at one page. Stops when `total` items arrived, a
 * page comes back short or empty, or the server reports no total.
 */
export async function fetchAllPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<unknown>,
  { pageSize = 500, maxPages = 50 }: FetchAllPagesOptions = {},
): Promise<{ items: T[]; total: number }> {
  const items: T[] = [];
  let total: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const reply = await fetchPage(items.length, pageSize);
    const batch = extractArray<T>(reply);
    total = extractTotal(reply);
    for (const item of batch) items.push(item);
    if (total === null || batch.length < pageSize || items.length >= total) {
      break;
    }
  }
  return { items, total: total ?? items.length };
}
