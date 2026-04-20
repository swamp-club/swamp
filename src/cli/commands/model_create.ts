// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { Command } from "@cliffy/command";
import {
  consumeStream,
  createLibSwampContext,
  createModelCreateDeps,
  modelCreate,
} from "../../libswamp/mod.ts";
import { createModelCreateRenderer } from "../../presentation/renderers/model_create.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { parseKeyValueInputs } from "../input_parser.ts";
import { modelValidateCommand } from "./model_validate.ts";
import { modelMethodCommand } from "./model_method_run.ts";
import { modelSearchAction, modelSearchCommand } from "./model_search.ts";
import { modelGetCommand } from "./model_get.ts";
import { modelDeleteCommand } from "./model_delete.ts";
import { modelEditCommand } from "./model_edit.ts";
import { modelEvaluateCommand } from "./model_evaluate.ts";
import { modelOutputCommand } from "./model_output.ts";
import { modelTypeCommand } from "./model_type.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelCreateCommand = new Command()
  .description("Create a new model definition")
  .example("Create a model", "swamp model create aws-ec2 my-server")
  .example(
    "With global args",
    "swamp model create aws-ec2 my-server --global-arg region=us-east-1",
  )
  .arguments("<type:model_type> <name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--global-arg <arg:string>",
    "Set global argument (key=value, repeatable)",
    { collect: true },
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, typeArg: string, name: string) {
    const cliCtx = createContext(options as GlobalOptions, ["model", "create"]);
    cliCtx.logger
      .debug`Creating model definition: type=${typeArg}, name=${name}`;

    const { repoDir } = await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    // Parse --global-arg options (stays in CLI)
    const globalArgEntries: string[] = options.globalArg ?? [];
    const globalArguments = globalArgEntries.length > 0
      ? await parseKeyValueInputs(globalArgEntries)
      : undefined;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createModelCreateDeps(repoDir);
    const renderer = createModelCreateRenderer(cliCtx.outputMode);
    await consumeStream(
      modelCreate(ctx, deps, { typeArg, name, globalArguments }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model create command completed");
  });

export const modelCommand = new Command()
  .name("model")
  .description("Manage models")
  .error(unknownCommandErrorHandler)
  .action(function () {
    this.showHelp();
  })
  .command("create", modelCreateCommand)
  .command("delete", modelDeleteCommand)
  .command("edit", modelEditCommand)
  .command("evaluate", modelEvaluateCommand)
  .command("get", modelGetCommand)
  .command("search", modelSearchCommand)
  .command("validate", modelValidateCommand)
  .command("method", modelMethodCommand)
  .command("output", modelOutputCommand)
  .command("type", modelTypeCommand)
  .command(
    "list",
    new Command()
      .description("Alias for model search")
      .hidden()
      .arguments("[query:string]")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      )
      .action(modelSearchAction),
  );
