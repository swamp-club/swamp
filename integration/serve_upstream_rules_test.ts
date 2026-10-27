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

/**
 * Every command a user can type has an explicit answer to "does this
 * command use serve as its v3 datastore upstream?" in
 * `SERVE_UPSTREAM_COMMANDS` (src/cli/serve_upstream.ts). The rule walks the
 * real command tree built by `registerCommands`, so a new top-level
 * command, a new alias, or a new subcommand of a family whose answer is
 * split by subcommand (`datastore`, `doctor`) fails here until it is given
 * a row and a reason. A row for a command that no longer exists fails too.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
import { registerCommands } from "../src/cli/mod.ts";
import { SERVE_UPSTREAM_COMMANDS } from "../src/cli/serve_upstream.ts";

function buildRoot(): AnyCommand {
  const root = new Command().name("swamp");
  registerCommands(root);
  return root;
}

/** Every word that reaches `command`: its name and its aliases. */
function spellings(command: AnyCommand): string[] {
  return [command.getName(), ...command.getAliases()];
}

function childSpellings(command: AnyCommand): string[] {
  return command.getCommands(true).flatMap(spellings).sort();
}

Deno.test("serve upstream: every top-level command and alias has a row", () => {
  const registered = childSpellings(buildRoot());
  const table = Object.keys(SERVE_UPSTREAM_COMMANDS).sort();
  assertEquals(
    table,
    registered,
    "SERVE_UPSTREAM_COMMANDS in src/cli/serve_upstream.ts must have exactly\n" +
      "one row per registered top-level command and alias. Decide whether the\n" +
      "new command uses serve as its v3 datastore upstream (applies) or binds\n" +
      "storage directly (excluded), and give the reason.",
  );
});

Deno.test("serve upstream: every subcommand of a split family has a row", () => {
  const root = buildRoot();
  for (const [family, rule] of Object.entries(SERVE_UPSTREAM_COMMANDS)) {
    if (rule.subcommands === undefined) continue;
    const command = root.getCommand(family, true);
    if (command === undefined) continue; // the top-level test reports it
    assertEquals(
      Object.keys(rule.subcommands).sort(),
      childSpellings(command),
      `SERVE_UPSTREAM_COMMANDS.${family}.subcommands must list every\n` +
        `registered \`${family}\` subcommand and alias with its answer.`,
    );
  }
});

Deno.test("serve upstream: serve, worker and datastore setup are excluded", () => {
  // The families that must never route through serve: serve is the
  // upstream, workers connect to serve themselves, and setup binds storage.
  assertEquals(SERVE_UPSTREAM_COMMANDS.serve.applies, false);
  assertEquals(SERVE_UPSTREAM_COMMANDS.serve.subcommands, undefined);
  assertEquals(SERVE_UPSTREAM_COMMANDS.worker.applies, false);
  assertEquals(SERVE_UPSTREAM_COMMANDS.worker.subcommands, undefined);
  assertEquals(SERVE_UPSTREAM_COMMANDS.datastore.applies, false);
  assertEquals(
    SERVE_UPSTREAM_COMMANDS.datastore.subcommands?.setup.applies,
    false,
  );
});
