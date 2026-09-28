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
import { createRequestSequence } from "./request_sequence.ts";

Deno.test("createRequestSequence: only the newest ticket is current", () => {
  const seq = createRequestSequence();
  const v4 = seq.next();
  const v5 = seq.next();
  assertEquals(seq.isCurrent(v4), false);
  assertEquals(seq.isCurrent(v5), true);
});

Deno.test("createRequestSequence: a late reply to an earlier request is dropped", () => {
  const seq = createRequestSequence();
  const applied: string[] = [];
  const first = seq.next();
  const second = seq.next();
  // The second reply lands first, then the first one arrives late.
  if (seq.isCurrent(second)) applied.push("v5");
  if (seq.isCurrent(first)) applied.push("v4");
  assertEquals(applied, ["v5"]);
});

Deno.test("createRequestSequence: invalidate retires the outstanding ticket", () => {
  const seq = createRequestSequence();
  const ticket = seq.next();
  seq.invalidate();
  assertEquals(seq.isCurrent(ticket), false);
});
