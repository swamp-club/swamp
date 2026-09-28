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
 * Fitness rule: every command that takes `--server` also takes `--ca-cert`.
 *
 * The TLS UnknownIssuer guidance in `src/cli/remote_run.ts` tells users of any
 * `--server` command to pass `--ca-cert`. Commands that hand-rolled their
 * remote options instead of using `withRemoteOptions` left it out, so
 * following the advice failed with "Unknown option" (swamp-club#2360).
 *
 * The rule walks every Cliffy command exported from `src/cli/commands/` and
 * all of its subcommands, hidden ones included.
 */

import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import { Command } from "@cliffy/command";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
import { authLoginCommand } from "../src/cli/commands/auth_login.ts";
import { repoInitCommand } from "../src/cli/commands/repo_init.ts";
import { SRC_DIR } from "./arch_fitness_helpers.ts";

await initializeLogging({});

/**
 * Commands whose `--server` never opens a TLS connection to a `swamp serve`
 * instance, so `--ca-cert` would have nothing to apply to. Pinned by object
 * identity so a rename cannot silently widen the exemption.
 */
const EXEMPT = new Map<AnyCommand, string>([
  [authLoginCommand, "--server is the swamp-club URL, not a serve instance"],
  [repoInitCommand, "--server is stored in .swamp.yaml; nothing connects"],
]);

function isCliffyCommand(value: unknown): value is AnyCommand {
  return typeof value === "object" && value !== null &&
    typeof (value as AnyCommand).getCommands === "function" &&
    typeof (value as AnyCommand).getBaseOption === "function";
}

/**
 * Modules that execute on import (subprocess entry points) must not be
 * imported here — doing so would run them.
 */
function isEntryScript(source: string): boolean {
  return /^await /m.test(source) || /^if \(import\.meta\.main\)/m.test(source);
}

async function loadExportedCommands(): Promise<AnyCommand[]> {
  // Settle the command modules in production evaluation order first; entering
  // a module cycle from the wrong side throws a TDZ ReferenceError.
  await import(toFileUrl(join(SRC_DIR, "cli", "mod.ts")).href);

  const commands: AnyCommand[] = [];
  const commandsDir = join(SRC_DIR, "cli", "commands");
  for await (
    const entry of walk(commandsDir, { exts: [".ts"], includeDirs: false })
  ) {
    if (entry.path.endsWith("_test.ts")) continue;
    if (isEntryScript(await Deno.readTextFile(entry.path))) continue;
    const module = await import(toFileUrl(entry.path).href) as Record<
      string,
      unknown
    >;
    commands.push(...Object.values(module).filter(isCliffyCommand));
  }
  return commands;
}

/** Paths of commands that declare `--server` but not `--ca-cert`. */
function commandsMissingCaCert(roots: AnyCommand[]): string[] {
  const seen = new Set<AnyCommand>();
  const missing = new Set<string>();

  const visit = (command: AnyCommand): void => {
    if (seen.has(command)) return;
    seen.add(command);
    if (
      !EXEMPT.has(command) &&
      command.getBaseOption("server", true) !== undefined &&
      command.getBaseOption("ca-cert", true) === undefined
    ) {
      missing.add(command.getPath());
    }
    for (const sub of command.getCommands(true)) visit(sub);
  };

  for (const root of roots) visit(root);
  return [...missing].sort();
}

Deno.test("every --server command also accepts --ca-cert", async () => {
  const commands = await loadExportedCommands();
  assert(commands.length > 0, "no exported Cliffy commands were found");
  assertEquals(commandsMissingCaCert(commands), []);
});

Deno.test("every --ca-cert exemption still declares --server", () => {
  for (const [command, reason] of EXEMPT) {
    assert(
      command.getBaseOption("server", true) !== undefined,
      `${command.getPath()} no longer takes --server; drop its exemption ` +
        `(${reason})`,
    );
  }
});

Deno.test("commandsMissingCaCert: reports a --server command without --ca-cert", () => {
  const leaf = new Command()
    .name("leaf")
    .option("--server <url:string>", "server");
  const covered = new Command()
    .name("covered")
    .option("--server <url:string>", "server")
    .option("--ca-cert <path:string>", "ca");
  const root = new Command()
    .name("root")
    .command("leaf", leaf)
    .command("covered", covered);

  assertEquals(commandsMissingCaCert([root]), ["root leaf"]);
});
