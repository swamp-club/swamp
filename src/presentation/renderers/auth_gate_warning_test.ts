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
import { renderAuthGateWarning } from "./auth_gate_warning.ts";

Deno.test("renderAuthGateWarning: JSON mode writes one JSON line to stderr", () => {
  const lines: string[] = [];
  renderAuthGateWarning("json", "Running offline", (line) => lines.push(line));
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), {
    warning: "Running offline",
    authMode: "offline",
  });
});

Deno.test("renderAuthGateWarning: log mode leaves stderr to the logger", () => {
  const lines: string[] = [];
  renderAuthGateWarning("log", "Running offline", (line) => lines.push(line));
  assertEquals(lines, []);
});
