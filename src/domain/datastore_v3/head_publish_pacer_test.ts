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
import {
  HEAD_PUBLISH_INTERVAL_MS,
  HeadPublishPacer,
} from "./head_publish_pacer.ts";

Deno.test("HeadPublishPacer: the first head goes out at once", () => {
  assertEquals(new HeadPublishPacer().waitMs(5_000), 0);
});

Deno.test("HeadPublishPacer: a head inside the interval waits out the rest of it", () => {
  const pacer = new HeadPublishPacer();
  pacer.attempted(10_000);
  assertEquals(pacer.waitMs(10_000), HEAD_PUBLISH_INTERVAL_MS);
  assertEquals(pacer.waitMs(10_500), HEAD_PUBLISH_INTERVAL_MS - 500);
  assertEquals(pacer.waitMs(10_000 + HEAD_PUBLISH_INTERVAL_MS), 0);
});

Deno.test("HeadPublishPacer: a head after an idle interval goes out at once", () => {
  const pacer = new HeadPublishPacer();
  pacer.attempted(10_000);
  assertEquals(pacer.waitMs(10_000 + HEAD_PUBLISH_INTERVAL_MS + 1), 0);
});

Deno.test("HeadPublishPacer: an attempt reported late never moves the window back", () => {
  const pacer = new HeadPublishPacer(1_000);
  pacer.attempted(20_000);
  pacer.attempted(19_000);
  assertEquals(pacer.waitMs(20_500), 500);
});

Deno.test("HeadPublishPacer: the interval keeps clear of GCS's one write a second", () => {
  assertEquals(HEAD_PUBLISH_INTERVAL_MS > 1_000, true);
});
