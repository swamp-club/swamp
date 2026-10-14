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
 * The behavior spelling of flags and completion types (swamp-club#3410),
 * checked on the root src/cli/mod.ts builds: every `--model` option lists
 * `--behavior` first with `--model` as its alias, `--restricted-model-types`
 * keeps its model name with no behavior twin, `swamp behavior` arguments
 * complete through `behavior_name`/`behavior_type` while the `swamp model`
 * tree keeps `model_name`/`model_type`, and every completion type an
 * installed completion script may call stays registered.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { generateShellCompletions } from "@cliffy/command/completions";
import { generatePowerShellCompletions } from "../src/cli/commands/completion_powershell.ts";
import { buildCommandTree } from "../src/cli/mod.ts";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
import { COMPLETION_TYPE_NAMES } from "../src/cli/completion_types.ts";

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

/** The flags of each option declared on `command` itself. */
function localOptionFlags(command: AnyCommand): string[][] {
  return command.getBaseOptions(true).map((option: { flags: string[] }) =>
    option.flags
  );
}

/** The type names of `command`'s declared arguments. */
function argumentTypes(command: AnyCommand): string[] {
  return (command.getArguments() as { type: string }[]).map((a) => a.type);
}

Deno.test("behavior flags: every --model option is spelled --behavior, --model", () => {
  const withModel: string[] = [];
  for (const { path, command } of commands) {
    for (const flags of localOptionFlags(command)) {
      if (!flags.includes("--model")) continue;
      withModel.push(path.join(" "));
      assertEquals(flags, ["--behavior", "--model"], path.join(" "));
    }
  }
  assertEquals(withModel.sort(), [
    "data delete",
    "data get",
    "data list",
    "data rename",
    "data search",
    "data versions",
    "datastore lock release",
    "report get",
    "report search",
  ]);
});

Deno.test("behavior flags: --restricted-model-types keeps its model name, with no behavior twin", () => {
  const all = commands.flatMap(({ command }) =>
    localOptionFlags(command).flat()
  );
  assert(all.includes("--restricted-model-types"));
  assertEquals(
    all.filter((flag) => /restricted-behavio(u)?r/.test(flag)),
    [],
  );
});

Deno.test("behavior flags: the behavior tree completes behavior types, the model tree model types", () => {
  const behaviorTypes = new Set<string>();
  const modelTypes = new Set<string>();
  for (const { path, command } of commands) {
    const types = argumentTypes(command);
    if (path[0] === "behavior") {
      for (const type of types) behaviorTypes.add(type);
      assertEquals(
        types.filter((t) => t === "model_name" || t === "model_type"),
        [],
        path.join(" "),
      );
    }
    if (path[0] === "model") {
      for (const type of types) modelTypes.add(type);
      assertEquals(
        types.filter((t) => t === "behavior_name" || t === "behavior_type"),
        [],
        path.join(" "),
      );
    }
  }
  assert(
    behaviorTypes.has("behavior_name") && behaviorTypes.has("behavior_type"),
  );
  assert(modelTypes.has("model_name") && modelTypes.has("model_type"));
});

Deno.test("behavior flags: data get, list and versions name a behavior positional", () => {
  for (const sub of ["get", "list", "versions"]) {
    const command = root.getCommand("data")!.getCommand(sub)!;
    const [first] = command.getArguments() as { name: string; type: string }[];
    assertEquals(
      [first.name, first.type],
      ["behavior_id_or_name", "behavior_name"],
      sub,
    );
  }
});

Deno.test("behavior flags: every completion type stays registered on the root", () => {
  assertEquals([...COMPLETION_TYPE_NAMES].sort(), [
    "behavior_name",
    "behavior_type",
    "model_name",
    "model_type",
    "workflow_name",
  ]);
  for (const name of COMPLETION_TYPE_NAMES) {
    assert(root.getType(name) !== undefined, name);
    assert(root.getCompletion(name) !== undefined, name);
  }
});

Deno.test("behavior flags: bash, zsh, fish and PowerShell completions still call model_name, model_type and workflow_name", () => {
  for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
    const script = shell === "powershell"
      ? generatePowerShellCompletions("swamp", root)
      : generateShellCompletions(root, shell);
    for (
      const type of [
        "model_name",
        "model_type",
        "workflow_name",
        "behavior_name",
        "behavior_type",
      ]
    ) {
      assert(script.includes(type), `${shell}: ${type}`);
    }
  }
});
