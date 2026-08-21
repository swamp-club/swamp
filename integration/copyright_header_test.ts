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
import { walk } from "@std/fs/walk";
import { join, relative, SEPARATOR } from "@std/path";

const HEADER_MARKER = "// Swamp, an Automation Framework";

const SKIP_DIRS = new Set([
  "experiments",
  ".agents",
  ".claude",
  ".github",
  ".jj",
  "node_modules",
  ".git",
]);

// Directories walked for .ts/.tsx sources. `extensions/` and `packages/` hold
// first-party TypeScript that ships with the repo and is covered by the same
// licence as src/.
const WALK_DIRS = ["src", "integration", "scripts", "extensions", "packages"];

/**
 * True when any path segment of `repoRelativePath` is a skipped directory.
 *
 * This is matched against the *repository-relative* path, split on the native
 * `SEPARATOR`, rather than regex-matching the absolute path with a hard-coded
 * "/". The old form was wrong twice over: it never matched on Windows (where
 * the separator is "\"), and when the checkout itself lived under a skipped
 * name — e.g. a git worktree beneath `.claude/worktrees/` — the pattern
 * matched every absolute path and silently skipped the entire tree, turning
 * the whole check into a vacuous pass.
 */
function isSkipped(repoRelativePath: string): boolean {
  return repoRelativePath.split(SEPARATOR).some((seg) => SKIP_DIRS.has(seg));
}

function hasHeader(content: string): boolean {
  const lines = content.split("\n");
  // Allow shebang on first line
  const firstContentLine = lines[0].startsWith("#!") ? lines[2] : lines[0];
  return firstContentLine === HEADER_MARKER;
}

Deno.test("hasHeader: all TypeScript files have the AGPLv3 copyright header", async () => {
  const root = join(import.meta.dirname!, "..");
  const missing: string[] = [];

  for (const dir of WALK_DIRS) {
    const dirPath = join(root, dir);
    try {
      for await (
        const entry of walk(dirPath, {
          exts: [".ts", ".tsx"],
          includeDirs: false,
        })
      ) {
        const rel = relative(root, entry.path);
        if (isSkipped(rel)) continue;
        const content = await Deno.readTextFile(entry.path);
        if (!hasHeader(content)) {
          missing.push(rel);
        }
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }
  }

  // Root-level .ts/.tsx files
  for await (const entry of Deno.readDir(root)) {
    if (
      entry.isFile &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      const filePath = join(root, entry.name);
      const content = await Deno.readTextFile(filePath);
      if (!hasHeader(content)) {
        missing.push(entry.name);
      }
    }
  }

  assertEquals(
    missing.length,
    0,
    `The following ${missing.length} file(s) are missing the AGPLv3 copyright header.\n` +
      `Run \`deno run license-headers\` to fix, or see FILE-LICENSE-TEMPLATE.md.\n\n` +
      missing.sort().map((f) => `  - ${f}`).join("\n"),
  );
});
