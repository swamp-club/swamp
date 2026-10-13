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
import { fetchAllPages } from "./fetch_all_pages.ts";

function server(count: number) {
  const calls: Array<[number, number]> = [];
  const all = Array.from({ length: count }, (_, i) => ({ runId: `r${i}` }));
  const fetchPage = (offset: number, limit: number) => {
    calls.push([offset, limit]);
    return Promise.resolve({
      data: { results: all.slice(offset, offset + limit) },
      total: all.length,
    });
  };
  return { calls, fetchPage };
}

Deno.test("fetchAllPages: one request when everything fits", async () => {
  const s = server(3);
  const { items, total } = await fetchAllPages(s.fetchPage, { pageSize: 5 });
  assertEquals(items.length, 3);
  assertEquals(total, 3);
  assertEquals(s.calls, [[0, 5]]);
});

Deno.test("fetchAllPages: follows total across pages so nothing is dropped", async () => {
  const s = server(12);
  const { items } = await fetchAllPages<{ runId: string }>(s.fetchPage, {
    pageSize: 5,
  });
  assertEquals(items.map((i) => i.runId), [
    ...Array.from({ length: 12 }, (_, i) => `r${i}`),
  ]);
  assertEquals(s.calls, [[0, 5], [5, 5], [10, 5]]);
});

Deno.test("fetchAllPages: stops at maxPages and without a total", async () => {
  const s = server(100);
  const capped = await fetchAllPages(s.fetchPage, { pageSize: 5, maxPages: 2 });
  assertEquals(capped.items.length, 10);
  assertEquals(capped.total, 100);
  let calls = 0;
  const untotalled = await fetchAllPages(() => {
    calls++;
    return Promise.resolve({ data: { results: [1, 2] } });
  }, { pageSize: 2 });
  assertEquals(untotalled.items, [1, 2]);
  assertEquals(calls, 1);
});
