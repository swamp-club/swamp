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

// errors naming a filesystem path must use markErrorPaths; a heuristic that
// misses string concatenation, prebuilt messages, error subclasses and oddly
// named variables

import { join } from "@std/path";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
} from "./arch_fitness_helpers.ts";

const SRC_DIR = join(import.meta.dirname!, "..", "src");

const LOOKBACK = 64;

const CONSTRUCTOR_RE = /\bnew (?:UserError|Error|SyntaxError)\(/g;
const INTERPOLATION_RE = /\$\{([^}]*)\}/g;
const PATH_NAME_RE =
  /^(?:\w+(?:Path|Dir|File|Root)|path|dir|file|root|location)$/;

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
 * keyed by file and message start; a repeated key gets an occurrence suffix so
 * a new copy of an existing message is still reported
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
 * path-named values that are not filesystem paths; mark a real path with
 * markErrorPaths instead of adding it here
 */
const PINNED: readonly string[] = [
  // not filesystem paths: API and URL paths, a data field path, an expression's
  // place in a definition, an extension-relative name; marking them would only
  // cost diagnostics
  "src/domain/models/data_writer.ts: `Cannot store sensitive field '${field.path}': vault '${targetVault}' is reserved for internal use`,",
  "src/domain/vaults/vault_secret_bag.ts: `The secret '${key}' in vault '${vaultName}' (at ${entry.location}) was not loaded before delivery`,",
  'src/infrastructure/http/swamp_club_client.ts: `Request to ${this.serverUrl}${path} timed out after ${seconds}s.`, "timeout",',
  "src/libswamp/auth/server_login.ts: `${serverUrl} returned a response that is not JSON to ${method} ${path} ` + `(HTTP ${resp.status}). ",
  "src/libswamp/auth/server_login.ts: `Could not reach ${serverUrl} (${method} ${path}): ${ describeCauses(err) }`,",
  "src/libswamp/extensions/pull.ts: `Cannot install ${ref.name}: the installed extension ` + `${ref.name}/${relDir} lives at ${first}/ i",
  "src/libswamp/extensions/pull.ts: `Cannot install ${ref.name}: the installed extension ` + `${ref.name}/${relDir} lives at ${first}/ i #2",
  "src/worker/data_plane_client.ts: `Data plane ${method} ${path} failed (${response.status}): ${detail}`,",
  'src/worker/data_plane_client.ts: `Serve did not answer ${method} ${path} within ` + `${timeoutMs! / 1000}s` + (init?.write ? "; serve',
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
