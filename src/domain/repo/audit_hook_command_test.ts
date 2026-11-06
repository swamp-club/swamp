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
  isKiroAuditCommand,
  isKiroAuditHookEntry,
  isSwampAuditCommand,
  swampAuditCommandPattern,
} from "./audit_hook_command.ts";

const CLAUDE = swampAuditCommandPattern("(?: --tool claude)?");
const CURSOR = swampAuditCommandPattern(" --tool cursor");

Deno.test("isSwampAuditCommand: accepts each spelling of the swamp binary", () => {
  for (
    const binary of [
      "swamp",
      '"swamp"',
      '"/usr/local/bin/swamp"',
      '"C:\\Program Files\\swamp\\swamp.exe"',
      "/usr/local/bin/swamp",
      "C:\\tools\\swamp.exe",
      "./swamp",
    ]
  ) {
    assertEquals(
      isSwampAuditCommand(`${binary} audit record --from-hook`, CLAUDE),
      true,
      binary,
    );
  }
});

Deno.test("isSwampAuditCommand: trims surrounding whitespace", () => {
  assertEquals(
    isSwampAuditCommand("  swamp audit record --from-hook\n", CLAUDE),
    true,
  );
});

Deno.test("isSwampAuditCommand: rejects a command the user extended", () => {
  for (
    const command of [
      "swamp audit record --from-hook && echo done",
      "swamp audit record --from-hook --verbose",
      "env X=1 swamp audit record --from-hook",
      "echo swamp audit record --from-hook",
      "notswamp audit record --from-hook",
      '"/usr/bin/swamp-wrapper" audit record --from-hook',
    ]
  ) {
    assertEquals(isSwampAuditCommand(command, CLAUDE), false, command);
  }
});

Deno.test("isSwampAuditCommand: rejects a command that is not a string", () => {
  assertEquals(isSwampAuditCommand(undefined, CLAUDE), false);
  assertEquals(isSwampAuditCommand(42, CLAUDE), false);
  assertEquals(
    isSwampAuditCommand(["swamp audit record --from-hook"], CLAUDE),
    false,
  );
});

Deno.test("swampAuditCommandPattern: the claude suffix is optional", () => {
  assertEquals(
    isSwampAuditCommand("swamp audit record --from-hook", CLAUDE),
    true,
  );
  assertEquals(
    isSwampAuditCommand("swamp audit record --from-hook --tool claude", CLAUDE),
    true,
  );
  assertEquals(
    isSwampAuditCommand("swamp audit record --from-hook --tool cursor", CLAUDE),
    false,
  );
});

Deno.test("swampAuditCommandPattern: a tool suffix is required and exact", () => {
  assertEquals(
    isSwampAuditCommand("swamp audit record --from-hook --tool cursor", CURSOR),
    true,
  );
  assertEquals(
    isSwampAuditCommand("swamp audit record --from-hook", CURSOR),
    false,
  );
  assertEquals(
    isSwampAuditCommand(
      "swamp audit record --from-hook --tool copilot",
      CURSOR,
    ),
    false,
  );
});

Deno.test("isKiroAuditCommand: matches only the kiro audit command", () => {
  assertEquals(
    isKiroAuditCommand("swamp audit record --from-hook --tool kiro"),
    true,
  );
  assertEquals(isKiroAuditCommand("swamp audit record --from-hook"), false);
});

Deno.test("isKiroAuditHookEntry: accepts both trigger spellings", () => {
  const action = { command: "swamp audit record --from-hook --tool kiro" };
  assertEquals(isKiroAuditHookEntry({ trigger: "PostToolUse", action }), true);
  assertEquals(isKiroAuditHookEntry({ trigger: "postToolUse", action }), true);
});

Deno.test("isKiroAuditHookEntry: rejects other triggers and malformed entries", () => {
  const action = { command: "swamp audit record --from-hook --tool kiro" };
  assertEquals(isKiroAuditHookEntry({ trigger: "PreToolUse", action }), false);
  assertEquals(isKiroAuditHookEntry({ trigger: "PostToolUse" }), false);
  assertEquals(isKiroAuditHookEntry(null), false);
  assertEquals(isKiroAuditHookEntry("PostToolUse"), false);
});
