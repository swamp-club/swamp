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
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { DefaultMethodExecutionService } from "../../domain/models/method_execution_service.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { runFileSink } from "../../infrastructure/logging/logger.ts";
import { parseInputs } from "../input_parser.ts";
import { parseTags } from "./data_search.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";
import { join } from "@std/path";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { modelMethodHistoryCommand } from "./model_method_history.ts";
import { modelMethodDescribeCommand } from "./model_method_describe.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import {
  consumeStream,
  createLibSwampContext,
  modelMethodRun,
  type ModelMethodRunDeps,
} from "../../libswamp/mod.ts";
import { createModelMethodRunRenderer } from "../../presentation/renderers/model_method_run.ts";

// Cliffy's custom type system returns `unknown` for custom types like `model_name`,
// but we need to pass `options` to functions expecting specific types. Using `any`
// here is the pragmatic workaround for Cliffy's type inference limitations.
// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodRunCommand = new Command()
  .name("run")
  .description("Execute a method on a model")
  .example("Run a method", "swamp model method run my-server getSystemInfo")
  .example(
    "Run with inputs",
    "swamp model method run my-server deploy --input env=prod",
  )
  .arguments("<model_id_or_name:model_name> <method_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--last-evaluated",
    "Skip CEL evaluation, use previously evaluated definition",
    { default: false },
  )
  .option("--input <value:string>", "Input values (key=value or JSON)", {
    collect: true,
  })
  .option("--input-file <file:string>", "Input values from YAML file")
  .option(
    "--tag <tag:string>",
    "Add tag to produced data (KEY=VALUE, repeatable)",
    { collect: true },
  )
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      methodName: string,
    ) {
      const ctx = createContext(options as GlobalOptions, [
        "model",
        "method",
        "run",
      ]);
      const { repoDir, repoContext } = await requireInitializedRepo({
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      });

      ctx.logger
        .debug`Running method '${methodName}' on model: ${modelIdOrName}`;

      // Parse input values
      const { inputs } = await parseInputs({
        input: options.input as string[] | undefined,
        inputFile: options.inputFile as string | undefined,
      });

      // Parse runtime tags
      const runtimeTags = options.tag
        ? parseTags(options.tag as string[])
        : undefined;

      const deps: ModelMethodRunDeps = {
        repoDir,
        lookupDefinition: (idOrName) =>
          findDefinitionByIdOrName(repoContext.definitionRepo, idOrName),
        getModelDef: (type) => modelRegistry.get(type),
        createEvaluationService: (dir) =>
          new ExpressionEvaluationService(
            repoContext.definitionRepo,
            dir,
            { dataRepo: repoContext.unifiedDataRepo },
          ),
        loadEvaluatedDefinition: (type, name) =>
          repoContext.evaluatedDefinitionRepo.findByName(type, name),
        saveEvaluatedDefinition: (type, definition) =>
          repoContext.evaluatedDefinitionRepo.save(type, definition),
        createExecutionService: () => new DefaultMethodExecutionService(),
        createVaultService: () => VaultService.fromRepository(repoDir),
        dataRepo: repoContext.unifiedDataRepo,
        definitionRepo: repoContext.definitionRepo,
        outputRepo: repoContext.outputRepo,
        registerLogSink: (prefix, path, redactor, boundary) =>
          runFileSink.register(prefix, path, redactor, boundary),
        unregisterLogSink: (prefix) => runFileSink.unregister(prefix),
        createSecretRedactor: () => new SecretRedactor(),
        computeLogFilePath: (modelType, method, definitionId) => {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          return join(
            swampPath(repoDir, SWAMP_SUBDIRS.outputs),
            modelType.normalized,
            method,
            `${definitionId}-${timestamp}.log`,
          );
        },
      };

      const libCtx = createLibSwampContext();
      const renderer = createModelMethodRunRenderer(ctx.outputMode, {
        modelName: modelIdOrName,
        methodName,
      });

      try {
        await consumeStream(
          modelMethodRun(libCtx, deps, {
            modelIdOrName,
            methodName,
            inputs,
            lastEvaluated: options.lastEvaluated as boolean,
            runtimeTags,
          }),
          renderer.handlers(),
        );

        if (renderer.runFailed()) {
          Deno.exit(1);
        }
      } catch (error) {
        if (error instanceof UserError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(`Method execution failed: ${message}`);
      }

      ctx.logger.debug("Method run command completed");
    },
  );

export const modelMethodCommand = new Command()
  .name("method")
  .description("Execute model methods")
  .error(unknownCommandErrorHandler)
  .action(function () {
    this.showHelp();
  })
  .command("run", modelMethodRunCommand)
  .command("describe", modelMethodDescribeCommand)
  .command("history", modelMethodHistoryCommand);
