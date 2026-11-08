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
  HEAD_PACING_COOL_DOWN_MS,
  HEAD_PUBLISH_INTERVAL_MS,
  HeadPublishPacer,
} from "./head_publish_pacer.ts";

Deno.test("HeadPublishPacer: back-to-back heads go out at once while the bucket has refused none", () => {
  const pacer = new HeadPublishPacer();
  pacer.attempted(10_000);
  assertEquals(pacer.pacing(10_001), false);
  assertEquals(pacer.waitMs(10_001), 0);
});

Deno.test("HeadPublishPacer: after a refusal a head inside the interval waits out the rest of it", () => {
  const pacer = new HeadPublishPacer();
  pacer.attempted(10_000);
  pacer.rateLimited(10_050);
  assertEquals(pacer.pacing(10_100), true);
  assertEquals(pacer.waitMs(10_100), HEAD_PUBLISH_INTERVAL_MS - 100);
  assertEquals(pacer.waitMs(10_000 + HEAD_PUBLISH_INTERVAL_MS), 0);
});

Deno.test("HeadPublishPacer: pacing ends a cool-down after the last refusal, and a new refusal extends it", () => {
  const pacer = new HeadPublishPacer();
  pacer.rateLimited(0);
  pacer.attempted(HEAD_PACING_COOL_DOWN_MS - 100);
  assertEquals(pacer.waitMs(HEAD_PACING_COOL_DOWN_MS - 50) > 0, true);
  assertEquals(pacer.pacing(HEAD_PACING_COOL_DOWN_MS), false);
  assertEquals(pacer.waitMs(HEAD_PACING_COOL_DOWN_MS), 0);
  pacer.rateLimited(HEAD_PACING_COOL_DOWN_MS + 10);
  pacer.attempted(HEAD_PACING_COOL_DOWN_MS + 10);
  assertEquals(pacer.waitMs(HEAD_PACING_COOL_DOWN_MS + 20) > 0, true);
});

Deno.test("HeadPublishPacer: a failed attempt still spaces the next while pacing", () => {
  const pacer = new HeadPublishPacer(1_000, 30_000);
  pacer.rateLimited(0);
  pacer.attempted(5_000);
  assertEquals(pacer.waitMs(5_400), 600);
});

Deno.test("HeadPublishPacer: a report that arrives late never moves either window back", () => {
  const pacer = new HeadPublishPacer(1_000, 30_000);
  pacer.rateLimited(20_000);
  pacer.rateLimited(1_000);
  pacer.attempted(20_000);
  pacer.attempted(19_000);
  assertEquals(pacer.pacing(45_000), true);
  assertEquals(pacer.waitMs(20_500), 500);
});

Deno.test("HeadPublishPacer: waitWithin skips a wait that would leave the sync too little time", () => {
  const pacer = new HeadPublishPacer(1_200, 30_000);
  pacer.rateLimited(0);
  pacer.attempted(0);
  assertEquals(pacer.waitWithin(0, 10_000, 500), 1_200);
  assertEquals(pacer.waitWithin(0, 1_600, 500), 0);
  assertEquals(pacer.waitWithin(0, 600, 500), 0);
});

Deno.test("HeadPublishPacer: the interval keeps clear of GCS's one write a second", () => {
  assertEquals(HEAD_PUBLISH_INTERVAL_MS > 1_000, true);
});
