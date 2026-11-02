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
import { centerScrollTop, revealScrollTop, scrollBehavior } from "./jump.ts";

Deno.test("scrollBehavior: no smooth scrolling when the user asks for less motion", () => {
  assertEquals(scrollBehavior(true), "auto");
  assertEquals(scrollBehavior(false), "smooth");
});

const view = { top: 100, height: 300, scrollTop: 500, header: 40 };

Deno.test("revealScrollTop: a row in full view below the header stays put", () => {
  assertEquals(revealScrollTop(view, { top: 140, height: 40 }), null);
  assertEquals(revealScrollTop(view, { top: 360, height: 40 }), null);
});

Deno.test("revealScrollTop: a row under the header or above the box scrolls down to it", () => {
  assertEquals(revealScrollTop(view, { top: 120, height: 40 }), 480);
  assertEquals(revealScrollTop(view, { top: -200, height: 40 }), 160);
  assertEquals(
    revealScrollTop({ ...view, scrollTop: 10 }, { top: -200, height: 40 }),
    0,
  );
});

Deno.test("revealScrollTop: a row below the box scrolls up to its bottom edge", () => {
  assertEquals(revealScrollTop(view, { top: 420, height: 40 }), 560);
});

Deno.test("revealScrollTop: a row taller than the box keeps its top below the header", () => {
  assertEquals(revealScrollTop(view, { top: 200, height: 1000 }), 560);
});

Deno.test("centerScrollTop: centres a row below the sticky header", () => {
  // 200px of room under a 40px header; a 40px row at offset 600 centres
  // with 80px above it.
  assertEquals(
    centerScrollTop({ clientHeight: 240, header: 40 }, {
      offset: 600,
      height: 40,
    }),
    600 - 40 - 80,
  );
});

Deno.test("centerScrollTop: a row near the top cannot scroll above zero", () => {
  assertEquals(
    centerScrollTop({ clientHeight: 240, header: 40 }, {
      offset: 40,
      height: 40,
    }),
    0,
  );
});
