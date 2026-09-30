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

// Architectural fitness test: errors that name a filesystem path mark it
// (swamp-club#2830).
//
// Telemetry removes marked paths exactly (`markErrorPaths` in
// src/domain/errors.ts); an unmarked path falls back to patterns that cannot
// tell where a path with a space in its last segment ends. This ratchet finds
// `new UserError(` / `new Error(` / `new SyntaxError(` whose message
// interpolates a path-named value (`*Path`, `*Dir`, `*File`, `*Root`, `path`,
// `dir`, `file`, `root`, `location`) and is not wrapped in `markErrorPaths(`.
// It is a heuristic: it guards against new unmarked sites, it does not prove
// every path is marked. It does not see messages built by string
// concatenation (`"... at " + path`), messages built before the constructor
// call, or custom error subclasses, and a path in a variable with some other
// name passes.

import { join } from "@std/path";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
} from "./arch_fitness_helpers.ts";

const SRC_DIR = join(import.meta.dirname!, "..", "src");

/** How far before `new` to look for the `markErrorPaths(` wrapper. */
const LOOKBACK = 64;

const CONSTRUCTOR_RE = /\bnew (?:UserError|Error|SyntaxError)\(/g;
const INTERPOLATION_RE = /\$\{([^}]*)\}/g;
const PATH_NAME_RE =
  /^(?:\w+(?:Path|Dir|File|Root)|path|dir|file|root|location)$/;

/** The text between the `(` at `open` and its matching `)`. */
function argumentsAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

function namesPath(args: string): boolean {
  for (const [, expr] of args.matchAll(INTERPOLATION_RE)) {
    for (const token of expr.split(/[^\w]+/)) {
      if (PATH_NAME_RE.test(token)) return true;
    }
  }
  return false;
}

/**
 * Unmarked path-naming error constructions, keyed by file and the start of
 * their message. A repeated key gets an occurrence suffix, so a new copy of
 * an existing message in the same file is still reported.
 */
async function unmarkedPathErrors(): Promise<string[]> {
  const keys: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(filePath);
    const seen = new Map<string, number>();
    for (const match of source.matchAll(CONSTRUCTOR_RE)) {
      const start = match.index!;
      const args = argumentsAt(source, start + match[0].length - 1);
      if (!namesPath(args)) continue;
      const before = source.slice(Math.max(0, start - LOOKBACK), start);
      if (before.trimEnd().endsWith("markErrorPaths(")) {
        continue;
      }
      const message = args.replace(/\s+/g, " ").trim().slice(0, 100);
      const base = `${repoRelative(filePath)}: ${message}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      keys.push(count === 1 ? base : `${base} #${count}`);
    }
  }
  return keys.sort();
}

/**
 * Path-named values that are not filesystem paths. Do not add a filesystem
 * path here: mark it with `markErrorPaths` instead.
 */
const PINNED: readonly string[] = [
  // Not filesystem paths: API and URL paths, a data field path, and an
  // extension-relative name. Marking them would only cost diagnostics.
  "src/domain/models/data_writer.ts: `Cannot store sensitive field '${field.path}': vault '${targetVault}' is reserved for internal use`,",
  'src/infrastructure/http/swamp_club_client.ts: `Request to ${this.serverUrl}${path} timed out after ${seconds}s.`, "timeout",',
  "src/libswamp/auth/server_login.ts: `${serverUrl} returned a response that is not JSON to ${method} ${path} ` + `(HTTP ${resp.status}). ",
  "src/libswamp/auth/server_login.ts: `Could not reach ${serverUrl} (${method} ${path}): ${ describeCauses(err) }`,",
  "src/libswamp/extensions/pull.ts: `Cannot install ${ref.name}: the installed extension ` + `${ref.name}/${relDir} lives at ${first}/ i",
  "src/worker/data_plane_client.ts: `Data plane ${method} ${path} failed (${response.status}): ${detail}`,",
];

Deno.test("error path marking: no new unmarked path-naming errors", async () => {
  assertPinnedSet(
    await unmarkedPathErrors(),
    PINNED,
    "Unmarked path-naming errors",
    "Wrap the new error in markErrorPaths(error, [thePath]) so telemetry " +
      "removes the path exactly (swamp-club#2830). If the value is not a " +
      "filesystem path, rename it or pin the entry with a reason.",
  );
});
