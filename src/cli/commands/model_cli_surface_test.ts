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
import { registerCompletionTypes } from "../completion_types.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { type AnyCommand, buildCliSchema } from "../cli_schema.ts";
import {
  type CommandSyntax,
  PREFERRED_SPELLING_EXAMPLE,
} from "./command_syntax.ts";
import {
  createModelCommand,
  createModelCreateCommand,
  MODEL_CREATE_SYNTAX,
  MODEL_SYNTAX,
  modelCommand,
} from "./model_create.ts";
import {
  cancelAllHint,
  createModelCancelCommand,
  MODEL_CANCEL_SYNTAX,
} from "./model_cancel.ts";
import {
  createModelDeleteCommand,
  MODEL_DELETE_SYNTAX,
} from "./model_delete.ts";
import {
  createModelEditCommand,
  MODEL_EDIT_SYNTAX,
  requireModelEditContent,
} from "./model_edit.ts";
import {
  createModelEvaluateCommand,
  MODEL_EVALUATE_SYNTAX,
} from "./model_evaluate.ts";
import { createModelGetCommand, MODEL_GET_SYNTAX } from "./model_get.ts";
import {
  createModelSearchCommand,
  MODEL_SEARCH_SYNTAX,
} from "./model_search.ts";
import {
  createModelValidateCommand,
  MODEL_VALIDATE_SYNTAX,
} from "./model_validate.ts";
import {
  createModelMethodCommand,
  createModelMethodRunCommand,
  MODEL_METHOD_RUN_SYNTAX,
  MODEL_METHOD_SYNTAX,
} from "./model_method_run.ts";
import {
  createModelMethodDescribeCommand,
  MODEL_METHOD_DESCRIBE_SYNTAX,
} from "./model_method_describe.ts";
import {
  createModelMethodHistoryCommand,
  MODEL_METHOD_HISTORY_SYNTAX,
} from "./model_method_history.ts";
import {
  createModelMethodHistoryGetCommand,
  MODEL_METHOD_HISTORY_GET_SYNTAX,
} from "./model_method_history_get.ts";
import {
  createModelMethodHistorySearchCommand,
  MODEL_METHOD_HISTORY_SEARCH_SYNTAX,
} from "./model_method_history_search.ts";
import {
  createModelMethodHistoryLogsCommand,
  MODEL_METHOD_HISTORY_LOGS_SYNTAX,
} from "./model_method_history_logs.ts";
import {
  createModelOutputCommand,
  MODEL_OUTPUT_SYNTAX,
} from "./model_output.ts";
import {
  createModelOutputGetCommand,
  MODEL_OUTPUT_GET_SYNTAX,
} from "./model_output_get.ts";
import {
  createModelOutputSearchCommand,
  MODEL_OUTPUT_SEARCH_SYNTAX,
} from "./model_output_search.ts";
import {
  createModelOutputLogsCommand,
  MODEL_OUTPUT_LOGS_SYNTAX,
} from "./model_output_logs.ts";
import {
  createModelOutputDataCommand,
  MODEL_OUTPUT_DATA_SYNTAX,
} from "./model_output_data.ts";
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
 * scripts. The commands are built from factories shared with `swamp behavior`
 * (swamp-club#3330, swamp-club#3331); the behavior tree has its own golden
 * (behavior_cli_surface_test.ts). Regenerate this one only for an intended
 * surface change, with
 * `SWAMP_UPDATE_GOLDEN=1 deno run test src/cli/commands/model_cli_surface_test.ts`.
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
 * A root shaped like `createRootCommand` (src/cli/mod.ts may not be imported
 * from src/), minus `.version()`, whose value changes with every build and
 * appears in subcommand help.
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
 * A `model` tree built entirely from factories, each leaf from its legacy
 * syntax constant. A syntax derived with `subcommandSyntax` has no preferred
 * spelling (that is a per-command example, swamp-club#3331), and the run
 * leaf has legacy text no derivation reproduces (`swamp model @type method
 * run …`), so every leaf is passed in.
 */
function freshLegacyModelCommand(): AnyCommand {
  return createModelCommand(MODEL_SYNTAX, {
    cancel: createModelCancelCommand(MODEL_CANCEL_SYNTAX),
    create: createModelCreateCommand(MODEL_CREATE_SYNTAX),
    delete: createModelDeleteCommand(MODEL_DELETE_SYNTAX),
    edit: createModelEditCommand(MODEL_EDIT_SYNTAX),
    evaluate: createModelEvaluateCommand(MODEL_EVALUATE_SYNTAX),
    get: createModelGetCommand(MODEL_GET_SYNTAX),
    search: createModelSearchCommand(MODEL_SEARCH_SYNTAX),
    validate: createModelValidateCommand(MODEL_VALIDATE_SYNTAX),
    method: createModelMethodCommand(MODEL_METHOD_SYNTAX, {
      run: createModelMethodRunCommand(MODEL_METHOD_RUN_SYNTAX),
      describe: createModelMethodDescribeCommand(MODEL_METHOD_DESCRIBE_SYNTAX),
      history: createModelMethodHistoryCommand(MODEL_METHOD_HISTORY_SYNTAX, {
        get: createModelMethodHistoryGetCommand(
          MODEL_METHOD_HISTORY_GET_SYNTAX,
        ),
        search: createModelMethodHistorySearchCommand(
          MODEL_METHOD_HISTORY_SEARCH_SYNTAX,
        ),
        logs: createModelMethodHistoryLogsCommand(
          MODEL_METHOD_HISTORY_LOGS_SYNTAX,
        ),
      }),
    }),
    output: createModelOutputCommand(MODEL_OUTPUT_SYNTAX, {
      get: createModelOutputGetCommand(MODEL_OUTPUT_GET_SYNTAX),
      search: createModelOutputSearchCommand(MODEL_OUTPUT_SEARCH_SYNTAX),
      logs: createModelOutputLogsCommand(MODEL_OUTPUT_LOGS_SYNTAX),
      data: createModelOutputDataCommand(MODEL_OUTPUT_DATA_SYNTAX),
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
  const tree = createModelCommand({ invocation: "swamp x", surface: "model" });
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

Deno.test("model type commands: legacy examples name swamp model type", () => {
  const typeGroup = (modelCommand as unknown as AnyCommand).getCommand(
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
