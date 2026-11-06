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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type {
  RepoPruneData,
  RepoPruneEvent,
} from "../../libswamp/repo/prune.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import { exitOneOnFailedChanges, repoPruneCommand } from "./repo_prune.ts";

await initializeLogging({});

Deno.test("repoPruneCommand is registered as a repo subcommand", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  const prune = repoCommand.getCommands().find((c) => c.getName() === "prune");
  assertEquals(prune !== undefined, true);
});

Deno.test("repoPruneCommand offers --dry-run, -y/--yes and its -f/--force alias", () => {
  assertEquals(repoPruneCommand.getOption("dry-run")?.flags, ["--dry-run"]);
  assertEquals(repoPruneCommand.getOption("yes")?.flags, ["-y", "--yes"]);
  assertEquals(repoPruneCommand.getOption("force")?.flags, ["-f", "--force"]);
});

Deno.test("repoPruneCommand takes an optional path argument", () => {
  const args = repoPruneCommand.getArguments();
  assertEquals(args.length, 1);
  assertEquals(args[0].name, "path");
  assertEquals(args[0].optional, true);
});

function pruneData(failed: RepoPruneData["failed"]): RepoPruneData {
  return {
    path: "/repo",
    dryRun: false,
    enrolledTools: ["codex"],
    pruned: [],
    skipped: [],
    failed,
  };
}

async function exitCodeAfter(data: RepoPruneData): Promise<{
  exitCode: number;
  rendered: boolean;
}> {
  let rendered = false;
  const handlers: EventHandlers<RepoPruneEvent> = {
    pruning: () => {},
    completed: () => {
      rendered = true;
    },
    error: () => {},
  };
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    await exitOneOnFailedChanges(handlers).completed({
      kind: "completed",
      data,
    });
    return { exitCode: Deno.exitCode, rendered };
  } finally {
    Deno.exitCode = previousExitCode;
  }
}

Deno.test("exitOneOnFailedChanges: renders the result and exits 1 when a change failed", async () => {
  const result = await exitCodeAfter(pruneData([{
    tool: "cursor",
    path: ".cursor/hooks.json",
    reason: "Permission denied (os error 13)",
  }]));
  assertEquals(result, { exitCode: 1, rendered: true });
});

Deno.test("exitOneOnFailedChanges: leaves the exit code at 0 when nothing failed", async () => {
  const result = await exitCodeAfter(pruneData([]));
  assertEquals(result, { exitCode: 0, rendered: true });
});
