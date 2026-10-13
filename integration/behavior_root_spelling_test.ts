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
 * The `swamp behavior` and `swamp model` groups as the real root registers
 * them (swamp-club#3409): the preferred group is listed first, the legacy
 * group says it is the legacy spelling, the British `behaviour` alias reaches
 * the very same commands, telemetry records the canonical path, and the two
 * trees have the same commands — checked on the root src/cli/mod.ts builds,
 * not on a hand-made copy.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { buildCommandTree } from "../src/cli/mod.ts";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
import { resolveTelemetryInvocation } from "../src/cli/telemetry_invocation.ts";

const root = buildCommandTree();

/** The command reached by typing `words` at the root. */
function at(words: string[]): AnyCommand {
  let command = root;
  for (const word of words) {
    const next = command.getCommand(word, true);
    assert(next !== undefined, `${words.join(" ")}: no ${word}`);
    command = next;
  }
  return command;
}

/** Every command path under `group`, as words after the group. */
function commandPaths(group: AnyCommand, prefix: string[] = []): string[][] {
  return group.getCommands(true).flatMap((child: AnyCommand) => {
    const path = [...prefix, child.getName()];
    return [path, ...commandPaths(child, path)];
  });
}

const behaviorPaths = commandPaths(at(["behavior"]));

Deno.test("root: registers behavior before model", () => {
  const names = root.getCommands(true).map((cmd: AnyCommand) => cmd.getName());
  const behavior = names.indexOf("behavior");
  const model = names.indexOf("model");
  assert(behavior >= 0 && model >= 0, names.join(", "));
  assert(behavior < model, `behavior at ${behavior}, model at ${model}`);
});

Deno.test("root: the model group describes itself as the legacy spelling", () => {
  const description = at(["model"]).getDescription();
  assert(description.includes("legacy"), description);
  assert(description.includes("behavior"), description);
});

Deno.test("root: behaviour reaches the same command instance for every behavior path", () => {
  assertStrictEquals(at(["behaviour"]), at(["behavior"]));
  assert(behaviorPaths.length > 0);
  for (const path of behaviorPaths) {
    assertStrictEquals(
      at(["behaviour", ...path]),
      at(["behavior", ...path]),
      path.join(" "),
    );
  }
});

Deno.test("root: telemetry records behaviour under the canonical behavior path", () => {
  const result = resolveTelemetryInvocation(root, ["behaviour", "get", "x"]);
  assertEquals(result.command, "behaviour");
  assertEquals(result.subcommand, "get");
  assertEquals(result.commandPath, ["behavior", "get"]);
  assertEquals(result.args, ["x"]);
});

Deno.test("root: every model command has a behavior twin and every behavior command a model twin", () => {
  const fromModel = commandPaths(at(["model"]))
    .filter((path) => !(path.length === 1 && path[0] === "method"))
    .map((path) => (path[0] === "method" ? path.slice(1) : path).join(" "));
  const fromBehavior = behaviorPaths.map((path) => path.join(" "));
  for (const path of fromModel) {
    assert(fromBehavior.includes(path), `model-only command: ${path}`);
  }
  for (const path of fromBehavior) {
    assert(fromModel.includes(path), `behavior-only command: ${path}`);
  }
  assertEquals(fromModel.length, fromBehavior.length);
});
