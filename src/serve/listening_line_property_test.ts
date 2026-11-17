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
import fc from "fast-check";
import {
  formatListeningLine,
  parseListeningLine,
  type ServeListeningLine,
} from "./listening_line.ts";

const arbLine: fc.Arbitrary<ServeListeningLine> = fc.record({
  host: fc.string(),
  port: fc.integer({ min: 1, max: 65_535 }),
  url: fc.string(),
  schedulingEnabled: fc.boolean(),
  detachRuns: fc.boolean(),
  mode: fc.constantFrom("local", "durable", "durable (limited)"),
  authMode: fc.constantFrom("none", "token", "oauth"),
});

Deno.test("parseListeningLine: any formatted line parses back to its port and auth mode", () => {
  fc.assert(
    fc.property(arbLine, (line) => {
      assertEquals(parseListeningLine(formatListeningLine(line)), {
        port: line.port,
        authMode: line.authMode,
      });
    }),
  );
});

Deno.test("parseListeningLine: never throws, and answers null or a valid port", () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.json()), (line) => {
      const parsed = parseListeningLine(line);
      if (parsed === null) return;
      assertEquals(Number.isInteger(parsed.port), true);
      assertEquals(parsed.port > 0 && parsed.port < 65_536, true);
    }),
  );
});
