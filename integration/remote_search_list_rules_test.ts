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

// Architectural fitness test: a remote search never starts the interactive
// picker (swamp-club#3917).
//
// The `--server` branch of a search command renders a response that has
// already arrived. It builds its renderer with `interactive: false`, so in a
// terminal it prints a plain list and the command ends. The picker is not
// supported over `--server`: an unawaited picker let the command return under
// it, and the process exited a second after the picker appeared.
//
// The set of search commands with a `--server` branch is pinned, so a new one
// is a deliberate addition that this rule then covers.

import { assert } from "@std/assert";
import { join } from "@std/path";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const COMMANDS_DIR = join(SRC_DIR, "cli", "commands");

/** Search commands whose `--server` branch renders search results. */
const PINNED_REMOTE_SEARCH_COMMANDS = [
  "src/cli/commands/data_search.ts",
  "src/cli/commands/extension_search.ts",
  "src/cli/commands/model_method_history_search.ts",
  "src/cli/commands/model_output_search.ts",
  "src/cli/commands/model_search.ts",
  "src/cli/commands/report_search.ts",
  "src/cli/commands/report_type_search.ts",
  "src/cli/commands/type_search.ts",
  "src/cli/commands/vault_search.ts",
  "src/cli/commands/vault_type_search.ts",
  "src/cli/commands/workflow_history_search.ts",
  "src/cli/commands/workflow_run_search.ts",
  "src/cli/commands/workflow_search.ts",
];

/**
 * The `--server` branch of a command: the block of the first `if` after
 * `resolveServeUrl(`, found by matching its braces. Template literals in the
 * branch hold balanced braces, so a plain count is enough here.
 */
function serverBranch(source: string): string | undefined {
  const call = source.indexOf("= resolveServeUrl(");
  if (call === -1) return undefined;
  const ifAt = source.indexOf("if (", call);
  if (ifAt === -1) return undefined;
  const open = source.indexOf("{", ifAt);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return undefined;
}

async function remoteSearchBranches(): Promise<Map<string, string>> {
  const branches = new Map<string, string>();
  for await (const filePath of productionSourceFiles(COMMANDS_DIR)) {
    const branch = serverBranch(await Deno.readTextFile(filePath));
    if (branch && /create\w*SearchRenderer\(/.test(branch)) {
      branches.set(repoRelative(filePath), branch);
    }
  }
  return branches;
}

Deno.test("remote search: the pinned commands are the ones with a --server search branch", async () => {
  const branches = await remoteSearchBranches();
  assertPinnedSet(
    [...branches.keys()].sort(),
    PINNED_REMOTE_SEARCH_COMMANDS,
    "Search commands with a --server branch",
    "Build the renderer with { interactive: false } and await its handler, " +
      "then add the file to PINNED_REMOTE_SEARCH_COMMANDS.",
  );
});

Deno.test("search commands: a wrapped completed handler awaits the handler it wraps", async () => {
  // The local workflow history search wrapped the picker handler without
  // await, so the command ended under the picker (swamp-club#3917).
  const wrapped: string[] = [];
  for await (const filePath of productionSourceFiles(COMMANDS_DIR)) {
    const source = await Deno.readTextFile(filePath);
    for (const m of source.matchAll(/handlers\.completed = /g)) {
      const body = source.slice(m.index, source.indexOf("\n  };", m.index));
      wrapped.push(repoRelative(filePath));
      assert(
        /^handlers\.completed = async \(/.test(body) &&
          /await orig\w*\(/.test(body),
        `${repoRelative(filePath)}: it replaces handlers.completed with a ` +
          `wrapper that does not await the original handler, so the command ` +
          `can end before the picker or output finishes.`,
      );
    }
  }
  assertPinnedSet(
    wrapped.sort(),
    ["src/cli/commands/workflow_history_search.ts"],
    "Search commands that wrap their completed handler",
    "Make the wrapper async and await the original handler, then pin the file.",
  );
});

Deno.test("remote search: every --server branch prints a plain list and waits for it", async () => {
  const branches = await remoteSearchBranches();
  for (const [file, branch] of branches) {
    assert(
      branch.includes("interactive: false"),
      `${file}: its --server branch builds a search renderer without ` +
        `{ interactive: false }, so in a terminal it starts the picker, ` +
        `which --server does not support.`,
    );
    assert(
      !branch.includes("renderInteractivePicker("),
      `${file}: its --server branch starts the interactive picker.`,
    );
    // Each direct handler call must be awaited; consumeStream awaits its own.
    const calls = [...branch.matchAll(/handlers\(\)\.completed\(/g)];
    const awaited = [
      ...branch.matchAll(/await\s+renderer\.handlers\(\)\.completed\(/g),
    ];
    assert(
      calls.length === awaited.length,
      `${file}: its --server branch calls the renderer handler without ` +
        `await, so the command can end before the output is written.`,
    );
  }
});
