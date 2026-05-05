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
import {
  acquireModelLocks,
  requireInitializedRepo,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { extractModelReferencesFromWorkflow } from "../../domain/workflows/model_reference_extractor.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { WorkflowExecutionService } from "../../domain/workflows/execution_service.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { parseInputs } from "../input_parser.ts";
import { parseTimeout } from "../duration_parser.ts";
import { GIT_SHA } from "./version.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { driverTypeRegistry } from "../../domain/drivers/driver_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { parseTags } from "../../libswamp/mod.ts";
import { workflowRunSearchCommand } from "./workflow_run_search.ts";
import {
  consumeStream,
  createLibSwampContext,
  workflowRun,
  type WorkflowRunDeps,
} from "../../libswamp/mod.ts";
import { createWorkflowRunRenderer } from "../../presentation/renderers/workflow_run.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowRunCommand = new Command()
  .name("run")
  .description("Execute a workflow")
  .example("Run a workflow", "swamp workflow run deploy-pipeline")
  .example(
    "With inputs",
    "swamp workflow run deploy-pipeline --input env=prod",
  )
  .example(
    "Pass an array or object input (JSON-typed via :json suffix)",
    'swamp workflow run deploy-pipeline --input \'tags:json=["prod","west"]\'',
  )
  .example(
    "With tags",
    "swamp workflow run deploy-pipeline --tag type=deploy --tag env=production",
  )
  .example("Skip reports", "swamp workflow run deploy-pipeline --skip-reports")
  .arguments("<workflow_id_or_name:workflow_name>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--last-evaluated",
    "Skip CEL evaluation, use previously evaluated workflow and definitions",
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
    "--driver <driver:string>",
    "Override execution driver (e.g. raw, docker)",
  )
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
  .option("--skip-checks", "Skip all pre-flight checks", { default: false })
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
  .option(
    "--timeout <duration:string>",
    "Cancellation deadline — seconds (e.g. 30, 1800) or duration string (e.g. 30s, 5m, 1h). Cooperative — only honored by methods that check AbortSignal.",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "run"]);
    ctx.logger.debug`Running workflow: ${workflowIdOrName}`;

    // First try unlocked to resolve workflow and model references
    const unlocked = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });
    const workflowRepo = unlocked.repoContext.workflowRepo;

    const lastEvaluated = options.lastEvaluated as boolean;

    // Parse input values
    const { inputs } = await parseInputs({
      input: options.input as string[] | undefined,
      inputFile: options.inputFile as string | undefined,
    });

    // Parse runtime tags
    const runtimeTags = options.tag
      ? parseTags(options.tag as string[])
      : undefined;

    let flushModelLocks: (() => Promise<void>) | null = null;
    let repoDir: string;
    let repoContext: typeof unlocked.repoContext;

    try {
      // Pre-lookup workflow for per-model lock acquisition
      const preWorkflow = await workflowRepo.findByName(workflowIdOrName) ??
        await workflowRepo.findById(createWorkflowId(workflowIdOrName));

      if (preWorkflow) {
        // Try to extract model references for per-model locking
        const modelRefs = await extractModelReferencesFromWorkflow(
          preWorkflow,
          workflowRepo,
        );

        if (modelRefs !== null && modelRefs.length > 0) {
          const definitionRepo = unlocked.repoContext.definitionRepo;
          const resolvedModels: Array<
            { modelType: string; modelId: string }
          > = [];

          for (const ref of modelRefs) {
            const lookupResult = await findDefinitionByIdOrName(
              definitionRepo,
              ref,
            );
            if (lookupResult) {
              resolvedModels.push({
                modelType: lookupResult.type.normalized,
                modelId: lookupResult.definition.id,
              });
            }
          }

          if (resolvedModels.length > 0) {
            const lockResult = await acquireModelLocks(
              unlocked.datastoreConfig,
              resolvedModels,
              unlocked.repoDir,
              unlocked.syncService,
            );
            if (lockResult.synced) {
              unlocked.repoContext.catalogStore.invalidate();
            }
            flushModelLocks = lockResult.flush;
          }

          repoDir = unlocked.repoDir;
          repoContext = unlocked.repoContext;
        } else if (modelRefs === null) {
          // Dynamic references — fall back to global lock
          const logger = getSwampLogger(["workflow", "run"]);
          logger
            .info`Workflow contains dynamic model references — using global lock`;
          const globalResult = await requireInitializedRepo({
            repoDir: resolveRepoDir(options.repoDir),
            outputMode: ctx.outputMode,
          });
          repoDir = globalResult.repoDir;
          repoContext = globalResult.repoContext;
        } else {
          repoDir = unlocked.repoDir;
          repoContext = unlocked.repoContext;
        }
      } else {
        repoDir = unlocked.repoDir;
        repoContext = unlocked.repoContext;
      }

      const runRepo = repoContext.workflowRunRepo;

      // Load all extension registries needed for workflow execution in parallel
      await Promise.all([
        modelRegistry.ensureLoaded(),
        vaultTypeRegistry.ensureLoaded(),
        driverTypeRegistry.ensureLoaded(),
        reportRegistry.ensureLoaded(),
      ]);

      const deps: WorkflowRunDeps = {
        workflowRepo: repoContext.workflowRepo,
        runRepo,
        repoDir,
        lookupWorkflow: async (repo, idOrName) => {
          return await repo.findByName(idOrName) ??
            await repo.findById(createWorkflowId(idOrName));
        },
        createExecutionService: (wfRepo, rnRepo, dir, catalogStore) =>
          new WorkflowExecutionService(
            wfRepo,
            rnRepo,
            dir,
            undefined,
            unlocked.datastoreResolver.resolvePath(SWAMP_SUBDIRS.data),
            catalogStore,
          ),
        catalogStore: repoContext.catalogStore,
        dataRepo: repoContext.unifiedDataRepo,
        definitionRepo: repoContext.definitionRepo,
      };

      const timeoutMs = options.timeout
        ? parseTimeout(options.timeout as string)
        : undefined;
      const baseLibCtx = createLibSwampContext();
      const libCtx = timeoutMs !== undefined
        ? baseLibCtx.withTimeout(timeoutMs)
        : baseLibCtx;
      const renderer = createWorkflowRunRenderer(ctx.outputMode, {
        workflowName: workflowIdOrName,
        forceLog: ctx.forceLog,
      });

      await consumeStream(
        workflowRun(libCtx, deps, {
          workflowIdOrName,
          lastEvaluated,
          inputs,
          runtimeTags,
          verbose: ctx.verbosity === "verbose",
          driver: options.driver as string | undefined,
          skipAllReports: options.skipReports as boolean | undefined,
          skipReportNames: options.skipReport as string[] | undefined,
          skipReportLabels: options.skipReportLabel as string[] | undefined,
          reportNames: options.report as string[] | undefined,
          reportLabels: options.reportLabel as string[] | undefined,
          swampSha: GIT_SHA || undefined,
          skipAllChecks: options.skipChecks as boolean | undefined,
          skipCheckNames: options.skipCheck as string[] | undefined,
          skipCheckLabels: options.skipCheckLabel as string[] | undefined,
        }),
        renderer.handlers(),
      );

      // Release per-model locks on success
      if (flushModelLocks) await flushModelLocks();

      if (renderer.workflowFailed()) {
        Deno.exit(1);
      }
    } catch (error) {
      // Release per-model locks on error (best-effort — don't lose original error)
      try {
        if (flushModelLocks) await flushModelLocks();
      } catch (releaseError) {
        const logger = getSwampLogger(["workflow", "run"]);
        logger.warn("Failed to release locks during error cleanup: {error}", {
          error: releaseError instanceof Error
            ? releaseError.message
            : String(releaseError),
        });
      }

      if (error instanceof UserError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`Workflow execution failed: ${message}`);
    }
  })
  .command("search", workflowRunSearchCommand);
