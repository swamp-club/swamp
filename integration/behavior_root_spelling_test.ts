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
import {
  resolveTelemetryInvocation,
  toRecordedInvocation,
} from "../src/cli/telemetry_invocation.ts";
import { behaviorTwinPath } from "../src/cli/behavior_twin.ts";
import type { CommandInvocationData } from "../src/domain/telemetry/mod.ts";

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

/** The recorded invocation for `args`, and the values it redacted. */
function record(args: string[]): {
  recorded: CommandInvocationData;
  sensitive: string[];
} {
  const sensitive: string[] = [];
  const recorded = toRecordedInvocation(
    resolveTelemetryInvocation(root, args, sensitive),
  );
  return { recorded, sensitive };
}

/** `invocation` without its commandSpelling. */
function withoutSpelling(
  invocation: CommandInvocationData,
): CommandInvocationData {
  const { commandSpelling: _spelling, ...rest } = invocation;
  return rest;
}

/**
 * Every way to type the command at `path` under `group`: the last word as its
 * name or as any of its aliases.
 */
function typedSpellings(group: string, path: string[]): string[][] {
  if (path.length === 0) return [[]];
  const leaf = at([group, ...path]);
  const head = path.slice(0, -1);
  return [leaf.getName(), ...leaf.getAliases()].map((word) => [...head, word]);
}

Deno.test("root: every behavior spelling records exactly what its swamp model spelling records (swamp-club#3411)", () => {
  const modelPaths = [[], ...commandPaths(at(["model"]))]
    .filter((path) => !(path.length === 1 && path[0] === "method"));
  let checked = 0;
  for (const modelPath of modelPaths) {
    const behaviorPath = modelPath[0] === "method"
      ? modelPath.slice(1)
      : modelPath;
    const positionals = at(["model", ...modelPath]).getArguments()
      .map((_arg: unknown, index: number) => `value-${index}`);
    const behaviorSpellings = typedSpellings("behavior", behaviorPath);
    const modelSpellings = typedSpellings("model", modelPath);
    assertEquals(behaviorSpellings.length, modelSpellings.length);
    for (const [index, typed] of behaviorSpellings.entries()) {
      for (const tail of [[], [...positionals, "--json"]]) {
        const model = record(["model", ...modelSpellings[index], ...tail]);
        assertEquals(model.recorded.commandSpelling, "model");
        for (const spelling of ["behavior", "behaviour"]) {
          const label = [spelling, ...typed, ...tail].join(" ");
          const behavior = record([spelling, ...typed, ...tail]);
          assertEquals(behavior.recorded.commandSpelling, spelling, label);
          assertEquals(
            withoutSpelling(behavior.recorded),
            withoutSpelling(model.recorded),
            label,
          );
          assertEquals(behavior.sensitive, model.sensitive, label);
          checked++;
        }
      }
    }
  }
  // Every command, both root spellings, with and without positionals.
  assert(checked >= modelPaths.length * 4, `checked ${checked}`);
});

Deno.test("root: every behavior path's twin resolves in the model tree (swamp-club#3411)", () => {
  for (const path of [[], ...behaviorPaths]) {
    for (const spelling of ["behavior", "behaviour"]) {
      const twin = behaviorTwinPath([spelling, ...path]);
      assertEquals(twin[0], "model");
      const command = at(twin);
      assertEquals(command.getName(), twin.at(-1), twin.join(" "));
      // The group roots differ by the method level; below them, a twin has
      // the same subcommands.
      if (path.length === 0) continue;
      assertEquals(
        command.getCommands(true).map((c: AnyCommand) => c.getName()).sort(),
        at(["behavior", ...path]).getCommands(true)
          .map((c: AnyCommand) => c.getName()).sort(),
        twin.join(" "),
      );
    }
  }
});

Deno.test("root: other groups record no commandSpelling (swamp-club#3411)", () => {
  for (
    const args of [
      [],
      ["workflow", "run", "w"],
      ["data", "get", "m", "d"],
      ["help", "behavior"],
      ["nope"],
    ]
  ) {
    const { recorded } = record(args);
    assertEquals("commandSpelling" in recorded, false, args.join(" "));
    assertEquals(
      recorded,
      resolveTelemetryInvocation(root, args, []),
      args.join(" "),
    );
  }
});
