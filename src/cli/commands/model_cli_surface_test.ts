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
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { Command } from "@cliffy/command";
import { generateShellCompletions } from "@cliffy/command/completions";
import { generatePowerShellCompletions } from "./completion_powershell.ts";
import { stripAnsiCode } from "@std/fmt/colors";
import { fromFileUrl } from "@std/path";
import { registerCompletionTypes } from "../completion_types.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { type AnyCommand, buildCliSchema } from "../cli_schema.ts";
import {
  type CommandSyntax,
  PREFERRED_SPELLING_EXAMPLE,
} from "./command_syntax.ts";
import { createModelCommand } from "./model.ts";
import { createModelCreateCommand } from "./model_create.ts";
import {
  cancelAllHint,
  createModelCancelCommand,
  MODEL_CANCEL_SYNTAX,
} from "./model_cancel.ts";
import { createModelDeleteCommand } from "./model_delete.ts";
import {
  createModelEditCommand,
  requireModelEditContent,
} from "./model_edit.ts";
import { createModelEvaluateCommand } from "./model_evaluate.ts";
import { createModelGetCommand } from "./model_get.ts";
import { createModelSearchCommand } from "./model_search.ts";
import { createModelValidateCommand } from "./model_validate.ts";
import { createModelMethodDescribeCommand } from "./model_method_describe.ts";
import { createModelMethodHistoryCommand } from "./model_method_history.ts";
import { createModelMethodHistoryGetCommand } from "./model_method_history_get.ts";
import { createModelMethodHistorySearchCommand } from "./model_method_history_search.ts";
import { createModelMethodHistoryLogsCommand } from "./model_method_history_logs.ts";
import { createModelOutputCommand } from "./model_output.ts";
import { createModelOutputGetCommand } from "./model_output_get.ts";
import { createModelOutputSearchCommand } from "./model_output_search.ts";
import { createModelOutputLogsCommand } from "./model_output_logs.ts";
import { createModelOutputDataCommand } from "./model_output_data.ts";
import { createTypeDescribeCommand } from "./type_describe.ts";
import { createTypeSearchCommand } from "./type_search.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

/**
 * pins everything a user or agent can see of the `swamp model` tree: help JSON,
 * every command's --help text and the shell completion scripts. The commands
 * share factories with `swamp behavior`, which has its own golden
 */
const GOLDEN_PATH = fromFileUrl(
  new URL("./test_helpers/model_cli_surface.json", import.meta.url),
);

interface ModelCliSurface {
  schema: unknown;
  schemaWithHidden: unknown;
  subtreeSchema: unknown;
  help: Record<string, string>;
  completions: Record<string, string>;
}

/**
 * a root shaped like `createRootCommand` (src/cli/mod.ts may not be imported
 * from src/), minus `.version()`, whose value changes with every build and
 * appears in subcommand help
 */
function surfaceRoot(model: AnyCommand): AnyCommand {
  return registerCompletionTypes(new Command())
    .name("swamp")
    .help({ colors: false })
    .description("AI Native Automation CLI")
    .globalOption("--json", "Output in JSON format (non-interactive)")
    .globalOption(
      "--log",
      "Show behavior and workflow run logs in terminal output",
    )
    .globalOption(
      "--log-level <level:string>",
      "Set log level (trace, debug, info, warning, error, fatal)",
    )
    .globalOption("-q, --quiet", "Suppress non-essential output")
    .globalOption("-v, --verbose", "Show detailed output")
    .globalOption("--no-telemetry", "Disable telemetry for this invocation")
    .globalOption(
      "--show-properties",
      "Show structured properties in log output",
    )
    .globalOption("--no-color", "Disable colored output")
    .command("model", model) as unknown as AnyCommand;
}

function normalize(text: string): string {
  return stripAnsiCode(text).replaceAll("\r\n", "\n");
}

function collectHelp(
  command: AnyCommand,
  path: string,
  into: Record<string, string>,
): void {
  into[path] = normalize(command.getHelp());
  for (const child of command.getCommands(true)) {
    collectHelp(child, `${path} ${child.getName()}`, into);
  }
}

async function captureSurface(): Promise<ModelCliSurface> {
  const root = surfaceRoot(await createModelCommand());
  const model = root.getCommand("model") as AnyCommand;
  const schemaModel = (includeHidden: boolean) =>
    buildCliSchema(root, "golden", { includeHidden }).root.subcommands.find(
      (cmd) => cmd.name === "model",
    );
  const help: Record<string, string> = {};
  collectHelp(model, "swamp model", help);
  return {
    schema: schemaModel(false),
    schemaWithHidden: schemaModel(true),
    subtreeSchema: buildCliSchema(model, "golden", {
      stripGlobalOptions: true,
    }),
    help,
    completions: {
      ...Object.fromEntries(
        (["bash", "fish", "zsh"] as const).map((shell) => [
          shell,
          normalize(generateShellCompletions(root, shell)),
        ]),
      ),
      powershell: normalize(generatePowerShellCompletions("swamp", root)),
    },
  };
}

Deno.test("model CLI surface: matches the golden file", async () => {
  const actual = await captureSurface();
  if (Deno.env.get("SWAMP_UPDATE_GOLDEN") === "1") {
    await Deno.writeTextFile(
      GOLDEN_PATH,
      JSON.stringify(actual, null, 2) + "\n",
    );
  }
  const expected = JSON.parse(
    await Deno.readTextFile(GOLDEN_PATH),
  ) as ModelCliSurface;
  assertEquals(actual.schema, expected.schema);
  assertEquals(actual.schemaWithHidden, expected.schemaWithHidden);
  assertEquals(actual.subtreeSchema, expected.subtreeSchema);
  assertEquals(Object.keys(actual.help), Object.keys(expected.help));
  for (const path of Object.keys(expected.help)) {
    assertEquals(actual.help[path], expected.help[path], path);
  }
  assertEquals(actual.completions, expected.completions);
});

function allCommands(command: AnyCommand, into: AnyCommand[] = []) {
  into.push(command);
  for (const child of command.getCommands(true)) allCommands(child, into);
  return into;
}

Deno.test("createModelCommand: two loads share no command instance", async () => {
  const first = allCommands(await createModelCommand());
  const second = allCommands(await createModelCommand());
  assertEquals(second.length, first.length);
  for (const command of second) {
    assert(
      first.every((other) => other !== command),
      `${command.getName()} is shared between two loads`,
    );
  }
});

const LEAF_FACTORIES: ReadonlyArray<
  readonly [string, (syntax: CommandSyntax) => unknown]
> = [
  ["cancel", createModelCancelCommand],
  ["create", createModelCreateCommand],
  ["delete", createModelDeleteCommand],
  ["edit", createModelEditCommand],
  ["evaluate", createModelEvaluateCommand],
  ["get", createModelGetCommand],
  ["search", createModelSearchCommand],
  ["validate", createModelValidateCommand],
  ["method describe", createModelMethodDescribeCommand],
  ["method history get", createModelMethodHistoryGetCommand],
  ["method history search", createModelMethodHistorySearchCommand],
  ["method history logs", createModelMethodHistoryLogsCommand],
  ["output get", createModelOutputGetCommand],
  ["output search", createModelOutputSearchCommand],
  ["output logs", createModelOutputLogsCommand],
  ["output data", createModelOutputDataCommand],
  ["type describe", createTypeDescribeCommand],
  ["type search", createTypeSearchCommand],
  ["output", (syntax) => createModelOutputCommand(syntax)],
  ["method history", (syntax) => createModelMethodHistoryCommand(syntax)],
];

Deno.test("model command factories: each call returns a new instance", () => {
  for (const [path, factory] of LEAF_FACTORIES) {
    const syntax: CommandSyntax = {
      invocation: `swamp x ${path}`,
      surface: "model",
    };
    assertNotStrictEquals(factory(syntax), factory(syntax), path);
  }
});

Deno.test("model command factories: examples name the given syntax", () => {
  for (const [path, factory] of LEAF_FACTORIES) {
    const syntax: CommandSyntax = {
      invocation: `swamp x ${path}`,
      surface: "model",
    };
    const examples = (factory(syntax) as AnyCommand).getExamples() as {
      description: string;
    }[];
    assert(examples.length > 0, path);
    for (const { description } of examples) {
      assertStringIncludes(description, syntax.invocation, path);
      assert(!description.includes("swamp model"), `${path}: ${description}`);
      assert(!description.includes("swamp type"), `${path}: ${description}`);
    }
  }
});

Deno.test("model type commands: legacy examples name swamp model type", async () => {
  const typeGroup = (await createModelCommand()).getCommand(
    "type",
  ) as AnyCommand;
  for (const word of ["describe", "search"]) {
    const examples = (typeGroup.getCommand(word) as AnyCommand)
      .getExamples() as { name: string; description: string }[];
    assert(examples.length > 0, word);
    for (const { name, description } of examples) {
      if (name === PREFERRED_SPELLING_EXAMPLE) continue;
      assert(
        description.startsWith(`swamp model type ${word}`),
        `${word}: ${description}`,
      );
    }
  }
});

Deno.test("cancelAllHint: names the cancel command of the given syntax", () => {
  assertStringIncludes(
    cancelAllHint({ invocation: "swamp x cancel", surface: "model" }),
    "'swamp x cancel --all' stops them",
  );
  assertEquals(
    cancelAllHint(MODEL_CANCEL_SYNTAX),
    "'swamp model cancel --all' stops them, along with every other running method run a swamp serve does not own.",
  );
});

Deno.test("requireModelEditContent: refusal names the edit command of the given syntax", () => {
  const error = assertThrows(() =>
    requireModelEditContent("", {
      invocation: "swamp x edit",
      surface: "model",
    })
  );
  assertStringIncludes(
    (error as Error).message,
    "'swamp x edit' with --server",
  );
  assertStringIncludes(
    (error as Error).message,
    "cat edited.yaml | swamp x edit <name>",
  );
  assertEquals(
    requireModelEditContent("name: a\n", {
      invocation: "swamp x edit",
      surface: "model",
    }),
    "name: a\n",
  );
});
