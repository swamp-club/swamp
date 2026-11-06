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
 * stdout is the command's output and stderr is interaction; every raw stdout
 * write in src/ is pinned so the set cannot grow quietly and a new offender
 * fails here, not in a user's redirect target
 */

import { walk } from "@std/fs/walk";
import {
  assertPinnedSet,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/**
 * the open paren is load-bearing: without it this also matches
 * Deno.stdout.writable, the worker dispatch RPC channel, which is a value on
 * stdout by design
 */
const RAW_STDOUT_WRITE = /Deno\.stdout\.write(?:Sync)?\(/;

/**
 * group 1 writes are the command's output and must be byte-exact; group 2 is
 * interaction still on stdout, pinned not exempted; delete an entry when its
 * file converts
 */
const PINNED_STDOUT_WRITERS: readonly string[] = [
  // Group 1 — the value on stdout.
  // `swamp dashboard --child` prints `{"port":N}`, the value its hub reads.
  "src/cli/commands/dashboard.ts",
  "src/presentation/renderers/components/search_picker.tsx",
  "src/presentation/renderers/data_query_tui.tsx",
  // The inbox enters and leaves the alternate screen around its TUI.
  "src/presentation/renderers/inbox_tui.tsx",
  "src/presentation/renderers/vault_read_secret.ts",
  // A `--json` value too large for one string, written in chunks.
  "src/presentation/output/json_stream.ts",

  // group 2: interaction still on stdout, pending a move to stderr
  "src/cli/commands/agent_setup.ts",
  "src/cli/commands/datastore_setup.ts",
  "src/cli/commands/issue_submit.ts",
  "src/cli/commands/vault_create.ts",
  "src/cli/commands/vault_migrate.ts",
  "src/infrastructure/io/stdin_reader.ts",
  "src/libswamp/auth/login.ts",
];

const NEW_ENTRY_POLICY = [
  "A new file writes directly to stdout. Decide which it is:",
  "",
  "  - Interaction (a prompt, a wizard's narration, a progress line): write",
  "    it to stderr instead. Prompts go through src/cli/prompt_helpers.ts,",
  "    which already does. Nothing needs pinning.",
  "  - The command's value or a TUI control sequence: that is legitimate —",
  "    add the file to PINNED_STDOUT_WRITERS under group 1, with a comment",
  "    saying what the value is.",
  "",
  "Do not add a file to the pinned list to silence this test. The list exists",
  "so swamp-club#2259 can see what is left, not to grant exemptions.",
].join("\n");

Deno.test("stream contract: raw stdout writes in src/ match the pinned set", async () => {
  const found: string[] = [];

  for await (
    const entry of walk(SRC_DIR, {
      includeDirs: false,
      exts: [".ts", ".tsx"],
      skip: [/_test\.ts$/, /_test\.tsx$/],
    })
  ) {
    const source = await Deno.readTextFile(entry.path);
    if (RAW_STDOUT_WRITE.test(source)) {
      found.push(repoRelative(entry.path));
    }
  }

  assertPinnedSet(
    found.sort(),
    [...PINNED_STDOUT_WRITERS].sort(),
    "raw stdout writers in src/",
    NEW_ENTRY_POLICY,
  );
});
