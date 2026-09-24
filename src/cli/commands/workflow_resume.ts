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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
  resolveTraceparent,
  resolveTracestate,
} from "../context.ts";
import {
  acquireModelLocks,
  createLockProgressWriter,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { resolveResumableRun } from "../../domain/workflows/suspended_run_resolver.ts";
import { cancelStrandedRun } from "../../domain/workflows/stranded_run.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  type DirectTypeResolver,
  type StepLockHook,
  WorkflowExecutionService,
} from "../../domain/workflows/execution_service.ts";
import {
  resolvePulledExtensionsRoot,
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import { createWorkflowRunRenderer } from "../../presentation/renderers/workflow_run.ts";
import { isAuthenticated } from "../auth_context.ts";
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
import { createEphemeralStore } from "../../infrastructure/persistence/ephemeral_store.ts";
import { withGeneratorTraceContext } from "../../infrastructure/tracing/mod.ts";
import { GIT_SHA } from "./version.ts";
import { parseTimerDuration } from "../duration_parser.ts";
import {
  deepMerge,
  mergeInputArgs,
  parseInputs,
  parseStdinContent,
} from "../input_parser.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import {
  formatCommandTarget,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  resumeWorkflowOverServer,
  withRemoteOptions,
} from "../remote_run.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { suppressSyncExitOnSignal } from "../../infrastructure/persistence/datastore_sync_coordinator.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowResumeCommand = withRemoteOptions(
  new Command()
    .name("resume")
    .description(
      "Resume a suspended workflow run after approval, or retry the failed steps of a failed run named with --run (--from picks the step to retry from)",
    )
    .example(
      "Resume by workflow name",
      "swamp workflow resume deploy-with-gate",
    )
    .example(
      "Resume with an override input minted during the gate",
      "swamp workflow resume deploy-with-gate --input authKey=tskey-abc123",
    )
    .example(
      "Retry the failed steps of a failed run",
      "swamp workflow resume plate-assay --run abc123",
    )
    .example(
      "Resume a failed run from a specific step",
      "swamp workflow resume plate-assay --from read-plate",
    )
    .arguments("<workflow_id_or_name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--run <run_id:string>",
      "Target a specific run ID (required to retry the failed steps of a failed run)",
    )
    .option(
      "--from <step:string>",
      "Select the retry step in a failed run. Without --from, resume --run retries all failed steps.",
    )
    .option(
      "--input <value:string>",
      "Override/additional input for the resumed run (key=value or JSON); merged over the original run inputs",
      { collect: true },
    )
    .option("--arg <value:string>", "Alias for --input", {
      collect: true,
      hidden: true,
    })
    .option(
      "--input-file <file:string>",
      "Override inputs from a YAML file (cannot combine with --stdin)",
    )
    .option("--stdin", "Read override inputs from stdin (piped data)", {
      default: false,
    })
    .option(
      "--timeout <duration:string>",
      "Cancellation deadline — seconds (e.g. 30, 1800) or duration string (e.g. 30s, 5m, 1h). Cooperative — only honored by methods that check AbortSignal.",
    )
    .option(
      "--traceparent <value:string>",
      "W3C traceparent for per-invocation trace context (env: TRACEPARENT)",
    )
    .option(
      "--tracestate <value:string>",
      "W3C tracestate for per-invocation trace context (env: TRACESTATE)",
    ),
).action(
  async function (
    options: AnyOptions,
    workflowIdOrName: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "resume",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );

      // Parse override inputs for the remote path (mirrors local logic).
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
        input: mergeInputArgs(options),
        inputFile: stdinContent !== null
          ? undefined
          : options.inputFile as string | undefined,
      });
      const resumeInputs = Object.keys(stdinInputs).length > 0
        ? deepMerge(stdinInputs, cliInputs)
        : cliInputs;

      const abort = new AbortController();
      if (options.timeout) {
        const timeoutMs = parseTimerDuration(options.timeout as string);
        setTimeout(() => abort.abort(), timeoutMs);
      }
      const shutdown = registerShutdownHandler({
        handler: () => abort.abort(),
        forceExitOnRepeat: true,
      });

      const renderer = createWorkflowRunRenderer(cliCtx.outputMode, {
        workflowName: workflowIdOrName,
        isAuthenticated: isAuthenticated(),
        quiet: cliCtx.verbosity === "quiet",
        commandTarget: formatCommandTarget({
          server: options.server as string | undefined,
        }),
      });
      try {
        await consumeStream(
          resumeWorkflowOverServer({
            server,
            token,
            signal: abort.signal,
            payload: {
              workflowIdOrName,
              runId: options.run as string | undefined,
              from: options.from as string | undefined,
              inputs: Object.keys(resumeInputs).length > 0
                ? resumeInputs
                : undefined,
              traceparent: resolveTraceparent(
                options.traceparent as string | undefined,
              ),
              tracestate: resolveTracestate(
                options.tracestate as string | undefined,
              ),
            },
          }) as AsyncIterable<WorkflowRunEvent>,
          renderer.handlers(),
        );
      } finally {
        shutdown.dispose();
      }
      if (renderer.workflowFailed()) {
        Deno.exitCode = 1;
      }
      return;
    }

    const unlocked = await requireInitializedRepoUnlocked({
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
      input: mergeInputArgs(options),
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
    const repoDir = unlocked.repoDir;
    const repoContext = unlocked.repoContext;
    const workflowRepo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;

    const fromStep = options.from as string | undefined;
    const { run, workflow, workflowName } = await resolveResumableRun(
      workflowRepo,
      runRepo,
      workflowIdOrName,
      options.run,
      { fromStep },
    );

    if (run.status === "suspended") {
      const waiting = run.findWaitingApprovalStep();
      if (waiting) {
        throw new UserError(
          `Step "${waiting.stepName}" is still awaiting approval. ` +
            `Run "swamp workflow approve ${workflowName} ${waiting.stepName}" first.`,
        );
      }
    }

    const stepLockHook: StepLockHook = async (modelType, modelId) => {
      const result = await acquireModelLocks(
        unlocked.datastoreConfig,
        [{ modelType, modelId }],
        repoDir,
        unlocked.syncService,
        repoContext.catalogStore,
        createLockProgressWriter(modelId),
      );
      if (result.synced) repoContext.catalogStore.invalidate();
      return result;
    };

    await Promise.all([
      modelRegistry.ensureLoaded(),
      vaultTypeRegistry.ensureLoaded(),
      reportRegistry.ensureLoaded(),
    ]);

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
          .warn`Resume overriding existing input(s): ${overridden.join(", ")}`;
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
      _globalArgs,
      authoredExpressions,
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
      resolvedType = modelDef.type;
      const autoDefRepo = new YamlDefinitionRepository(
        repoDir,
        undefined,
        repoContext.autoDefinitionsDir,
        false,
        repoContext.markDirty,
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
        undefined,
        repoContext.autoDefinitionsDir,
        authoredExpressions,
      );
      if (!result.ok) throw new Error(result.error.message);
      return {
        definition: result.definition,
        modelType: result.modelType,
        created: result.created,
        routedMethodInputs: result.routedInputs.methodArguments,
        authoredExpressions: result.authoredExpressions,
      };
    };

    const ephemeral = createEphemeralStore(
      repoContext.unifiedDataRepo.namespace,
      { isResume: true },
    );

    const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      repoDir,
      undefined,
      unlocked.datastoreResolver.resolvePath(SWAMP_SUBDIRS.data),
      repoContext.catalogStore,
      directResolver,
      repoContext.markDirty,
      repoContext.unifiedDataRepo.namespace,
      stepLockHook,
      runTracker,
      ephemeral.repo,
      ephemeral.catalog,
      resolvePulledExtensionsRoot(repoDir),
      repoContext.hydrateFile,
      unlocked.vaultsDir,
      unlocked.datastoreResolver,
    );

    const abort = new AbortController();
    if (options.timeout) {
      const timeoutMs = parseTimerDuration(options.timeout as string);
      setTimeout(() => abort.abort(), timeoutMs);
    }

    const renderer = createWorkflowRunRenderer(cliCtx.outputMode, {
      workflowName,
      isAuthenticated: isAuthenticated(),
      quiet: cliCtx.verbosity === "quiet",
      commandTarget: formatCommandTarget({
        repoDir: options.repoDir as string | undefined,
      }),
    });

    const traceparent = resolveTraceparent(
      options.traceparent as string | undefined,
    );
    const tracestate = resolveTracestate(
      options.tracestate as string | undefined,
    );

    const resumeGenerator = async function* (): AsyncGenerator<
      WorkflowRunEvent
    > {
      yield* withGeneratorTraceContext(
        traceparent,
        tracestate,
        (async function* () {
          for await (
            const event of service.resume(workflowName, run.id, {
              signal: abort.signal,
              swampSha: GIT_SHA,
              inputs: resumeInputs,
              fromStep,
            })
          ) {
            yield mapWorkflowExecutionEvent(event, runRepo);
          }
        })(),
      );
    };

    // resume() saves the run as running before it yields `started`, so
    // `started` means this process owns the run. Before it, another resume
    // may own the run, and the fallback below must not cancel it.
    let started = false;
    const baseHandlers = renderer.handlers();
    const handlers = {
      ...baseHandlers,
      started: (e: WorkflowRunEvent & { kind: "started" }) => {
        started = true;
        baseHandlers.started(e);
      },
    };

    // Keep the process alive on Ctrl-C so resume() can record the run as
    // cancelled, as `workflow run` does. Without this, the datastore sync
    // coordinator's SIGINT handler exits 130 first and strands the run at
    // running (swamp-club#2430). Both are process-global, so they are taken
    // directly before the try whose finally releases them.
    const exitSuppress = suppressSyncExitOnSignal();
    const shutdownHandle = registerShutdownHandler({
      handler: () => abort.abort(),
      forceExitOnRepeat: true,
    });
    try {
      try {
        await consumeStream(resumeGenerator(), handlers);
      } catch (error) {
        // An error before `started` is a real failure to resume, not the
        // abort unwinding, so it is reported.
        if (!abort.signal.aborted || !started) {
          // A UserError is already user-facing: resume()'s refusals name the
          // next command to run, and any code it carries must reach the JSON
          // output and exit code intact. Wrapping it would lose both, so it
          // passes through unchanged.
          if (error instanceof UserError) {
            throw error;
          }
          // Anything else is unexpected. Keep the original error, stack
          // included, at debug level, then report it as one classified line —
          // the code serve sends for a failed resume.
          cliCtx.logger.debug`Workflow resume failed: ${error}`;
          const message = error instanceof Error
            ? error.message
            : String(error);
          throw new UserError(
            `Workflow resume failed: ${message}`,
            "workflow_resume_failed",
          );
        }
      }
      if (abort.signal.aborted) {
        // resume() saves the cancelled status itself. This covers an unwind
        // that ended before it could, and runs before the push below.
        if (started) {
          try {
            const cancelled = await cancelStrandedRun(
              runRepo,
              runTracker,
              workflow.id,
              run.id,
              "aborted",
            );
            if (cancelled) {
              cliCtx.logger
                .warn`Run ${run.id} was still marked running after it was interrupted; marked it cancelled`;
            }
          } catch (cancelErr) {
            const cancelCommand =
              `swamp workflow cancel ${workflowName} --run ${run.id}`;
            cliCtx.logger.warn`Could not mark run ${run.id} as cancelled: ${
              cancelErr instanceof Error ? cancelErr.message : String(cancelErr)
            }. Cancel it with ${cancelCommand}`;
          }
        }
        Deno.exitCode = 1;
        return;
      }
    } finally {
      if (unlocked.syncService) {
        const namespace = isCustomDatastoreConfig(unlocked.datastoreConfig)
          ? unlocked.datastoreConfig.namespace
          : undefined;
        try {
          await unlocked.syncService.pushChanged({ namespace });
        } catch (pushErr) {
          cliCtx.logger
            .warn`Post-resume push failed; terminal status may be delayed: ${
            pushErr instanceof Error ? pushErr.message : String(pushErr)
          }`;
        }
      }
      shutdownHandle.dispose();
      exitSuppress.dispose();
      ephemeral.dispose();
    }

    if (renderer.workflowFailed()) {
      Deno.exitCode = 1;
      return;
    }
  },
);
