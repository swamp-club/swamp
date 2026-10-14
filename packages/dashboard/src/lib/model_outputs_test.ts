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

import { assertEquals, assertNotEquals } from "@std/assert";
import { modelOutputPayloads } from "./model_outputs.ts";
import type { TimeRange } from "../client/time_range.ts";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 14, 16, 0, 0);

Deno.test("modelOutputPayloads: a preset sends a duration that stays the same across a minute rollover", () => {
  const range: TimeRange = { kind: "preset", preset: "7d" };
  const payload = { model: "my-model", limit: 200 };
  const before = modelOutputPayloads(range, payload, NOW);
  const after = modelOutputPayloads(range, payload, NOW + MINUTE);

  assertEquals(before.current, { model: "my-model", limit: 200, since: "7d" });
  assertEquals(after.current, before.current);
  // The fallback for an older serve carries the ISO bound, which moves.
  assertEquals(before.legacy, {
    model: "my-model",
    limit: 200,
    since: "2026-10-07T16:00:00.000Z",
  });
  assertNotEquals(after.legacy, before.legacy);
});

Deno.test("modelOutputPayloads: a custom range sends its ISO bounds and needs no fallback", () => {
  const range: TimeRange = {
    kind: "custom",
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-02T00:00:00.000Z",
  };
  assertEquals(modelOutputPayloads(range, { limit: 5 }, NOW), {
    current: {
      limit: 5,
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-10-02T00:00:00.000Z",
    },
    legacy: null,
  });
});

Deno.test("modelOutputPayloads: all time sends no bounds and needs no fallback", () => {
  assertEquals(
    modelOutputPayloads({ kind: "preset", preset: "all" }, { limit: 5 }, NOW),
    { current: { limit: 5 }, legacy: null },
  );
});
