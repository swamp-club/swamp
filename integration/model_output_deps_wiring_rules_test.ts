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

// The output, output-data, method-history-logs, data-versions and
// data-rename deps factories fall back to a definition repository built from the repo dir alone. It has no
// unreadable-content lookup, so a v3 auto-definition the read model could
// not materialise reads as "no such model" instead of failing loudly, and
// with a datastore configured it misses auto-definitions altogether
// (swamp-club#3617). CLI and serve callers inject the repository context's
// definition repository instead.

import { assertGreater } from "@std/assert";
import { walk } from "@std/fs/walk";
import { join } from "@std/path";
import {
  assertPinnedSet,
  countedKeys,
  isCommentLine,
  repoRelative,
  SRC_DIR,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";

/** Each factory and the position of its injectedDefinitionRepo parameter. */
const FACTORIES: Readonly<Record<string, number>> = {
  createModelOutputGetDeps: 3,
  createModelOutputDataDeps: 4,
  createModelMethodHistoryLogsDeps: 3,
  createDataVersionsDeps: 4,
  createDataRenameDeps: 4,
};

/**
 * Top-level argument texts of each `<factory>(...)` call. The splitter
 * tracks bracket depth only, not string literals; no caller passes a literal
 * containing a comma or bracket, and a miscount fails the test.
 */
function callArgs(
  code: string,
  factory: string,
): { line: number; args: string[] }[] {
  const source = code
    .split("\n")
    .map((line) => isCommentLine(line) ? "" : line)
    .join("\n");
  const calls: { line: number; args: string[] }[] = [];
  const marker = new RegExp(`\\b${factory}\\s*\\(`, "g");
  for (const match of source.matchAll(marker)) {
    const args: string[] = [];
    let depth = 0;
    let current = "";
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const ch = source[i];
      if (depth === 0 && ch === ")") break;
      if (depth === 0 && ch === ",") {
        args.push(current.trim());
        current = "";
        continue;
      }
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      current += ch;
    }
    if (current.trim() !== "") args.push(current.trim());
    calls.push({
      line: source.slice(0, match.index).split("\n").length - 1,
      args,
    });
  }
  return calls;
}

Deno.test("output, method-history, data versions and data rename deps callers in cli and serve pass the injected definition repo (swamp-club#3617)", async () => {
  const missing: string[] = [];
  let scanned = 0;
  for (const dir of ["cli", "serve"]) {
    for await (
      const entry of walk(join(SRC_DIR, dir), {
        exts: [".ts"],
        skip: [/_test\.ts$/],
      })
    ) {
      const code = await Deno.readTextFile(entry.path);
      const owners = topLevelOwners(code.split("\n"));
      for (const [factory, position] of Object.entries(FACTORIES)) {
        for (const call of callArgs(code, factory)) {
          scanned++;
          const definitionRepo = call.args[position - 1];
          if (definitionRepo === undefined || definitionRepo === "undefined") {
            missing.push(
              `${repoRelative(entry.path)}: ${factory} in ${owners[call.line]}`,
            );
          }
        }
      }
    }
  }

  // Eight CLI callers, including the search pickers (swamp-club#3743), and
  // six serve handlers: a scan that matches nothing must not pass.
  assertGreater(scanned, 10);
  assertPinnedSet(
    countedKeys(missing),
    [],
    "Output, method-history, data versions and data rename deps without an injected definition repo",
    "Pass repoContext.definitionRepo as injectedDefinitionRepo so an\n" +
      "auto-definition the v3 read model could not materialise fails loudly,\n" +
      "and auto-definitions are found where the datastore keeps them.",
  );
});

/** Each output deps factory and the position of its datastoreResolver. */
const RESOLVER_FACTORIES: Readonly<Record<string, number>> = {
  createModelOutputGetDeps: 2,
  createModelOutputDataDeps: 2,
  createModelOutputLogsDeps: 2,
  createModelMethodHistoryLogsDeps: 2,
};

Deno.test("output and method-history deps callers in cli and serve pass the datastore resolver (swamp-club#3729, swamp-club#3743)", async () => {
  const missing: string[] = [];
  let scanned = 0;
  for (const dir of ["cli", "serve"]) {
    for await (
      const entry of walk(join(SRC_DIR, dir), {
        exts: [".ts"],
        skip: [/_test\.ts$/],
      })
    ) {
      const code = await Deno.readTextFile(entry.path);
      const owners = topLevelOwners(code.split("\n"));
      for (const [factory, position] of Object.entries(RESOLVER_FACTORIES)) {
        for (const call of callArgs(code, factory)) {
          scanned++;
          const resolver = call.args[position - 1];
          if (resolver === undefined || resolver === "undefined") {
            missing.push(
              `${repoRelative(entry.path)}: ${factory} in ${owners[call.line]}`,
            );
          }
        }
      }
    }
  }

  // Seven CLI callers and five serve handlers build these deps: a scan
  // that matches nothing must not pass.
  assertGreater(scanned, 10);
  assertPinnedSet(
    countedKeys(missing),
    [],
    "Output and method-history deps without a datastore resolver",
    "Pass the datastore resolver (ctx.datastoreResolver in serve, the one\n" +
      "requireInitializedRepo returns in the CLI) so output records are read\n" +
      "where the datastore keeps them, as the search listings do.",
  );
});
