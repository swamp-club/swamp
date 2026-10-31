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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { VirtualRows, visibleWindow } from "./VirtualRows.tsx";

Deno.test("visibleWindow: the rows in view plus overscan", () => {
  assertEquals(visibleWindow(0, 100, 20, 500, 2), { first: 0, end: 7 });
  assertEquals(visibleWindow(1000, 100, 20, 500, 2), { first: 48, end: 57 });
  assertEquals(visibleWindow(99999, 100, 20, 500, 2).end, 500);
  assertEquals(visibleWindow(0, 100, 20, 0), { first: 0, end: 0 });
});

Deno.test("visibleWindow: always a bounded slice of the rows", () => {
  fc.assert(fc.property(
    fc.integer({ min: -1000, max: 1_000_000 }),
    fc.integer({ min: 0, max: 5000 }),
    fc.integer({ min: 1, max: 200 }),
    fc.integer({ min: 0, max: 20_000 }),
    (scrollTop, height, rowHeight, count) => {
      const { first, end } = visibleWindow(scrollTop, height, rowHeight, count);
      assert(0 <= first && first <= end && end <= count);
      assert(end - first <= Math.ceil(height / rowHeight) + 2 * 8 + 1);
    },
  ));
});

Deno.test("VirtualRows: renders only the first window of a long list", () => {
  const html = renderToStaticMarkup(
    <VirtualRows
      count={1000}
      rowHeight={24}
      height={240}
      label="calls"
      renderRow={(i) => <span>row-{i}</span>}
    />,
  );
  assert(html.includes("row-0"));
  assert(html.includes("row-17"));
  assert(!html.includes("row-18<"));
  assert(!html.includes("row-999"));
  assert(html.includes('aria-rowcount="1000"'));
});
