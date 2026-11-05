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
  cancelOnLeaseLost,
  createWorkflowRunClaims,
  requireInitializedRepoUnlocked,
  signalWaitsOf,
} from "../repo_context.ts";
import { pushNamespace } from "../../infrastructure/persistence/push_paths.ts";
import { UserError } from "../../domain/errors.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
import { holdFromOutcome } from "../committed_output.ts";
import {
  CommitUnreachableError,
  RunPartlyCommittedError,
  withRunUnknownSteps,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { removeStaleOutputSummaries } from "../../infrastructure/persistence/output_summary_index.ts";
import { removeStaleRunIndexes } from "../../infrastructure/persistence/workflow_run_index.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { workflowStepLockHook } from "./workflow_run.ts";
import { resolveResumableRun } from "../../domain/workflows/suspended_run_resolver.ts";
import { cancelStrandedRun } from "../../domain/workflows/stranded_run.ts";
import { runHasDeadOwner } from "../../domain/workflows/orphaned_run_reaper.ts";
import { openSignalWaitMessage } from "../../domain/workflows/signal_wait.ts";
import { findUnsettledWait } from "../../domain/workflows/signal_wait_cleanup.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  type DirectTypeResolver,
  WorkflowExecutionService,
} from "../../domain/workflows/execution_service.ts";
import {
  resolvePulledExtensionsRoot,
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import {
  localOwnerLiveness,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import { WorkflowRunCheckpointer } from "../../infrastructure/persistence/workflow_run_checkpointer.ts";
import { createWorkflowRunRenderer } from "../../presentation/renderers/workflow_run.ts";
import { resolveOrCreateDefinition } from "../../libswamp/models/direct_execution.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../auto_resolver_context.ts";
import { renderAwaitingParent } from "./nested_run_hints.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { awaitingParentOf } from "../../libswamp/workflows/nested_runs.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { mapWorkflowExecutionEvent } from "../../libswamp/workflows/run.ts";
import type { WorkflowRunEvent } from "../../libswamp/workflows/run.ts";
import { createEphemeralStore } from "../../infrastructure/persistence/ephemeral_store.ts";
import { withGeneratorTraceContext } from "../../infrastructure/tracing/mod.ts";
import { GIT_SHA } from "./version.ts";
import { parseTimerDuration } from "../duration_parser.ts";
import { abortOnTimeout } from "../abort_on_timeout.ts";
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
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  resumeWorkflowOverServer,
  withRemoteOptions,
} from "../remote_run.ts";
import { SERVE_CAPABILITY_RESUME_FROM_JOB } from "../../serve/protocol.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { processDataWrites } from "../../domain/data/in_flight_data_writes.ts";
import {
  releaseRegisteredLocks,
  suppressSyncExitOnSignal,
} from "../../infrastructure/persistence/datastore_sync_coordinator.ts";

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
      "Resume with an input minted during the gate",
      "swamp workflow resume deploy-with-gate --input authKeyName=deploy-auth-key-42",
    )
    .example(
      "Retry the failed steps of a failed run",
      "swamp workflow resume plate-assay --run abc123",
    )
    .example(
      "Resume a failed run from a specific step",
      "swamp workflow resume plate-assay --from read-plate",
    )
    .example(
      "Resume from a step whose name is used in more than one job",
      "swamp workflow resume rollout --from restart --job host-b",
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
      "--job <job:string>",
      "Select the job of the --from step, as named in the workflow, when its step name is used in more than one job",
      { depends: ["from"] },
    )
    .option(
      "--input <value:string>",
      "Additional input for the resumed run (key=value or JSON); merged over the original run inputs. An input the run already has cannot change; start a new run instead",
      { collect: true },
    )
    .option("--arg <value:string>", "Alias for --input", {
      collect: true,
      hidden: true,
    })
    .option(
      "--input-file <file:string>",
      "Additional inputs from a YAML file, held to the rules of --input (cannot combine with --stdin)",
    )
    .option(
      "--stdin",
      "Read additional inputs from stdin (piped data), held to the rules of --input",
      {
        default: false,
      },
    )
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
      const timeoutMs = options.timeout
        ? parseTimerDuration(options.timeout as string)
        : undefined;
      const shutdown = registerShutdownHandler({
        handler: () => abort.abort(),
        forceExitOnRepeat: true,
      });

      const renderer = createWorkflowRunRenderer(cliCtx.outputMode, {
        workflowName: workflowIdOrName,
        quiet: cliCtx.verbosity === "quiet",
        verbose: cliCtx.verbosity === "verbose",
        commandTarget: formatCommandTarget({
          server: options.server as string | undefined,
        }),
      });
      const disarmTimeout = timeoutMs !== undefined
        ? abortOnTimeout(abort, timeoutMs)
        : undefined;
      try {
        // an older server ignores fromJob and resets the --from step in every
        // job that has it, so --job is sent only to one that says it honours
        // it; the probe runs inside the try so --timeout bounds it
        if (options.job !== undefined) {
          const version = await requestServerResponse<
            { version: string; capabilities?: string[] }
          >(
            { server, token, signal: abort.signal },
            { type: "server.version" },
          );
          if (
            !version.capabilities?.includes(SERVE_CAPABILITY_RESUME_FROM_JOB)
          ) {
            throw new UserError(
              `The server (swamp ${version.version}) does not support --job, so it would resume the --from step in every job that has it. Upgrade swamp serve, or run without --server.`,
            );
          }
        }
        await consumeStream(
          resumeWorkflowOverServer({
            server,
            token,
            signal: abort.signal,
            payload: {
              workflowIdOrName,
              runId: options.run as string | undefined,
              from: options.from as string | undefined,
              fromJob: options.job as string | undefined,
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
        disarmTimeout?.();
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

    // use the datastore-aware repositories from the RepositoryContext:
    // constructing YamlWorkflowRunRepository(repoDir) would bind to repo-local
    // .swamp/workflow-runs and miss runs in a configured datastore
    const repoDir = unlocked.repoDir;
    // A run's evaluated snapshot, read from the datastore-resolved path
    // ExecutionService writes it to, settles a run this command cancels.
    const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
      repoDir,
      unlocked.datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
    );
    const repoContext = unlocked.repoContext;
    const workflowRepo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;

    const fromStep = options.from as string | undefined;
    const fromJob = options.job as string | undefined;
    const signalWaits = signalWaitsOf(unlocked.repoContext);
    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    const liveness = localOwnerLiveness();
    const { run, workflow, workflowName } = await resolveResumableRun(
      workflowRepo,
      runRepo,
      workflowIdOrName,
      options.run,
      {
        fromStep,
        fromJob,
        ownerIsDead: (candidate) =>
          runHasDeadOwner(candidate, tracker, liveness),
        signalWaits,
      },
    ).finally(() => tracker.close());

    if (run.status === "suspended") {
      const waiting = run.findWaitingApprovalStep();
      if (waiting) {
        throw new UserError(
          `Step "${waiting.stepName}" is still awaiting approval. ` +
            `Run "swamp workflow approve ${workflowName} ${waiting.stepName}" first.`,
        );
      }
      // Asked of the wait's outcome, not the run record: a signal settles
      // a wait without writing the run. The resume asks again under the
      // run's claim.
      if (signalWaits.supported) {
        const openWait = await findUnsettledWait(
          signalWaits.store,
          run,
          new Date(),
        );
        if (openWait) throw new UserError(openSignalWaitMessage(openWait));
      }
    }

    const stepLeaseLost = new AbortController();
    const stepLockHook = workflowStepLockHook(
      repoDir,
      repoContext,
      unlocked.datastoreConfig,
      unlocked.syncService,
      undefined,
      (reason) => stepLeaseLost.abort(reason),
    );

    await Promise.all([
      modelRegistry.ensureLoaded(),
      vaultTypeRegistry.ensureLoaded(),
      reportRegistry.ensureLoaded(),
    ]);

    // Report supplied keys only. The execution service checks their values
    // under the run's claim; a changed existing value will be refused.
    const resumeKeys = Object.keys(resumeInputs);
    if (resumeKeys.length > 0) {
      cliCtx.logger.info`Resume input(s) supplied: ${resumeKeys.join(", ")}`;
    }

    const directResolver: DirectTypeResolver = async (
      typeArg,
      defName,
      methodName,
      inputs,
      _globalArgs,
      authoredExpressions,
      sensitiveValues,
      provenance,
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
        throw new Error(`Unknown behavior type: ${resolvedType.normalized}`);
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
        sensitiveValues,
        provenance,
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
      repoContext.autoGc,
      repoContext.unifiedDataRepo.fetchForeignContent,
      repoContext.unreadableContent,
      unlocked.marker?.defaultVault,
      repoContext.unifiedDataRepo.writeSync,
    );

    service.runClaims = createWorkflowRunClaims(unlocked.datastoreConfig);
    service.continuationClaims = repoContext.continuationClaims;
    service.signalWaits = signalWaits;
    service.ownerLiveness = liveness;
    const runCheckpointer = new WorkflowRunCheckpointer(repoContext);
    service.runCheckpointer = runCheckpointer;

    const abort = new AbortController();
    cancelOnLeaseLost(stepLeaseLost.signal, abort);
    const timeoutMs = options.timeout
      ? parseTimerDuration(options.timeout as string)
      : undefined;

    const renderer = createWorkflowRunRenderer(cliCtx.outputMode, {
      workflowName,
      quiet: cliCtx.verbosity === "quiet",
      verbose: cliCtx.verbosity === "verbose",
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
              fromJob,
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
    const handlers = holdFromOutcome({
      ...baseHandlers,
      started: (e: WorkflowRunEvent & { kind: "started" }) => {
        started = true;
        baseHandlers.started(e);
      },
    });

    // keep the process alive on Ctrl-C so resume() can record the cancel:
    // otherwise the sync coordinator's SIGINT handler exits 130 and strands the
    // run at running; both are process-global
    const exitSuppress = suppressSyncExitOnSignal();
    const shutdownHandle = registerShutdownHandler({
      handler: () => abort.abort(),
      forceExitOnRepeat: true,
      dataWrites: processDataWrites,
      beforeForceExit: releaseRegisteredLocks,
    });
    const disarmTimeout = timeoutMs !== undefined
      ? abortOnTimeout(abort, timeoutMs)
      : undefined;
    const syncService = unlocked.syncService;
    const namespace = isCustomDatastoreConfig(unlocked.datastoreConfig)
      ? unlocked.datastoreConfig.namespace
      : undefined;
    let finished: boolean;
    try {
      finished = await runCommandInRootUnit(
        repoContext,
        {
          push: syncService
            ? async () => {
              await pushNamespace(syncService, namespace);
            }
            : undefined,
          output: cliCtx.outputMode === "log" ? "live-until-outcome" : "held",
          onCleanupError: (pushErr) => {
            cliCtx.logger
              .warn`Post-resume push failed; terminal status may be delayed: ${
              pushErr instanceof Error ? pushErr.message : String(pushErr)
            }`;
          },
        },
        async () => {
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
                    workflow,
                    run.id,
                    "aborted",
                    (runId) => evaluatedWorkflowRepo.findByRunId(runId),
                  );
                  if (cancelled) {
                    cliCtx.logger
                      .warn`Run ${run.id} was still marked running after it was interrupted; marked it cancelled`;
                  }
                } catch (cancelErr) {
                  const cancelCommand =
                    `swamp workflow cancel ${workflowName} --run ${run.id}`;
                  cliCtx.logger
                    .warn`Could not mark run ${run.id} as cancelled: ${
                    cancelErr instanceof Error
                      ? cancelErr.message
                      : String(cancelErr)
                  }. Cancel it with ${cancelCommand}`;
                }
              }
              Deno.exitCode = 1;
              return false;
            }
            return true;
          } finally {
            // Disarm the timeout before the root pushes, so it cannot fire mid-push.
            disarmTimeout?.();
          }
        },
      );
    } catch (error) {
      await runCheckpointer.restoreUncommittedRuns(() => runTracker, error);
      // a dropped final save leaves index entries no commit backs
      if (error instanceof RunPartlyCommittedError) {
        await removeStaleRunIndexes(repoDir);
        await removeStaleOutputSummaries(repoDir);
      }
      // the run's steps ran before its commit failed; a run cut while a step
      // ran needs that step acknowledged to be recovered
      const worded = withRunUnknownSteps(
        error,
        (runId) => runCheckpointer.committedUnknownSteps(runId),
      );
      throw worded instanceof CommitUnreachableError ||
          worded instanceof RunPartlyCommittedError
        ? worded.afterStepsRan()
        : worded;
    } finally {
      await runCheckpointer.close();
      shutdownHandle.dispose();
      exitSuppress.dispose();
      ephemeral.dispose();
    }
    if (!finished) return;

    // a nested run that finished leaves its parent waiting: name the next
    // command. Best effort: the resume is already saved
    if (run.parentRun !== undefined) {
      const finished = await runRepo.findById(workflow.id, run.id)
        .catch(() => null);
      const parent = finished && finished.status !== "suspended"
        ? await awaitingParentOf({ runRepo, workflowRepo }, finished)
          .catch(() => undefined)
        : undefined;
      if (parent) renderAwaitingParent(cliCtx, parent);
    }

    if (renderer.workflowFailed()) {
      Deno.exitCode = 1;
      return;
    }
  },
);
