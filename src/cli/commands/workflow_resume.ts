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
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { resolveSuspendedRun } from "../../domain/workflows/suspended_run_resolver.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  type DirectTypeResolver,
  WorkflowExecutionService,
} from "../../domain/workflows/execution_service.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { createWorkflowRunRenderer } from "../../presentation/renderers/workflow_run.ts";
import { resolveOrCreateDefinition } from "../../libswamp/mod.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../auto_resolver_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import {
  consumeStream,
  mapWorkflowExecutionEvent,
} from "../../libswamp/mod.ts";
import type { WorkflowRunEvent } from "../../libswamp/mod.ts";
import { GIT_SHA } from "./version.ts";
import { deepMerge, parseInputs, parseStdinContent } from "../input_parser.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowResumeCommand = new Command()
  .name("resume")
  .description("Resume a suspended workflow run after approval")
  .example(
    "Resume by workflow name",
    "swamp workflow resume deploy-with-gate",
  )
  .example(
    "Resume with an override input minted during the gate",
    "swamp workflow resume deploy-with-gate --input authKey=tskey-abc123",
  )
  .arguments("<workflow_id_or_name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--driver <driver:string>", "Override execution driver")
  .option("--run <run_id:string>", "Target a specific run ID")
  .option(
    "--input <value:string>",
    "Override/additional input for the resumed run (key=value or JSON); merged over the original run inputs",
    { collect: true },
  )
  .option(
    "--input-file <file:string>",
    "Override inputs from a YAML file (cannot combine with --stdin)",
  )
  .option("--stdin", "Read override inputs from stdin (piped data)", {
    default: false,
  })
  .action(
    async function (
      options: AnyOptions,
      workflowIdOrName: string,
    ) {
      const cliCtx = createContext(options as GlobalOptions, [
        "workflow",
        "resume",
      ]);

      const { repoDir, repoContext, datastoreResolver } =
        await requireInitializedRepo({
          repoDir: resolveRepoDir(options.repoDir),
          outputMode: cliCtx.outputMode,
        });

      // Parse override inputs. Resume targets a single run, so unlike
      // `workflow run` (which fans out one run per stdin item) stdin must
      // resolve to a single override set.
      const stdinContent = options.stdin ? await readStdin() : null;
      let stdinInputs: Record<string, unknown> = {};
      if (stdinContent !== null) {
        if (options.inputFile) {
          throw new UserError("Cannot combine --stdin with --input-file.");
        }
        const stdinItems = parseStdinContent(stdinContent);
        if (stdinItems.length > 1) {
          throw new UserError(
            `--stdin provided ${stdinItems.length} items, but resume targets a single run. ` +
              `Provide a single inputs object on stdin.`,
          );
        }
        stdinInputs = stdinItems[0] ?? {};
      }

      const { inputs: cliInputs } = await parseInputs({
        input: options.input as string[] | undefined,
        inputFile: stdinContent !== null
          ? undefined
          : options.inputFile as string | undefined,
      });

      const resumeInputs = Object.keys(stdinInputs).length > 0
        ? deepMerge(stdinInputs, cliInputs)
        : cliInputs;

      // Use the datastore-aware repositories from the RepositoryContext so the
      // suspended-run lookup and the resumed-run persistence (this runRepo is
      // also handed to WorkflowExecutionService below) resolve the same
      // workflow-runs path the run was written to. Constructing
      // YamlWorkflowRunRepository(repoDir) directly would bind to repo-local
      // .swamp/workflow-runs/ and miss runs stored in a configured datastore.
      const workflowRepo = repoContext.workflowRepo;
      const runRepo = repoContext.workflowRunRepo;

      const { run, workflowName } = await resolveSuspendedRun(
        workflowRepo,
        runRepo,
        workflowIdOrName,
        options.run,
      );

      const waiting = run.findWaitingApprovalStep();
      if (waiting) {
        throw new UserError(
          `Step "${waiting.stepName}" is still awaiting approval. ` +
            `Run "swamp workflow approve ${workflowName} ${waiting.stepName}" first.`,
        );
      }

      // Surface what the resume inputs do to the run's inputs. Key names only —
      // values may be secrets and are never logged. Overrides (a resume key
      // that collides with an existing input) are warned; purely-additive keys
      // are info.
      const resumeKeys = Object.keys(resumeInputs);
      if (resumeKeys.length > 0) {
        const overridden = resumeKeys.filter((key) => key in run.inputs);
        const added = resumeKeys.filter((key) => !(key in run.inputs));
        if (overridden.length > 0) {
          cliCtx.logger
            .warn`Resume overriding existing input(s): ${
            overridden.join(", ")
          }`;
        }
        if (added.length > 0) {
          cliCtx.logger.info`Resume adding input(s): ${added.join(", ")}`;
        }
      }

      const directResolver: DirectTypeResolver = async (
        typeArg,
        defName,
        methodName,
        inputs,
      ) => {
        let resolvedType = ModelType.create(typeArg);
        let modelDef = await resolveModelType(
          resolvedType,
          getAutoResolver(),
        );
        if (!modelDef && typeArg.startsWith("@")) {
          const strippedType = ModelType.create(typeArg.slice(1));
          const strippedDef = await resolveModelType(
            strippedType,
            getAutoResolver(),
          );
          if (strippedDef) {
            resolvedType = strippedType;
            modelDef = strippedDef;
          }
        }
        if (!modelDef) {
          throw new Error(`Unknown model type: ${resolvedType.normalized}`);
        }
        const autoDefRepo = new YamlDefinitionRepository(
          repoDir,
          undefined,
          swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
          false,
        );
        const result = await resolveOrCreateDefinition(
          {
            lookupDefinition: (name) =>
              findDefinitionByIdOrName(repoContext.definitionRepo, name),
            getModelDef: (type) => resolveModelType(type, getAutoResolver()),
            saveDefinition: (type, def) => autoDefRepo.save(type, def),
            getDefinitionPath: (type, id) =>
              autoDefRepo.getPath(type, id as DefinitionId),
          },
          typeArg,
          defName,
          methodName,
          inputs,
          resolvedType,
          modelDef,
        );
        if (!result.ok) throw new Error(result.error.message);
        return {
          definition: result.definition,
          modelType: result.modelType,
          created: result.created,
          routedMethodInputs: result.routedInputs.methodArguments,
        };
      };

      const service = new WorkflowExecutionService(
        workflowRepo,
        runRepo,
        repoDir,
        undefined,
        datastoreResolver?.resolvePath(SWAMP_SUBDIRS.data),
        repoContext.catalogStore,
        directResolver,
        repoContext.markDirty,
        repoContext.unifiedDataRepo.namespace,
      );

      const renderer = createWorkflowRunRenderer(cliCtx.outputMode, {
        workflowName,
      });

      async function* resumeGenerator(): AsyncGenerator<WorkflowRunEvent> {
        for await (
          const event of service.resume(workflowName, run.id, {
            signal: AbortSignal.timeout(600_000),
            driver: options.driver,
            swampSha: GIT_SHA,
            inputs: resumeInputs,
          })
        ) {
          yield mapWorkflowExecutionEvent(event, runRepo);
        }
      }

      await consumeStream(resumeGenerator(), renderer.handlers());

      if (renderer.workflowFailed()) {
        Deno.exitCode = 1;
      }
    },
  );
