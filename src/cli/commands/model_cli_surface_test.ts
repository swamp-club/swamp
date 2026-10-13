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

import { assertEquals } from "@std/assert";
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
import { modelCommand } from "./model_create.ts";

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
function surfaceRoot(): AnyCommand {
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
    .command("model", modelCommand) as unknown as AnyCommand;
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

function captureSurface(): ModelCliSurface {
  const root = surfaceRoot();
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
