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
 * Help wording that has to read the same across the whole tree, checked on
 * the root src/cli/mod.ts builds: every --force says whether it is the --yes
 * alias (swamp-club#3836), every --model option says the spelling is kept
 * (swamp-club#3837), and the root states the --json error envelope and the
 * exit codes every command shares (swamp-club#3834).
 */

import "../src/domain/models/models.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildCommandTree, ROOT_DESCRIPTION } from "../src/cli/mod.ts";
import type { AnyCommand } from "../src/cli/cli_schema.ts";

const root = buildCommandTree();

interface Visited {
  path: string[];
  command: AnyCommand;
}

/** Every command under `command` once, by its canonical names. */
function walk(command: AnyCommand, path: string[] = []): Visited[] {
  return command.getCommands(true).flatMap((child: AnyCommand) => {
    const childPath = [...path, child.getName()];
    return [{ path: childPath, command: child }, ...walk(child, childPath)];
  });
}

const commands = walk(root);

/** Each option declared on `command` itself. */
function localOptions(
  command: AnyCommand,
): { flags: string[]; description: string }[] {
  return command.getBaseOptions(true);
}

Deno.test("help wording: every --force says whether it is the --yes alias", () => {
  const unclear: string[] = [];
  let seen = 0;
  for (const { path, command } of commands) {
    for (const option of localOptions(command)) {
      if (!option.flags.includes("--force")) continue;
      seen++;
      const { description } = option;
      if (
        !description.includes("(alias for --yes") &&
        !description.includes("(not an alias for --yes)")
      ) {
        unclear.push(`${path.join(" ")}: ${description}`);
      }
    }
  }
  assertEquals(unclear, []);
  // The walk reached the tree: the 13 plain aliases alone exceed this.
  assertEquals(seen > 20, true, `only ${seen} --force options found`);
});

Deno.test("help wording: every --model option outside the model tree says the spelling is kept", () => {
  const silent: string[] = [];
  for (const { path, command } of commands) {
    if (path[0] === "model" || path[0] === "behavior") continue;
    for (const option of localOptions(command)) {
      if (!option.flags.includes("--model")) continue;
      if (!option.description.includes("--model is the kept legacy spelling")) {
        silent.push(`${path.join(" ")}: ${option.description}`);
      }
    }
  }
  assertEquals(silent, []);
});

Deno.test("help wording: the model group says its spelling is kept", () => {
  const model = commands.find((c) => c.path.join(" ") === "model");
  assertStringIncludes(
    model?.command.getDescription() ?? "",
    "kept, no removal planned",
  );
});

Deno.test("help wording: the root states the --json error envelope and shared exit codes", () => {
  assertEquals(root.getDescription(), ROOT_DESCRIPTION);
  assertStringIncludes(ROOT_DESCRIPTION, "stderr");
  assertStringIncludes(
    ROOT_DESCRIPTION,
    '{ "error": "<message>", "code": "<error_code>" }',
  );
  for (const code of ["0 ", "1 ", "2 ", "75 ", "130 "]) {
    assertStringIncludes(ROOT_DESCRIPTION, `\n    ${code}`);
  }
});
