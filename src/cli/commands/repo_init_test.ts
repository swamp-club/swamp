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

import { assertEquals, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { resolveToolFlag, ToolNameType } from "./repo_init.ts";
import { UserError } from "../../domain/errors.ts";
import { VALID_AI_TOOLS } from "../ai_tool_parser.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("repoCommand module loads", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  assertEquals(repoCommand.getName(), "repo");
});

Deno.test("repoInitCommand is registered as visible subcommand", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  const visibleCommands = repoCommand.getCommands();
  const visibleInit = visibleCommands.find((c) => c.getName() === "init");
  assertEquals(
    visibleInit !== undefined,
    true,
    "init should appear in visible commands",
  );
});

Deno.test("repoInitCommand offers --no-vault to skip the default vault", async () => {
  const { repoInitCommand } = await import("./repo_init.ts");
  const option = repoInitCommand.getOption("no-vault");
  assertEquals(option?.flags, ["--no-vault"]);
});

Deno.test("repoInitCommand: --tool help lists every built-in tool", async () => {
  const { repoInitCommand } = await import("./repo_init.ts");
  const description = repoInitCommand.getOption("tool")?.description ?? "";
  for (const tool of VALID_AI_TOOLS) {
    assertEquals(
      description.includes(tool),
      true,
      `--tool help should list ${tool}: ${description}`,
    );
  }
});

Deno.test("ToolNameType: completes every built-in tool", () => {
  assertEquals(new ToolNameType().complete(), [...VALID_AI_TOOLS]);
});

Deno.test("repoUpgradeCommand is registered as subcommand", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  const commands = repoCommand.getCommands();
  const upgradeCmd = commands.find((c) => c.getName() === "upgrade");
  assertEquals(upgradeCmd !== undefined, true);
});

Deno.test("resolveToolFlag returns undefined when --tool is not given", () => {
  assertEquals(resolveToolFlag(undefined), undefined);
});

Deno.test("resolveToolFlag returns the tool list as-is for a single value", () => {
  assertEquals(resolveToolFlag(["claude"]), ["claude"]);
});

Deno.test("resolveToolFlag preserves order across multiple values", () => {
  assertEquals(resolveToolFlag(["claude", "kiro", "opencode"]), [
    "claude",
    "kiro",
    "opencode",
  ]);
});

Deno.test("resolveToolFlag dedupes repeated values", () => {
  assertEquals(resolveToolFlag(["claude", "claude", "kiro"]), [
    "claude",
    "kiro",
  ]);
});

Deno.test("resolveToolFlag translates --tool none into an empty list", () => {
  assertEquals(resolveToolFlag(["none"]), []);
});

Deno.test("resolveToolFlag rejects --tool none combined with other tools", () => {
  assertThrows(
    () => resolveToolFlag(["none", "claude"]),
    UserError,
    "Cannot combine --tool none",
  );
  assertThrows(
    () => resolveToolFlag(["claude", "none"]),
    UserError,
    "Cannot combine --tool none",
  );
});
