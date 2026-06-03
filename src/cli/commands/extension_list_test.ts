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
import { shouldEnrich } from "./extension_list.ts";

Deno.test("shouldEnrich: --check-updates forces on", () => {
  assertEquals(
    shouldEnrich({
      checkUpdates: true,
      outputMode: "json",
      isTerminal: () => false,
    }),
    true,
  );
});

Deno.test("shouldEnrich: --no-check-updates forces off", () => {
  assertEquals(
    shouldEnrich({
      checkUpdates: false,
      outputMode: "log",
      isTerminal: () => true,
    }),
    false,
  );
});

Deno.test("shouldEnrich: json mode defaults off even on TTY", () => {
  assertEquals(
    shouldEnrich({
      checkUpdates: undefined,
      outputMode: "json",
      isTerminal: () => true,
    }),
    false,
  );
});

Deno.test("shouldEnrich: log mode + TTY defaults on", () => {
  assertEquals(
    shouldEnrich({
      checkUpdates: undefined,
      outputMode: "log",
      isTerminal: () => true,
    }),
    true,
  );
});

Deno.test("shouldEnrich: log mode + non-TTY defaults off", () => {
  assertEquals(
    shouldEnrich({
      checkUpdates: undefined,
      outputMode: "log",
      isTerminal: () => false,
    }),
    false,
  );
});
