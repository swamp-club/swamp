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
 * Fitness test for the stream contract:
 *
 *   stdout is the command's output — prose, JSON, or for a few commands a
 *   bare value a caller pipes, captures or redirects. stderr is interaction
 *   and diagnostics.
 *
 * The contract existed before it had a name, and it broke twice for the same
 * reason: something that was interaction got written to stdout, where a
 * caller was capturing a value. swamp-club#2254 put a log record ahead of the
 * URL in `swamp invite link | pbcopy`; swamp-club#2260 put a confirmation
 * prompt ahead of the secret in `swamp vault read-secret v k > key.pem`,
 * defeating the byte-exact output swamp-club#1768 established.
 *
 * This test pins every raw stdout write in `src/` so the set cannot grow
 * quietly. It is a ratchet, not a fix: seven of the pinned files still write
 * interaction to stdout, and swamp-club#2259 (stderr by default) is where
 * they convert. Pinning them makes that backlog enumerable — and makes a NEW
 * offender fail here instead of in a user's redirect target.
 *
 * Scope: **raw stream writes only** — `Deno.stdout.write(...)` and
 * `writeSync(...)`. Not in scope, deliberately:
 *
 *   - `console.log`, by far the larger route to stdout, governed instead by
 *     the renderer / `writeOutput` convention and `domain/models/console_guard.ts`.
 *   - `Deno.stdout.writable` (worker dispatch RPC frames) and
 *     `Deno.stdout.isTerminal()` (TTY probes), which the pattern excludes by
 *     requiring the open paren.
 *   - a file that aliases the handle first (`const out = Deno.stdout`), which
 *     a source grep cannot see.
 *
 * Static — no subprocesses, nothing is executed.
 */

import { walk } from "@std/fs/walk";
import {
  assertPinnedSet,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/**
 * A raw write to the stdout handle. The open paren is load-bearing: without
 * it this also matches `Deno.stdout.writable`, the RPC channel the worker
 * dispatch runner hands to `runDispatchRunner`, which is a value on stdout by
 * design and not a stream-contract violation.
 */
const RAW_STDOUT_WRITE = /Deno\.stdout\.write(?:Sync)?\(/;

/**
 * Files that write directly to stdout, pinned in two groups.
 *
 * Group 1 — the value on stdout. These writes ARE the command's output, and
 * the byte-exactness is the point: a renderer that added a newline would
 * break `> key.pem`, and the TUI files write terminal control sequences that
 * belong on the screen the user is looking at.
 *
 * Group 2 — interaction still on stdout. Each of these is a prompt, a wizard
 * narration, or a progress line that belongs on stderr by the same argument
 * that moved the shared prompt helpers (swamp-club#2260). None of them
 * belongs to a value-on-stdout command, so nothing is corrupted today — they
 * are pinned, not exempted, and swamp-club#2259 is where they move. Delete an
 * entry from this list when its file converts; `assertPinnedSet` fails on a
 * stale pin as loudly as on a new one.
 */
const PINNED_STDOUT_WRITERS: readonly string[] = [
  // Group 1 — the value on stdout.
  "src/presentation/renderers/components/search_picker.tsx",
  "src/presentation/renderers/data_query_tui.tsx",
  "src/presentation/renderers/vault_read_secret.ts",

  // Group 2 — interaction still on stdout (swamp-club#2259).
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
