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
import { stripAnsiCode } from "@std/fmt/colors";
import { fromFileUrl } from "@std/path";
import {
  ModelNameType,
  ModelTypeType,
  WorkflowNameType,
} from "../completion_types.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { type AnyCommand, buildCliSchema } from "../cli_schema.ts";
import type { CommandSyntax } from "./command_syntax.ts";
import {
  createModelCommand,
  createModelCreateCommand,
  MODEL_SYNTAX,
  modelCommand,
} from "./model_create.ts";
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
import {
  createModelMethodCommand,
  createModelMethodRunCommand,
  MODEL_METHOD_RUN_SYNTAX,
  MODEL_METHOD_SYNTAX,
} from "./model_method_run.ts";
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
import { createModelTypeCommand, MODEL_TYPE_SYNTAX } from "./model_type.ts";
import {
  createTypeDescribeCommand,
  MODEL_TYPE_DESCRIBE_SYNTAX,
} from "./type_describe.ts";
import {
  createTypeSearchCommand,
  MODEL_TYPE_SEARCH_SYNTAX,
} from "./type_search.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

/**
 * The golden file pins everything a user or agent can see of the `swamp
 * model` tree: the `swamp help` JSON, the `--help` text of every command
 * (examples and usage are not in the schema) and the shell completion
 * scripts. The commands are being rebuilt from factories so `swamp behavior`
 * can share them (swamp-club#3330); this file must not change while that
 * happens. Regenerate it only for an intended surface change, with
 * `SWAMP_UPDATE_GOLDEN=1 deno run test src/cli/commands/model_cli_surface_test.ts`.
 */
const GOLDEN_PATH = fromFileUrl(
  new URL("./testdata/model_cli_surface.json", import.meta.url),
);

interface ModelCliSurface {
  schema: unknown;
  schemaWithHidden: unknown;
  subtreeSchema: unknown;
  help: Record<string, string>;
  completions: Record<string, string>;
}

/**
 * A root shaped like `createRootCommand` (src/cli/mod.ts may not be imported
 * from src/), minus `.version()`, whose value changes with every build and
 * appears in subcommand help.
 */
function surfaceRoot(model: AnyCommand): AnyCommand {
  return new Command()
    .name("swamp")
    .help({ colors: false })
    .description("AI Native Automation CLI")
    .globalType("model_name", new ModelNameType())
    .globalType("model_type", new ModelTypeType())
    .globalType("workflow_name", new WorkflowNameType())
    .globalOption("--json", "Output in JSON format (non-interactive)")
    .globalOption(
      "--log",
      "Show model and workflow run logs in terminal output",
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

function captureSurface(
  modelTree: AnyCommand = modelCommand as unknown as AnyCommand,
): ModelCliSurface {
  const root = surfaceRoot(modelTree);
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
    completions: Object.fromEntries(
      (["bash", "fish", "zsh"] as const).map((shell) => [
        shell,
        normalize(generateShellCompletions(root, shell)),
      ]),
    ),
  };
}

Deno.test("model CLI surface: matches the golden file", async () => {
  const actual = captureSurface();
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

async function readGolden(): Promise<ModelCliSurface> {
  return JSON.parse(await Deno.readTextFile(GOLDEN_PATH)) as ModelCliSurface;
}

function allCommands(command: AnyCommand, into: AnyCommand[] = []) {
  into.push(command);
  for (const child of command.getCommands(true)) allCommands(child, into);
  return into;
}

/**
 * A `model` tree built entirely from factories. The run leaf and the type
 * leaves have legacy text no syntax derivation reproduces (`swamp model
 * @type method run …`, and `swamp type …` examples), so those are passed in
 * as fresh leaves built from their legacy syntaxes.
 */
function freshLegacyModelCommand(): AnyCommand {
  return createModelCommand(MODEL_SYNTAX, {
    method: createModelMethodCommand(MODEL_METHOD_SYNTAX, {
      run: createModelMethodRunCommand(MODEL_METHOD_RUN_SYNTAX),
    }),
    type: createModelTypeCommand(MODEL_TYPE_SYNTAX, {
      describe: createTypeDescribeCommand(MODEL_TYPE_DESCRIBE_SYNTAX),
      search: createTypeSearchCommand(MODEL_TYPE_SEARCH_SYNTAX),
    }),
  }) as unknown as AnyCommand;
}

Deno.test("createModelCommand: a fresh tree matches the golden file", async () => {
  const actual = captureSurface(freshLegacyModelCommand());
  const expected = await readGolden();
  assertEquals(actual.schema, expected.schema);
  assertEquals(actual.schemaWithHidden, expected.schemaWithHidden);
  assertEquals(actual.subtreeSchema, expected.subtreeSchema);
  assertEquals(Object.keys(actual.help), Object.keys(expected.help));
  for (const path of Object.keys(expected.help)) {
    assertEquals(actual.help[path], expected.help[path], path);
  }
  assertEquals(actual.completions, expected.completions);
});

Deno.test("createModelCommand: a fresh tree shares no command instance with modelCommand", () => {
  const legacy = allCommands(modelCommand as unknown as AnyCommand);
  const fresh = allCommands(freshLegacyModelCommand());
  assertEquals(fresh.length, legacy.length);
  for (const command of fresh) {
    assert(
      legacy.every((other) => other !== command),
      `${command.getName()} is shared with the legacy tree`,
    );
  }
});

Deno.test("createModelCommand: default children render the given syntax", () => {
  const tree = createModelCommand({ invocation: "swamp x" });
  const examplesOf = (path: string[]) => {
    let command = tree as unknown as AnyCommand;
    for (const word of path) command = command.getCommand(word) as AnyCommand;
    return command.getExamples().map((e: { description: string }) =>
      e.description
    );
  };
  assertEquals(examplesOf(["get"])[0], "swamp x get my-server");
  assertEquals(
    examplesOf(["type", "describe"])[0],
    "swamp x type describe aws-ec2",
  );
  assertEquals(
    examplesOf(["method", "run"])[0],
    "swamp x method run my-server getSystemInfo",
  );
  assertEquals(
    examplesOf(["method", "run"])[2],
    "swamp x method run @swamp/aws/ec2/vpc create my-vpc --input region=us-east-1",
  );
  assertEquals(
    examplesOf(["method", "history", "logs"])[0],
    "swamp x method history logs abc123",
  );
  assertEquals(examplesOf(["output"])[0], "swamp x output my-server");
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
    const syntax = { invocation: `swamp x ${path}` };
    assertNotStrictEquals(factory(syntax), factory(syntax), path);
  }
});

Deno.test("model command factories: examples name the given syntax", () => {
  for (const [path, factory] of LEAF_FACTORIES) {
    const syntax = { invocation: `swamp x ${path}` };
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

Deno.test("cancelAllHint: names the cancel command of the given syntax", () => {
  assertStringIncludes(
    cancelAllHint({ invocation: "swamp x cancel" }),
    "'swamp x cancel --all' stops them",
  );
  assertEquals(
    cancelAllHint(MODEL_CANCEL_SYNTAX),
    "'swamp model cancel --all' stops them, along with every other running method run a swamp serve does not own.",
  );
});

Deno.test("requireModelEditContent: refusal names the edit command of the given syntax", () => {
  const error = assertThrows(() =>
    requireModelEditContent("", { invocation: "swamp x edit" })
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
    requireModelEditContent("name: a\n", { invocation: "swamp x edit" }),
    "name: a\n",
  );
});
