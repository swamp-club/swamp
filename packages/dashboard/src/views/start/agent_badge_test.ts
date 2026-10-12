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
import { agentMark } from "./agent_badge.ts";

const IDS = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "copilot",
  "kiro",
  "pi",
  "amp",
  "antigravity",
];

Deno.test("agentMark: every supported agent has its own initials and colour", () => {
  assertEquals(agentMark("claude"), { initials: "C", color: "#D97757" });
  assertEquals(agentMark("codex"), { initials: "Cx", color: "#10A37F" });
  const marks = IDS.map(agentMark);
  assertEquals(new Set(marks.map((m) => m.initials)).size, IDS.length);
  assertEquals(new Set(marks.map((m) => m.color)).size, IDS.length);
  for (const m of marks) {
    assertEquals(/^#[0-9A-F]{6}$/.test(m.color), true, m.color);
    assertNotEquals(m.initials, "");
  }
});

Deno.test("agentMark: an unknown agent gets its first letter on a neutral colour", () => {
  assertEquals(agentMark("zed"), { initials: "Z", color: "#5B6472" });
  assertEquals(agentMark("--"), { initials: "?", color: "#5B6472" });
});
