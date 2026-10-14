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
import { extractSearchWindow, extractTotal } from "./extract.ts";

Deno.test("extractTotal: reads total beside data in a paged response", () => {
  assertEquals(extractTotal({ data: { results: [] }, total: 42 }), 42);
});

Deno.test("extractTotal: returns null when the server reports no total", () => {
  assertEquals(extractTotal({ data: { results: [] } }), null);
  assertEquals(extractTotal({ total: "42" }), null);
  assertEquals(extractTotal(null), null);
});

Deno.test("extractSearchWindow: reads since and the oldest start beside data", () => {
  assertEquals(
    extractSearchWindow({
      data: { results: [] },
      total: 3,
      since: "2026-10-14T17:00:00.000Z",
      oldestStartedAt: "2026-10-14T17:20:00.000Z",
    }),
    {
      since: "2026-10-14T17:00:00.000Z",
      oldestStartedAt: "2026-10-14T17:20:00.000Z",
    },
  );
});

Deno.test("extractSearchWindow: an older serve's response has no window", () => {
  assertEquals(extractSearchWindow({ data: { results: [] }, total: 3 }), {});
  assertEquals(extractSearchWindow({ since: 5, oldestStartedAt: null }), {});
  assertEquals(extractSearchWindow(null), {});
});
