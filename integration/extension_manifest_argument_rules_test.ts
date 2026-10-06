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

// Architectural fitness test: every command that takes a manifest argument
// resolves it through `resolveManifestArgument` (swamp-club#3018).
//
// `extension push`, `quality` and `fmt` must agree on what a manifest
// argument means: a file or a directory, relative to the current directory
// first, then `--extensions-dir`, then the repo dir. Before #3018 each
// command also re-resolved the raw argument against the repo dir for its
// own lookups, so the three drifted. This test pins the set of commands
// that call `resolveExtensionFiles` and requires each of them to go through
// the shared helper and never to resolve the raw argument on its own.

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
} from "./arch_fitness_helpers.ts";

const COMMANDS_DIR = join(import.meta.dirname!, "..", "src", "cli", "commands");

/** Commands that resolve extension files from a manifest argument. */
const MANIFEST_COMMANDS = [
  "src/cli/commands/extension_fmt.ts",
  "src/cli/commands/extension_push.ts",
  "src/cli/commands/extension_quality.ts",
];

const RAW_ARGUMENT_RESOLVE = /\bresolve\(\s*repoDir\s*,\s*manifestPath\s*\)/;
const RAW_ARGUMENT_PULLED_CHECK =
  /\bisPulledExtensionManifest\(\s*repoDir\s*,\s*manifestPath\s*\)/;

Deno.test("manifest-argument rules: commands that resolve extension files are the pinned set", async () => {
  const callers: string[] = [];
  for await (const file of productionSourceFiles(COMMANDS_DIR)) {
    const source = await Deno.readTextFile(file);
    if (source.includes("resolveExtensionFiles(")) {
      callers.push(repoRelative(file));
    }
  }
  assertPinnedSet(
    callers,
    MANIFEST_COMMANDS,
    "commands calling resolveExtensionFiles",
    "a new manifest-taking command must resolve its argument through resolveManifestArgument and be added to MANIFEST_COMMANDS",
  );
});

Deno.test("manifest-argument rules: each manifest command resolves its argument through resolveManifestArgument only", async () => {
  for (const rel of MANIFEST_COMMANDS) {
    const source = await Deno.readTextFile(
      join(import.meta.dirname!, "..", rel),
    );
    assertEquals(
      source.includes("resolveManifestArgument("),
      true,
      `${rel} must call resolveManifestArgument`,
    );
    assertEquals(
      RAW_ARGUMENT_RESOLVE.test(source),
      false,
      `${rel} resolves the raw manifest argument against the repo dir; use the absolute path from resolveManifestArgument`,
    );
    assertEquals(
      RAW_ARGUMENT_PULLED_CHECK.test(source),
      false,
      `${rel} passes the raw manifest argument to isPulledExtensionManifest; pass the absolute path from resolveManifestArgument`,
    );
  }
});
