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

import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { Command } from "@cliffy/command";
import { ModelNameType } from "../completion_types.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { type AnyCommand, buildCliSchema } from "../cli_schema.ts";
import { PREFERRED_SPELLING_EXAMPLE } from "./command_syntax.ts";
import { behaviorCommand, behaviorRunCommand } from "./behavior.ts";
import { modelCommand } from "./model_create.ts";
import {
  modelMethodCommand,
  modelMethodRunCommand,
} from "./model_method_run.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

/** The command at `path` (words after the group) under `group`. */
function at(group: AnyCommand, path: string): AnyCommand {
  let command = group;
  for (const word of path.split(" ")) {
    const next = command.getCommand(word, true);
    assert(next !== undefined, `${group.getName()} ${path}: no ${word}`);
    command = next;
  }
  return command;
}

/**
 * Each `swamp behavior` command and the path of its legacy twin under
 * `swamp model`. `run`, `describe` and `history` come from under `model
 * method`; there is no `method` level under `behavior`.
 */
const TWINS: ReadonlyArray<readonly [behavior: string, model: string]> = [
  ["run", "method run"],
  ["create", "create"],
  ["get", "get"],
  ["edit", "edit"],
  ["delete", "delete"],
  ["validate", "validate"],
  ["evaluate", "evaluate"],
  ["search", "search"],
  ["cancel", "cancel"],
  ["describe", "method describe"],
  ["history", "method history"],
  ["history get", "method history get"],
  ["history search", "method history search"],
  ["history logs", "method history logs"],
  ["output", "output"],
  ["output get", "output get"],
  ["output search", "output search"],
  ["output logs", "output logs"],
  ["output data", "output data"],
  ["type", "type"],
  ["type describe", "type describe"],
  ["type search", "type search"],
];

const behaviorTree = behaviorCommand as unknown as AnyCommand;
const modelTree = modelCommand as unknown as AnyCommand;

function argumentSignature(cmd: AnyCommand): string[] {
  return cmd.getArguments().map((
    arg: { name: string; type: string; optional?: boolean },
  ) => `${arg.name}:${arg.type}:${arg.optional ? "optional" : "required"}`);
}

function optionFlags(cmd: AnyCommand): string[] {
  return cmd.getOptions(true).map((opt: { flags: string[] }) =>
    opt.flags.join(" ")
  ).sort();
}

/**
 * The action a command runs. Cliffy keeps it on the command's settings and
 * has no public getter; integration/json_mode_conformance_test.ts reads it
 * the same way.
 */
function actionHandler(cmd: unknown): unknown {
  return (cmd as { settings?: { actionHandler?: unknown } }).settings
    ?.actionHandler;
}

function examplesOf(cmd: AnyCommand): { name: string; description: string }[] {
  return cmd.getExamples();
}

Deno.test("behaviorCommand: is a group named behavior with the behaviour alias", () => {
  assertEquals(behaviorCommand.getName(), "behavior");
  assertEquals(behaviorCommand.getAliases(), ["behaviour"]);
  assertEquals(
    behaviorCommand.getDescription(),
    "Manage and run behaviors (preferred over 'model')",
  );
});

Deno.test("behaviorCommand: has the full behavior command set and no method level", () => {
  const names = behaviorCommand.getCommands(true).map((cmd) => cmd.getName());
  assertEquals(names, [
    "run",
    "create",
    "get",
    "edit",
    "delete",
    "validate",
    "evaluate",
    "search",
    "cancel",
    "describe",
    "history",
    "output",
    "type",
  ]);
  assertEquals(behaviorCommand.getCommand("method", true), undefined);
  assertStrictEquals(behaviorCommand.getCommand("run"), behaviorRunCommand);
});

Deno.test("behavior commands: declare the same arguments, options and aliases as their model twins", () => {
  for (const [behaviorPath, modelPath] of TWINS) {
    const preferred = at(behaviorTree, behaviorPath);
    const legacy = at(modelTree, modelPath);
    assertEquals(
      argumentSignature(preferred),
      argumentSignature(legacy),
      behaviorPath,
    );
    assertEquals(optionFlags(preferred), optionFlags(legacy), behaviorPath);
    assertEquals(preferred.getAliases(), legacy.getAliases(), behaviorPath);
    assertEquals(
      preferred.getCommands(true).map((c: AnyCommand) => c.getName()),
      legacy.getCommands(true).map((c: AnyCommand) => c.getName()),
      behaviorPath,
    );
  }
});

Deno.test("behavior commands: run the same action code as their model twins, so they log under the same model category", () => {
  for (const [behaviorPath, modelPath] of TWINS) {
    const preferred = actionHandler(at(behaviorTree, behaviorPath));
    const legacy = actionHandler(at(modelTree, modelPath));
    assertEquals(typeof preferred, "function", behaviorPath);
    // The same factory closure: identical source, including the
    // createContext(["model", ...]) category the run-file sink keys on.
    assertEquals(String(preferred), String(legacy), behaviorPath);
  }
  const run = String(actionHandler(behaviorRunCommand));
  assert(
    /createContext\([^)]*\[\s*"model",\s*"method",\s*"run",?\s*\]/.test(run),
  );
});

Deno.test("behavior commands: search and type keep their list and get aliases", () => {
  assertEquals(at(behaviorTree, "search").getAliases(), ["list"]);
  assertEquals(at(behaviorTree, "type describe").getAliases(), ["get"]);
  assertEquals(at(behaviorTree, "type search").getAliases(), ["list"]);
  assertEquals(at(behaviorTree, "history search").getAliases(), ["list"]);
  assertEquals(at(behaviorTree, "output search").getAliases(), ["list"]);
});

Deno.test("behavior commands: each is a distinct instance from its model twin, under its own parent", () => {
  for (const [behaviorPath, modelPath] of TWINS) {
    const preferred = at(behaviorTree, behaviorPath);
    const legacy = at(modelTree, modelPath);
    assertNotStrictEquals(preferred, legacy, behaviorPath);
    const words = behaviorPath.split(" ");
    const expectedParent = words.length === 1
      ? behaviorTree
      : at(behaviorTree, words.slice(0, -1).join(" "));
    assertStrictEquals(preferred.getParent(), expectedParent, behaviorPath);
  }
});

Deno.test("behavior commands: examples use the swamp behavior spelling only", () => {
  for (const [behaviorPath] of TWINS) {
    const command = at(behaviorTree, behaviorPath);
    for (const { name, description } of examplesOf(command)) {
      assertStringIncludes(description, "swamp behavior", behaviorPath);
      assertEquals(description.includes("swamp model"), false, description);
      assertEquals(description.includes("swamp type"), false, description);
      assertEquals(description.includes("method run"), false, description);
      assertNotStrictEquals(name, PREFERRED_SPELLING_EXAMPLE);
    }
  }
  const typeDescribe = examplesOf(at(behaviorTree, "type describe"));
  assertEquals(
    typeDescribe[0].description,
    "swamp behavior type describe aws-ec2",
  );
  const typeSearch = examplesOf(at(behaviorTree, "type search"));
  assertEquals(typeSearch[0].description, "swamp behavior type search");
});

Deno.test("behavior commands: descriptions say behavior, never model", () => {
  for (const [behaviorPath] of TWINS) {
    const [summary] = at(behaviorTree, behaviorPath).getDescription().split(
      "\n",
    );
    assertEquals(/\bmodels?\b/i.test(summary), false, summary);
  }
  assertEquals(
    at(behaviorTree, "create").getDescription(),
    "Create a new behavior definition",
  );
  assertEquals(
    at(modelTree, "create").getDescription(),
    "Create a new model definition",
  );
});

Deno.test("model commands: list the preferred spelling as their last example", () => {
  for (const [behaviorPath, modelPath] of TWINS) {
    const legacy = at(modelTree, modelPath);
    const examples = examplesOf(legacy);
    if (examples.length === 0) continue; // the model, method and type groups
    const last = examples[examples.length - 1];
    assertEquals(last.name, PREFERRED_SPELLING_EXAMPLE, modelPath);
    assertStringIncludes(
      last.description,
      `swamp behavior ${behaviorPath}`,
      modelPath,
    );
    // Only the last example is the preferred spelling.
    assertEquals(
      examples.filter((e) => e.name === PREFERRED_SPELLING_EXAMPLE).length,
      1,
      modelPath,
    );
  }
  assertEquals(
    examplesOf(modelMethodRunCommand).at(-1)?.description,
    "swamp behavior run my-server getSystemInfo",
  );
});

Deno.test("behaviorRunCommand: describes the run in behavior words, otherwise as model method run", () => {
  // Only the prose changes; the error codes themselves are a stable contract.
  assertEquals(
    behaviorRunCommand.getDescription(),
    modelMethodRunCommand.getDescription()
      .replace(
        "Execute a method on a model.",
        "Execute a method on a behavior.",
      )
      .replace("holds the model lock", "holds the behavior lock")
      .replace("No model matches", "No behavior matches")
      .replace("The model does not define", "The behavior does not define"),
  );
  assertStringIncludes(behaviorRunCommand.getDescription(), "model_not_found");
});

Deno.test("behaviorRunCommand: examples use the new syntax only", () => {
  const examples = behaviorRunCommand.getExamples().map((e) => e.description);
  assertEquals(examples.length > 0, true);
  for (const example of examples) {
    assertStringIncludes(example, "swamp behavior run");
    assertEquals(example.includes("method run"), false);
  }
  assertStringIncludes(
    examples.join("\n"),
    "swamp behavior run @swamp/aws/ec2/vpc create my-vpc",
  );
});

Deno.test("behaviorRunCommand: legacy examples keep the legacy syntax, then the preferred spelling", () => {
  const examples = modelMethodRunCommand.getExamples();
  for (const example of examples.slice(0, -1)) {
    assertStringIncludes(example.description, "method run");
  }
  assertEquals(examples.at(-1)?.name, PREFERRED_SPELLING_EXAMPLE);
});

Deno.test("behaviorCommand: the CLI schema lists the full subtree", () => {
  const schema = buildCliSchema(behaviorCommand, "test");
  assertEquals(schema.root.name, "behavior");
  assertEquals(schema.root.aliases, ["behaviour"]);
  const names = (cmd: { name: string; subcommands: unknown[] }): string[] => [
    cmd.name,
    ...(cmd.subcommands as { name: string; subcommands: unknown[] }[])
      .flatMap((sub) => names(sub).map((n) => `${cmd.name} ${n}`)),
  ];
  assertEquals(
    names(schema.root).slice(1).map((n) => n.replace(/^behavior /, "")),
    [
      "run",
      "create",
      "get",
      "edit",
      "delete",
      "validate",
      "evaluate",
      "search",
      "cancel",
      "describe",
      "history",
      "history get",
      "history search",
      "history logs",
      "output",
      "output get",
      "output search",
      "output logs",
      "output data",
      "type",
      "type describe",
      "type search",
    ],
  );
  const run = schema.root.subcommands.find((cmd) => cmd.name === "run");
  assertEquals(run !== undefined, true);
  assertEquals(
    run!.arguments.map((arg) => arg.name),
    ["model_or_type", "method_name", "definition_name"],
  );
  const flags = run!.options.flatMap((opt) => opt.flags);
  for (
    const expected of ["--input", "--server", "--token", "--timeout", "--stdin"]
  ) {
    assertEquals(flags.includes(expected), true, expected);
  }
});

/** A root mirroring runCli's wiring: both groups, the model_name type, --json. */
function root(): AnyCommand {
  return new Command()
    .globalType("model_name", new ModelNameType())
    .globalOption("--json", "JSON output")
    .command("behavior", behaviorCommand)
    .command("model", new Command().command("method", modelMethodCommand));
}

Deno.test("behaviorRunCommand: direct type execution without a definition name rejects with the new syntax", async () => {
  try {
    await root().parse([
      "behavior",
      "run",
      "@swamp/echo",
      "echo",
      "--json",
      "--server",
      "ws://localhost:9999",
      "--token",
      "test.token",
    ]);
    throw new Error("expected UserError");
  } catch (err) {
    const message = (err as Error).message;
    assertStringIncludes(
      message,
      "Direct type execution requires a definition name",
    );
    assertStringIncludes(message, "swamp behavior run @swamp/echo echo <name>");
    assertEquals(message.includes("method run"), false);
  }
});

Deno.test("modelMethodRunCommand: direct type execution error still names the legacy syntax", async () => {
  try {
    await root().parse([
      "model",
      "method",
      "run",
      "@swamp/echo",
      "echo",
      "--json",
      "--server",
      "ws://localhost:9999",
      "--token",
      "test.token",
    ]);
    throw new Error("expected UserError");
  } catch (err) {
    assertStringIncludes(
      (err as Error).message,
      "swamp model @swamp/echo method run echo <name>",
    );
  }
});
