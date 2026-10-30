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
  type AssertSeverity,
  AssertSeveritySchema,
} from "../../domain/workflows/step_task.ts";
import {
  cancelOnLeaseLost,
  createLockProgressWriter,
  createWorkflowRunClaims,
  libSwampContextForRepo,
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
import { removeStaleRunIndexes } from "../../infrastructure/persistence/workflow_run_index.ts";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { createSyncGate, type SyncGate } from "../../serve/sync_gate.ts";
import { createStepLockHook } from "../../serve/deps.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import {
  type DirectTypeResolver,
  type StepLockHook,
  WorkflowExecutionService,
} from "../../domain/workflows/execution_service.ts";
import { resolveOrCreateDefinition } from "../../libswamp/models/direct_execution.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../auto_resolver_context.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  resolvePulledExtensionsRoot,
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import { WorkflowRunCheckpointer } from "../../infrastructure/persistence/workflow_run_checkpointer.ts";
import { localNestedCascade } from "../local_nested_cascade.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  cancelAndSettle,
  resolveSettlementWorkflow,
} from "../../domain/workflows/abort_settlement.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  deepMerge,
  mergeInputArgs,
  parseInputs,
  parseStdinContent,
} from "../input_parser.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";
import { parseTimerDuration } from "../duration_parser.ts";
import { abortOnTimeout } from "../abort_on_timeout.ts";
import { GIT_SHA } from "./version.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { parseTags } from "../../libswamp/data/search.ts";
import { workflowRunSearchCommand } from "./workflow_run_search.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  workflowRun,
  type WorkflowRunDeps,
  type WorkflowRunEvent,
  type WorkflowTelemetrySink,
} from "../../libswamp/workflows/run.ts";
import {
  createWorkflowRunRenderer,
  renderWorkflowRunAccepted,
} from "../../presentation/renderers/workflow_run.ts";
import { JUnitWorkflowRunRenderer } from "../../presentation/renderers/workflow_run_junit.ts";
import { resolveCliInitiatedBy } from "../auth_context.ts";
import { getActiveTelemetryService } from "../telemetry_integration.ts";
import {
  CA_CERT_DESCRIPTION,
  CA_CERT_FLAG,
  formatCommandTarget,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  runWorkflowOverServer,
  TOKEN_FILE_DESCRIPTION,
} from "../remote_run.ts";
import { redactServerUrl } from "../../domain/auth/server_url.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { suppressSyncExitOnSignal } from "../../infrastructure/persistence/datastore_sync_coordinator.ts";
import { watchV3ServeFeeds } from "../../infrastructure/datastore_v3/v3_repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * The step lock hook a CLI workflow run or resume gives its execution
 * service: each step takes its model's lock, pulls, and pushes what it wrote
 * when it ends. The run's steps share one in-process sync gate, as a serve
 * process's runs do, so a lock's last publish attempt runs with no other step
 * of the run syncing (swamp-club#3860).
 */
export function workflowStepLockHook(
  repoDir: string,
  repoContext: RepositoryContext,
  datastoreConfig: DatastoreConfig,
  syncService: DatastoreSyncService | undefined,
  syncGate: SyncGate = createSyncGate(),
  /** Cancels the run when a step's lease at serve lapses (swamp-club#4121). */
  onLeaseLost?: (reason: unknown) => void,
): StepLockHook {
  return createStepLockHook(
    repoDir,
    repoContext,
    datastoreConfig,
    syncService,
    syncGate,
    createLockProgressWriter,
    onLeaseLost,
  );
}

export const workflowRunCommand = new Command()
  .name("run")
  .description(
    "Execute a workflow. Blocks until the run completes, suspends (manual approval), fails, or is cancelled. With --server, --detach returns the run ID as soon as the server has started the run.",
  )
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
  .example(
    "Pipe inputs from stdin",
    'echo \'{"env":"prod"}\' | swamp workflow run deploy-pipeline --stdin',
  )
  .example(
    "Start a run on a server and return its ID without waiting",
    "swamp workflow run deploy-pipeline --server ws://localhost:9090 --detach --json",
  )
  .example(
    "Batch run via NDJSON from stdin",
    'printf \'{"env":"dev"}\\n{"env":"prod"}\' | swamp workflow run deploy-pipeline --stdin',
  )
  .arguments("<workflow_id_or_name:workflow_name>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--last-evaluated",
    "Replay the previously evaluated workflow with the inputs it was evaluated with; an --input must match them. Behavior definitions are evaluated fresh",
    { default: false },
  )
  .option("--input <value:string>", "Input values (key=value or JSON)", {
    collect: true,
  })
  .option("--arg <value:string>", "Alias for --input", {
    collect: true,
    hidden: true,
  })
  .option(
    "--input-file <file:string>",
    "Input values from YAML file (cannot combine with --stdin)",
  )
  .option("--stdin", "Read inputs from stdin (piped data)", { default: false })
  .option(
    "--tag <tag:string>",
    "Add tag to produced data (KEY=VALUE, repeatable)",
    { collect: true },
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
    "--fail-on <severity:string>",
    "Minimum assert severity that fails the run (low, medium, high). Default: low (any failure).",
  )
  .option(
    "--junit",
    "Output assert results as JUnit XML instead of normal log output",
    { default: false },
  )
  .option(
    "--out <file:string>",
    "Write output to file instead of stdout (only with --junit)",
  )
  .option(
    "--timeout <duration:string>",
    "Cancellation deadline — seconds (e.g. 30, 1800) or duration string (e.g. 30s, 5m, 1h). Kills in-flight subprocesses (SIGTERM) and runs cleanup steps with always/completed conditions.",
  )
  .option(
    "--server <url:string>",
    "Run through a 'swamp serve' server (ws:// or http://) instead of locally; no local repo required. Required for steps with worker placement (env: SWAMP_SERVE_URL; in a checkout whose datastore is format 3, only this flag or --detach runs it on serve, and the env makes serve its datastore's upstream).",
  )
  .option(
    "--detach",
    "Return the run ID once the server has started the run, and leave it running there; requires --server. Follow it with 'swamp workflow history get <run-id>'.",
    { default: false },
  )
  .option(
    "--token <token:string>",
    "Server token in <name>.<secret> format; only applies with --server (overrides stored credentials and SWAMP_SERVER_TOKEN)",
  )
  .option(
    "--token-file <path:string>",
    TOKEN_FILE_DESCRIPTION,
  )
  .option(CA_CERT_FLAG, CA_CERT_DESCRIPTION)
  .option(
    "--traceparent <value:string>",
    "W3C traceparent for per-invocation trace context (env: TRACEPARENT)",
  )
  .option(
    "--tracestate <value:string>",
    "W3C tracestate for per-invocation trace context (env: TRACESTATE)",
  )
  .option(
    "--no-supersede",
    "Do not cancel matching-input suspended runs before starting",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "run"]);
    ctx.logger.debug`Running workflow: ${workflowIdOrName}`;

    // Validate flag combinations early, before local/server branch
    let failOnSeverity: AssertSeverity | undefined;
    if (options.failOn) {
      const parsed = AssertSeveritySchema.safeParse(options.failOn);
      if (!parsed.success) {
        throw new UserError(
          `Invalid --fail-on value "${options.failOn}". Must be one of: low, medium, high`,
        );
      }
      failOnSeverity = parsed.data;
    }
    if (options.out && !options.junit) {
      throw new UserError(
        "--out requires --junit. Did you mean: swamp workflow run " +
          `${workflowIdOrName} --junit --out ${options.out}`,
      );
    }
    if (options.junit && ctx.outputMode === "json") {
      throw new UserError(
        "--junit and --json cannot be combined. Use --junit for JUnit XML output or --json for JSON output, not both.",
      );
    }

    const server = resolveServeUrl(
      options.server as string | undefined,
    );
    if (options.detach) {
      if (!server) {
        throw new UserError(
          "--detach requires --server (or SWAMP_SERVE_URL): a local run has no server to keep it going after this command returns.",
        );
      }
      if (options.junit) {
        throw new UserError(
          "--detach cannot be combined with --junit: a detached run returns before it has any results to report.",
        );
      }
      if (options.timeout) {
        throw new UserError(
          "--detach cannot be combined with --timeout: the deadline is enforced by this command, which returns as soon as the run starts. Limit the run on the server with 'swamp serve --max-run-duration'.",
        );
      }
    }
    if (server) {
      if (failOnSeverity) {
        throw new UserError(
          "--fail-on is not yet supported with --server.",
        );
      }
      await runWorkflowViaServer(
        ctx,
        server,
        options,
        workflowIdOrName,
        formatCommandTarget({ server: options.server as string | undefined }),
      );
      return;
    }

    // First try unlocked to resolve workflow and model references
    const unlocked = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });
    const lastEvaluated = options.lastEvaluated as boolean;

    const stdinContent = options.stdin ? await readStdin() : null;
    let stdinItems: Record<string, unknown>[] | null = null;
    if (stdinContent !== null) {
      if (options.inputFile) {
        throw new UserError(
          "Cannot combine --stdin with --input-file.",
        );
      }
      stdinItems = parseStdinContent(stdinContent);
    }

    const { inputs: cliInputs } = await parseInputs({
      input: mergeInputArgs(options),
      inputFile: stdinItems
        ? undefined
        : options.inputFile as string | undefined,
    });

    // Parse runtime tags
    const runtimeTags = options.tag
      ? parseTags(options.tag as string[])
      : undefined;

    const repoDir = unlocked.repoDir;
    const repoContext = unlocked.repoContext;
    // A run against a serve-mode checkout sees what other callers commit
    // while it runs (swamp-club#4120).
    watchV3ServeFeeds();
    // A run's evaluated snapshot, read from the datastore-resolved path
    // ExecutionService writes it to, settles a run this command cancels.
    const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
      repoDir,
      unlocked.datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
    );

    // A step whose lease at serve lapses cancels the run (swamp-club#4121).
    const stepLeaseLost = new AbortController();
    const stepLockHook = workflowStepLockHook(
      repoDir,
      repoContext,
      unlocked.datastoreConfig,
      unlocked.syncService,
      undefined,
      (reason) => stepLeaseLost.abort(reason),
    );

    const abort = new AbortController();
    cancelOnLeaseLost(stepLeaseLost.signal, abort);
    const exitSuppress = suppressSyncExitOnSignal();
    let shutdownHandle: { dispose(): void } | undefined;
    let currentRunId: string | undefined;
    const executionTrackers = new Set<RunTrackerStore>();
    const syncService = unlocked.syncService;
    const namespace = isCustomDatastoreConfig(unlocked.datastoreConfig)
      ? unlocked.datastoreConfig.namespace
      : undefined;
    const runCheckpointer = new WorkflowRunCheckpointer(repoContext);
    try {
      await runCommandInRootUnit(
        repoContext,
        {
          push: syncService
            ? async () => {
              await pushNamespace(syncService, namespace);
            }
            : undefined,
          // Progress streams in log mode; the result waits for the commit.
          output: ctx.outputMode === "log" ? "live-until-outcome" : "held",
          onCleanupError: (pushErr) => {
            ctx.logger
              .warn`Post-run push failed; terminal status may be delayed: ${
              pushErr instanceof Error ? pushErr.message : String(pushErr)
            }`;
          },
        },
        async () => {
          try {
            const runRepo = repoContext.workflowRunRepo;

            // Load all extension registries needed for workflow execution in parallel
            await Promise.all([
              modelRegistry.ensureLoaded(),
              vaultTypeRegistry.ensureLoaded(),
              reportRegistry.ensureLoaded(),
            ]);

            // Wire the telemetry sink only when the active service is
            // available — telemetry is disabled outside a swamp repo or under
            // --no-telemetry, in which case the bridge inside libswamp
            // becomes a no-op.
            const telemetryService = getActiveTelemetryService();
            const telemetrySink: WorkflowTelemetrySink | undefined =
              telemetryService
                ? {
                  parentInvocationId: telemetryService.invocationId,
                  recordChildInvocation: telemetryService.recordChildInvocation
                    .bind(
                      telemetryService,
                    ),
                }
                : undefined;

            const deps: WorkflowRunDeps = {
              workflowRepo: repoContext.workflowRepo,
              runRepo,
              repoDir,
              lookupWorkflow: async (repo, idOrName) => {
                return await repo.findByName(idOrName) ??
                  await repo.findById(createWorkflowId(idOrName));
              },
              createExecutionService: (
                wfRepo,
                rnRepo,
                dir,
                catalogStore,
                ephRepo,
                ephCatalog,
              ) => {
                const directResolver: DirectTypeResolver = async (
                  typeArg,
                  defName,
                  methodName,
                  inputs,
                  globalArgs,
                  authoredExpressions,
                  sensitiveValues,
                  provenance,
                ) => {
                  const typeStr = typeArg;
                  let resolvedType = ModelType.create(typeStr);
                  let modelDef = await resolveModelType(
                    resolvedType,
                    getAutoResolver(),
                  );

                  // Fallback: @ is the CLI syntax marker but repo-local extensions
                  // register types without @. Try stripping it.
                  if (!modelDef && typeStr.startsWith("@")) {
                    const strippedType = ModelType.create(typeStr.slice(1));
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
                    throw new Error(
                      `Unknown behavior type: ${resolvedType.normalized}`,
                    );
                  }
                  resolvedType = modelDef.type;
                  const autoDefRepo = new YamlDefinitionRepository(
                    dir,
                    undefined,
                    repoContext.autoDefinitionsDir,
                    false,
                    repoContext.markDirty,
                  );
                  const result = await resolveOrCreateDefinition(
                    {
                      lookupDefinition: (name) =>
                        findDefinitionByIdOrName(
                          repoContext.definitionRepo,
                          name,
                        ),
                      getModelDef: (type) =>
                        resolveModelType(type, getAutoResolver()),
                      saveDefinition: (type, def) =>
                        autoDefRepo.save(type, def),
                      getDefinitionPath: (type, id) =>
                        autoDefRepo.getPath(type, id as DefinitionId),
                    },
                    typeStr,
                    defName,
                    methodName,
                    inputs,
                    resolvedType,
                    modelDef,
                    globalArgs,
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

                const tracker = RunTrackerStore.fromSwampDir(swampPath(dir));
                executionTrackers.add(tracker);
                const service = new WorkflowExecutionService(
                  wfRepo,
                  rnRepo,
                  dir,
                  undefined,
                  unlocked.datastoreResolver.resolvePath(SWAMP_SUBDIRS.data),
                  catalogStore,
                  directResolver,
                  repoContext.markDirty,
                  repoContext.unifiedDataRepo.namespace,
                  stepLockHook,
                  tracker,
                  ephRepo,
                  ephCatalog,
                  resolvePulledExtensionsRoot(dir),
                  repoContext.hydrateFile,
                  unlocked.vaultsDir,
                  unlocked.datastoreResolver,
                  repoContext.autoGc,
                  repoContext.unifiedDataRepo.fetchForeignContent,
                  repoContext.unreadableContent,
                  unlocked.marker?.defaultVault,
                  repoContext.unifiedDataRepo.writeSync,
                );
                service.signalWaits = signalWaitsOf(repoContext);
                service.runCheckpointer = runCheckpointer;
                return service;
              },
              catalogStore: repoContext.catalogStore,
              dataRepo: repoContext.unifiedDataRepo,
              definitionRepo: repoContext.definitionRepo,
              telemetrySink,
              supersede: {
                findSuspendedRuns: (workflowId, signal) =>
                  runRepo.findByStatus(workflowId, "suspended", signal),
                findEvaluatedWorkflow: (runId) =>
                  evaluatedWorkflowRepo.findByRunId(runId),
                evaluatedCache: (name) =>
                  evaluatedWorkflowRepo.findByNameWithProvenance(name),
                runClaims: createWorkflowRunClaims(unlocked.datastoreConfig),
                // The suspended nested runs a superseded run waited on are
                // cancelled with it (swamp-club#2867). The tracker is opened
                // for the cascade alone: it reads each child's owner there.
                cascade: async (superseded) => {
                  const tracker = RunTrackerStore.fromSwampDir(
                    swampPath(repoDir),
                  );
                  try {
                    return await localNestedCascade({
                      workflowRepo: repoContext.workflowRepo,
                      runRepo,
                      runClaims: createWorkflowRunClaims(
                        unlocked.datastoreConfig,
                      ),
                      findEvaluatedWorkflow: (runId) =>
                        evaluatedWorkflowRepo.findByRunId(runId),
                      runTracker: tracker,
                    })(superseded);
                  } finally {
                    tracker.close();
                  }
                },
              },
            };

            const timeoutMs = options.timeout
              ? parseTimerDuration(options.timeout as string)
              : undefined;
            shutdownHandle = registerShutdownHandler({
              handler: () => abort.abort(),
              forceExitOnRepeat: true,
            });
            const baseLibCtx = libSwampContextForRepo(repoContext, {
              signal: abort.signal,
            });
            const libCtx = timeoutMs !== undefined
              ? baseLibCtx.withTimeout(timeoutMs)
              : baseLibCtx;

            // Build the list of input sets to iterate over
            const inputSets: Record<string, unknown>[] = stdinItems
              ? stdinItems.map((item) =>
                Object.keys(cliInputs).length > 0
                  ? deepMerge(item, cliInputs)
                  : item
              )
              : [cliInputs];

            const initiatedBy = await resolveCliInitiatedBy();

            if (options.junit && inputSets.length > 1) {
              throw new UserError(
                "--junit cannot be combined with multiple input sets (--stdin with NDJSON). " +
                  "Each input set would produce a separate XML document, resulting in malformed output.",
              );
            }

            for (let i = 0; i < inputSets.length; i++) {
              if (inputSets.length > 1) {
                ctx.logger
                  .info`Running workflow ${workflowIdOrName} [${
                  i + 1
                }/${inputSets.length}]`;
              }

              const renderer = options.junit
                ? new JUnitWorkflowRunRenderer({
                  failOnSeverity,
                  outFile: options.out as string | undefined,
                  quiet: ctx.verbosity === "quiet",
                })
                : createWorkflowRunRenderer(ctx.outputMode, {
                  workflowName: workflowIdOrName,
                  quiet: ctx.verbosity === "quiet",
                  verbose: ctx.verbosity === "verbose",
                  failOnSeverity,
                  commandTarget: formatCommandTarget({
                    repoDir: options.repoDir as string | undefined,
                  }),
                });
              const eventStream = workflowRun(libCtx, deps, {
                workflowIdOrName,
                lastEvaluated,
                inputs: inputSets[i],
                runtimeTags,
                verbose: ctx.verbosity === "verbose",
                skipAllReports: options.skipReports as boolean | undefined,
                skipReportNames: options.skipReport as string[] | undefined,
                skipReportLabels: options.skipReportLabel as
                  | string[]
                  | undefined,
                reportNames: options.report as string[] | undefined,
                reportLabels: options.reportLabel as string[] | undefined,
                swampSha: GIT_SHA || undefined,
                skipAllChecks: options.skipChecks as boolean | undefined,
                skipCheckNames: options.skipCheck as string[] | undefined,
                skipCheckLabels: options.skipCheckLabel as string[] | undefined,
                traceparent: resolveTraceparent(
                  options.traceparent as string | undefined,
                ),
                tracestate: resolveTracestate(
                  options.tracestate as string | undefined,
                ),
                assertFailOnSeverity: failOnSeverity,
                initiatedBy,
                triggerSource: "manual",
                noSupersede: options.supersede === false,
              });

              const baseHandlers = renderer.handlers();
              const wrappedHandlers = holdFromOutcome({
                ...baseHandlers,
                started: (e: WorkflowRunEvent & { kind: "started" }) => {
                  // A nested workflow's started event carries the child's run id;
                  // the fallback cancel below is for the run this command started.
                  if (e.parentRunId === undefined) currentRunId = e.runId;
                  baseHandlers.started(e);
                },
              });
              try {
                await consumeStream(eventStream, wrappedHandlers);
              } finally {
                for (const tracker of executionTrackers) tracker.close();
                executionTrackers.clear();
              }

              if (abort.signal.aborted) {
                Deno.exitCode = 1;
                return;
              }

              if (renderer.workflowFailed()) {
                Deno.exitCode = 1;
                return;
              }
            }
          } catch (error) {
            if (abort.signal.aborted) {
              // Ctrl+C or timeout — the generator may not have saved the
              // cancelled status. Cancel only the specific run we started.
              try {
                if (currentRunId) {
                  const workflows = await repoContext.workflowRepo.findAll();
                  const wf = workflows.find((w) =>
                    w.name === workflowIdOrName
                  ) ??
                    workflows.find((w) => w.id === workflowIdOrName);
                  if (wf) {
                    const run = await repoContext.workflowRunRepo.findById(
                      wf.id,
                      createWorkflowRunId(currentRunId),
                    );
                    if (run && run.status === "running") {
                      cancelAndSettle(
                        run,
                        await resolveSettlementWorkflow(
                          run,
                          wf,
                          (runId) => evaluatedWorkflowRepo.findByRunId(runId),
                        ),
                        "aborted",
                      );
                      await repoContext.workflowRunRepo.save(wf.id, run);
                    }
                  }
                }
              } catch {
                // Best-effort — if we can't save, the daemon reaper will catch it
              }
              Deno.exitCode = 1;
              return;
            }
            if (error instanceof UserError) {
              throw error;
            }
            const message = error instanceof Error
              ? error.message
              : String(error);
            throw new UserError(`Workflow execution failed: ${message}`);
          }
        },
      );
    } catch (error) {
      let tracker: RunTrackerStore | undefined;
      try {
        await runCheckpointer.restoreUncommittedRuns(() => {
          tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
          return tracker;
        }, error);
      } finally {
        tracker?.close();
      }
      // The dropped final save left index entries no commit backs
      // (swamp-club#3802).
      if (error instanceof RunPartlyCommittedError) {
        await removeStaleRunIndexes(repoDir);
      }
      // The run's steps ran before its commit failed (swamp-club#3759).
      // A run cut while a step ran needs that step acknowledged to be
      // recovered (swamp-club#3882).
      const worded = withRunUnknownSteps(
        error,
        (runId) => runCheckpointer.committedUnknownSteps(runId),
      );
      throw worded instanceof CommitUnreachableError ||
          worded instanceof RunPartlyCommittedError
        ? worded.afterStepsRan()
        : worded;
    } finally {
      for (const tracker of executionTrackers) tracker.close();
      executionTrackers.clear();
      await runCheckpointer.close();
      shutdownHandle?.dispose();
      exitSuppress.dispose();
    }
  })
  .command("search", workflowRunSearchCommand);

/**
 * The --server branch: dispatch the run through a `swamp serve` server and
 * render the streamed events with the same renderer a local run uses. No
 * local repository is required — the server owns the repo, locks, and
 * scheduling (including worker placement).
 */
async function runWorkflowViaServer(
  ctx: ReturnType<typeof createContext>,
  server: string,
  options: AnyOptions,
  workflowIdOrName: string,
  commandTarget: string,
): Promise<void> {
  const stdinContent = options.stdin ? await readStdin() : null;
  let stdinItems: Record<string, unknown>[] | null = null;
  if (stdinContent !== null) {
    if (options.inputFile) {
      throw new UserError("Cannot combine --stdin with --input-file.");
    }
    stdinItems = parseStdinContent(stdinContent);
  }
  const { inputs: cliInputs } = await parseInputs({
    input: mergeInputArgs(options),
    inputFile: stdinItems ? undefined : options.inputFile as string | undefined,
  });
  const runtimeTags = options.tag
    ? parseTags(options.tag as string[])
    : undefined;

  const abort = new AbortController();
  const timeoutMs = options.timeout
    ? parseTimerDuration(options.timeout as string)
    : undefined;
  const shutdown = registerShutdownHandler({
    handler: () => abort.abort(),
    forceExitOnRepeat: true,
  });

  const inputSets: Record<string, unknown>[] = stdinItems
    ? stdinItems.map((item) =>
      Object.keys(cliInputs).length > 0 ? deepMerge(item, cliInputs) : item
    )
    : [cliInputs];

  const token = await resolveServerTokenFromOptions(
    server,
    options,
  );

  const disarmTimeout = timeoutMs !== undefined
    ? abortOnTimeout(abort, timeoutMs)
    : undefined;
  try {
    for (let i = 0; i < inputSets.length; i++) {
      if (inputSets.length > 1) {
        ctx.logger
          .info`Running workflow ${workflowIdOrName} [${
          i + 1
        }/${inputSets.length}] via ${
          redactServerUrl(server) ?? "(invalid URL)"
        }`;
      }
      const renderer = options.junit
        ? new JUnitWorkflowRunRenderer({
          outFile: options.out as string | undefined,
          quiet: ctx.verbosity === "quiet",
        })
        : createWorkflowRunRenderer(ctx.outputMode, {
          workflowName: workflowIdOrName,
          quiet: ctx.verbosity === "quiet",
          verbose: ctx.verbosity === "verbose",
          commandTarget,
        });
      const detach = options.detach as boolean;
      const handlers = renderer.handlers();
      let accepted: { runId: string; workflowName: string } | undefined;
      await consumeStream(
        runWorkflowOverServer({
          server,
          token,
          signal: abort.signal,
          detach,
          payload: {
            workflowIdOrName,
            inputs: inputSets[i],
            lastEvaluated: options.lastEvaluated as boolean,
            verbose: ctx.verbosity === "verbose",
            runtimeTags,
            skipAllReports: options.skipReports as boolean | undefined,
            skipReportNames: options.skipReport as string[] | undefined,
            skipReportLabels: options.skipReportLabel as
              | string[]
              | undefined,
            reportNames: options.report as string[] | undefined,
            reportLabels: options.reportLabel as string[] | undefined,
            skipAllChecks: options.skipChecks as boolean | undefined,
            skipCheckNames: options.skipCheck as string[] | undefined,
            skipCheckLabels: options.skipCheckLabel as
              | string[]
              | undefined,
            traceparent: resolveTraceparent(
              options.traceparent as string | undefined,
            ),
            tracestate: resolveTracestate(
              options.tracestate as string | undefined,
            ),
            noSupersede: options.supersede === false || undefined,
          },
        }) as AsyncIterable<WorkflowRunEvent>,
        detach
          ? {
            ...handlers,
            started: (event) => {
              if (event.parentRunId === undefined) {
                accepted = {
                  runId: event.runId,
                  workflowName: event.workflowName,
                };
              }
              return handlers.started(event);
            },
          }
          : handlers,
      );
      if (renderer.workflowFailed()) {
        Deno.exitCode = 1;
        return;
      }
      if (detach) {
        // A detached stream ends at the run's own started event. A refusal
        // throws before this; a stream that just ends has started nothing.
        if (!accepted) {
          throw new UserError(
            "The server ended the request before the run started, so no run ID was returned. Check for a run with: swamp workflow history get " +
              `${workflowIdOrName}${commandTarget}`,
          );
        }
        renderWorkflowRunAccepted(accepted, ctx.outputMode, commandTarget);
      }
    }
  } finally {
    disarmTimeout?.();
    shutdown.dispose();
  }
}
