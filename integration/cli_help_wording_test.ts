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

import "../src/domain/models/models.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildCommandTree, ROOT_DESCRIPTION } from "../src/cli/mod.ts";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
import {
  DECIDED_ON_SERVE_SERVER_DESCRIPTION,
  DECIDED_ON_SERVE_TOKEN_DESCRIPTION,
} from "../src/cli/remote_run.ts";

const root = await buildCommandTree();

interface Visited {
  path: string[];
  command: AnyCommand;
}

function walk(command: AnyCommand, path: string[] = []): Visited[] {
  return command.getCommands(true).flatMap((child: AnyCommand) => {
    const childPath = [...path, child.getName()];
    return [{ path: childPath, command: child }, ...walk(child, childPath)];
  });
}

const commands = walk(root);

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
  // guards against a walk that reached nothing: the plain --yes aliases alone
  // are many
  assertEquals(seen >= 13, true, `only ${seen} --force options found`);
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
  // A missing argument exits 1 on most commands, so exit 2 must not claim it.
  assertStringIncludes(
    ROOT_DESCRIPTION,
    "2    unknown command or subcommand, or too many arguments",
  );
  for (const code of ["0 ", "1 ", "2 ", "75 ", "130 "]) {
    assertStringIncludes(ROOT_DESCRIPTION, `\n    ${code}`);
  }
});

Deno.test("help wording: help says team mode, never serve-mode", () => {
  const stale: string[] = [];
  for (const { path, command } of commands) {
    const texts = [
      command.getDescription(),
      ...localOptions(command).map((option) => option.description),
    ];
    for (const text of texts) {
      if (/serve-mode/i.test(text)) stale.push(`${path.join(" ")}: ${text}`);
    }
  }
  assertEquals(stale, []);
});

Deno.test("help wording: commands serve decides say --server is not needed to reach a named serve", () => {
  for (const name of ["approve", "reject", "signal", "waits"]) {
    const found = commands.find((c) => c.path.join(" ") === `workflow ${name}`);
    const server = localOptions(found!.command).find((option) =>
      option.flags.includes("--server")
    );
    assertEquals(server?.description, DECIDED_ON_SERVE_SERVER_DESCRIPTION);
    const token = localOptions(found!.command).find((option) =>
      option.flags.includes("--token")
    );
    assertEquals(token?.description, DECIDED_ON_SERVE_TOKEN_DESCRIPTION);
    assertEquals(
      server?.description.includes("only this flag runs it on serve"),
      false,
    );
    assertStringIncludes(found!.command.getDescription(), "In team mode");
  }
});

Deno.test("help wording: workflow cancel's --server names the run it sends to serve in team mode", () => {
  const cancel = commands.find((c) => c.path.join(" ") === "workflow cancel");
  const server = localOptions(cancel!.command).find((option) =>
    option.flags.includes("--server")
  );
  assertStringIncludes(
    server?.description ?? "",
    "in team mode a run this checkout did not start is cancelled on serve without it",
  );
});
