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
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { Command } from "@cliffy/command";
import { ModelNameType } from "../completion_types.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { type AnyCommand, buildCliSchema } from "../cli_schema.ts";
import { behaviorCommand, behaviorRunCommand } from "./behavior.ts";
import {
  modelMethodCommand,
  modelMethodRunCommand,
} from "./model_method_run.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("behaviorCommand: is a group named behavior with the behaviour alias", () => {
  assertEquals(behaviorCommand.getName(), "behavior");
  assertEquals(behaviorCommand.getAliases(), ["behaviour"]);
  assertStringIncludes(behaviorCommand.getDescription(), "model method");
});

Deno.test("behaviorCommand: run is its only subcommand", () => {
  const names = behaviorCommand.getCommands(true).map((cmd) => cmd.getName());
  assertEquals(names, ["run"]);
  assertStrictEquals(behaviorCommand.getCommand("run"), behaviorRunCommand);
});

Deno.test("behaviorRunCommand: declares the same arguments and options as model method run", () => {
  const argumentNames = (cmd: AnyCommand) =>
    cmd.getArguments().map((arg) =>
      `${arg.name}:${arg.type}:${arg.optional ? "optional" : "required"}`
    );
  const optionNames = (cmd: AnyCommand) =>
    cmd.getOptions(true).map((opt: { flags: string[] }) => opt.flags.join(" "))
      .sort();

  assertEquals(
    argumentNames(behaviorRunCommand),
    argumentNames(modelMethodRunCommand),
  );
  assertEquals(
    optionNames(behaviorRunCommand),
    optionNames(modelMethodRunCommand),
  );
  assertEquals(
    behaviorRunCommand.getDescription(),
    modelMethodRunCommand.getDescription(),
  );
});

Deno.test("behaviorRunCommand: is a distinct instance from model method run, each under its own parent", () => {
  assertNotStrictEquals(behaviorRunCommand, modelMethodRunCommand);
  assertStrictEquals(behaviorRunCommand.getParent(), behaviorCommand);
  assertStrictEquals(modelMethodRunCommand.getParent(), modelMethodCommand);
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

Deno.test("behaviorRunCommand: legacy examples are untouched", () => {
  const examples = modelMethodRunCommand.getExamples().map((e) =>
    e.description
  );
  for (const example of examples) {
    assertStringIncludes(example, "method run");
  }
});

Deno.test("behaviorCommand: the CLI schema lists run with its alias, arguments and options", () => {
  const schema = buildCliSchema(behaviorCommand, "test");
  assertEquals(schema.root.name, "behavior");
  assertEquals(schema.root.aliases, ["behaviour"]);
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
