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
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../auto_resolver_context.ts";
import { DefaultMethodExecutionService } from "../../domain/models/method_execution_service.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { runFileSink } from "../../infrastructure/logging/logger.ts";
import { GIT_SHA } from "./version.ts";
import { parseInputs } from "../input_parser.ts";
import { parseTags } from "../../libswamp/mod.ts";
import { join } from "@std/path";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
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
  .option(
    "--skip-check <name:string>",
    "Skip a specific pre-flight check by name",
    { collect: true },
  )
  .option(
    "--skip-check-label <label:string>",
    "Skip pre-flight checks with this label",
    { collect: true },
  )
  .option("--skip-checks", "Skip all pre-flight checks", { default: false })
  .option("--skip-reports", "Skip all post-run reports", { default: false })
  .option(
    "--skip-report <name:string>",
    "Skip a specific post-run report by name",
    { collect: true },
  )
  .option(
    "--skip-report-label <label:string>",
    "Skip post-run reports with this label",
    { collect: true },
  )
  .option(
    "--report <name:string>",
    "Run only this report (inclusion filter)",
    { collect: true },
  )
  .option(
    "--report-label <label:string>",
    "Run only reports with this label (inclusion filter)",
    { collect: true },
  )
  .option(
    "--driver <driver:string>",
    "Override execution driver (e.g. raw, docker)",
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
      const { repoDir, repoContext, datastoreConfig } =
        await requireInitializedRepoUnlocked({
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
        getModelDef: (type) => resolveModelType(type, getAutoResolver()),
        createEvaluationService: () =>
          new ExpressionEvaluationService(
            repoContext.definitionRepo,
            repoDir,
            {
              dataRepo: repoContext.unifiedDataRepo,
              dataQueryService: repoContext.catalogStore
                ? new DataQueryService(
                  repoContext.catalogStore,
                  repoContext.unifiedDataRepo,
                )
                : undefined,
            },
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
        queryData: repoContext.catalogStore
          ? ((dqs) => (predicate: string, select?: string) =>
            dqs.query(predicate, { select }))(
              new DataQueryService(
                repoContext.catalogStore,
                repoContext.unifiedDataRepo,
              ),
            )
          : undefined,
        createRunLog: async (modelType, method, definitionId) => {
          const redactor = new SecretRedactor();
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const logFilePath = join(
            swampPath(repoDir, SWAMP_SUBDIRS.outputs),
            modelType.normalized,
            method,
            `${definitionId}-${timestamp}.log`,
          );
          const logCategory: string[] = [];
          await runFileSink.register(
            logCategory,
            logFilePath,
            redactor,
            swampPath(repoDir),
          );
          return {
            logFilePath,
            redactor,
            cleanup: () => runFileSink.unregister(logCategory),
          };
        },
      };

      const libCtx = createLibSwampContext();
      const renderer = createModelMethodRunRenderer(ctx.outputMode, {
        modelName: modelIdOrName,
        methodName,
      });

      // Pre-lookup for per-model lock acquisition (reads YAML — no lock needed)
      const preResult = await findDefinitionByIdOrName(
        repoContext.definitionRepo,
        modelIdOrName,
      );
      let flushModelLocks: (() => Promise<void>) | null = null;
      if (preResult) {
        const lockResult = await acquireModelLocks(datastoreConfig, [
          {
            modelType: preResult.type.normalized,
            modelId: preResult.definition.id,
          },
        ], repoDir);
        if (lockResult.synced) repoContext.catalogStore?.invalidate();
        flushModelLocks = lockResult.flush;
      }

      try {
        await consumeStream(
          modelMethodRun(libCtx, deps, {
            modelIdOrName,
            methodName,
            inputs,
            lastEvaluated: options.lastEvaluated as boolean,
            runtimeTags,
            skipCheckNames: options.skipCheck as string[] | undefined,
            skipCheckLabels: options.skipCheckLabel as string[] | undefined,
            skipAllChecks: options.skipChecks as boolean | undefined,
            skipReportNames: options.skipReport as string[] | undefined,
            skipReportLabels: options.skipReportLabel as string[] | undefined,
            skipAllReports: options.skipReports as boolean | undefined,
            reportNames: options.report as string[] | undefined,
            reportLabels: options.reportLabel as string[] | undefined,
            driver: options.driver as string | undefined,
            swampSha: GIT_SHA || undefined,
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
      } finally {
        if (flushModelLocks) {
          try {
            await flushModelLocks();
          } catch (releaseError) {
            ctx.logger.warn(
              "Failed to release locks during cleanup: {error}",
              {
                error: releaseError instanceof Error
                  ? releaseError.message
                  : String(releaseError),
              },
            );
          }
        }
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
