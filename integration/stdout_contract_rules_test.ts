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
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
import { VALUE_ONLY_STDOUT_COMMANDS } from "../src/cli/stdout_contract.ts";
import { inviteCommand } from "../src/cli/commands/invite.ts";
import { firstRuleCommand } from "../src/cli/commands/invite_link.ts";
import { vaultCommand } from "../src/cli/commands/vault.ts";

// Importing the command modules pulls in the CLI command tree, which needs
// logging initialised and the model barrel loaded before it will construct.
await initializeLogging({});

// Cliffy's Command carries eight generic parameters that change with every
// chained call; cli_schema.ts already owns the relaxed alias for exactly this
// reason, so reuse it rather than opening a second escape hatch here.
type Resolvable = AnyCommand & {
  getName(): string;
  getCommand(name: string): AnyCommand | undefined;
};

/**
 * Top-level commands that registry entries are resolved against.
 *
 * Deliberately resolved through the exported command objects rather than
 * `buildCliSchema`: that walker excludes hidden commands, and `first-rule` is
 * registered `.hidden()` — so a schema-based check would silently skip the one
 * entry most likely to be renamed, which is the opposite of what this test is
 * for.
 */
const ROOTS: Record<string, Resolvable> = {
  invite: inviteCommand as unknown as Resolvable,
  vault: vaultCommand as unknown as Resolvable,
  "first-rule": firstRuleCommand as unknown as Resolvable,
};

Deno.test("every value-on-stdout registry entry names a registered command", () => {
  const unresolved: string[] = [];

  for (const path of VALUE_ONLY_STDOUT_COMMANDS) {
    const [command, subcommand] = path;
    const root = ROOTS[command];

    if (root === undefined) {
      unresolved.push(
        `${path.join(" ")} — no top-level command "${command}" is registered ` +
          `here; add it to ROOTS in this test if the command tree changed`,
      );
      continue;
    }

    if (subcommand === undefined) {
      if (root.getName() !== command) {
        unresolved.push(
          `${path.join(" ")} — command is registered as "${root.getName()}"`,
        );
      }
      continue;
    }

    if (root.getCommand(subcommand) === undefined) {
      unresolved.push(
        `${path.join(" ")} — "${command}" has no subcommand "${subcommand}"`,
      );
    }
  }

  // A registry entry that names nothing is worse than no entry at all: the
  // lookup in runCli just misses, `stderrOnly` stays off, and the only symptom
  // is a log line in whatever the user was piping (swamp-club#2254).
  assertEquals(
    unresolved,
    [],
    `stdout_contract.ts lists commands that do not exist:\n  ${
      unresolved.join("\n  ")
    }`,
  );
});
