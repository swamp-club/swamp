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
import { groupCommandAction } from "../group_action.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
  resolveTraceparent,
  resolveTracestate,
} from "../context.ts";
import {
  acquireModelLocks,
  acquirePublishLocksOrDefer,
  cancelOnLeaseLost,
  libSwampContextForRepo,
  type ModelLockResult,
  pullModelsUnlocked,
  requireInitializedRepoUnlocked,
  runUnderModelLocks,
} from "../repo_context.ts";
import { methodRunLockMode } from "../../libswamp/models/method_run_lock_mode.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { UserError } from "../../domain/errors.ts";
import { messageFor } from "../../domain/behavior_wording.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
import { holdFromOutcome } from "../committed_output.ts";
import { CommitUnreachableError } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../auto_resolver_context.ts";
import { DefaultMethodExecutionService } from "../../domain/models/method_execution_service.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import {
  getSwampLogger,
  runFileSink,
} from "../../infrastructure/logging/logger.ts";
import { isDatastoreAuthorizationError } from "../../infrastructure/persistence/sync_error_diagnostic.ts";
import type {
  ModelMethodRunView,
  UnpublishedVersionView,
} from "../../libswamp/models/model_method_run_view.ts";
import { GIT_SHA } from "./version.ts";
import {
  deepMerge,
  mergeInputArgs,
  parseInputs,
  parseStdinContent,
} from "../input_parser.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";
import { parseTags } from "../../libswamp/data/search.ts";
import { join } from "@std/path";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import {
  createModelMethodHistoryCommand,
  modelMethodHistoryCommand,
} from "./model_method_history.ts";
import {
  createModelMethodDescribeCommand,
  modelMethodDescribeCommand,
} from "./model_method_describe.ts";
import {
  type CommandSyntax,
  definitionNameType,
  PREFERRED_SPELLING_EXAMPLE,
  recordDefiningModule,
  runTargetArgument,
  subcommandSyntax,
} from "./command_syntax.ts";
import type { CommandSurface } from "../../presentation/command_surface.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  modelMethodRun,
  type ModelMethodRunDeps,
  type ModelMethodRunEvent,
} from "../../libswamp/models/run.ts";
import { createModelMethodRunRenderer } from "../../presentation/renderers/model_method_run.ts";
import {
  CA_CERT_DESCRIPTION,
  CA_CERT_FLAG,
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  runModelMethodOverServer,
  TOKEN_FILE_DESCRIPTION,
} from "../remote_run.ts";
import { SERVE_CAPABILITY_LITERAL_INPUTS } from "../../serve/protocol.ts";
import { redactServerUrl } from "../../domain/auth/server_url.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { suppressSyncExitOnSignal } from "../../infrastructure/persistence/datastore_sync_coordinator.ts";
import { parseTimerDuration } from "../duration_parser.ts";
import { resolveCliInitiatedBy } from "../auth_context.ts";
import {
  DataVersionConflictError,
  isUnpublishedDataError,
  type WrittenVersion,
} from "../../domain/datastore/datastore_sync_service.ts";
import { watchV3ServeFeeds } from "../../infrastructure/datastore_v3/v3_repo_context.ts";
import {
  DEFAULT_STALE_TTL_MS,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";

// Cliffy's custom type system returns `unknown` for custom types like `model_name`,
// but we need to pass `options` to functions expecting specific types. Using `any`
// here is the pragmatic workaround for Cliffy's type inference limitations.
// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Where the publish of a run's data and its locks report: the run's own
 * category reaches only its log file unless `--log` is passed, and the
 * publish runs after the method has finished writing it (swamp-club#3934).
 */
const publishLogger = getSwampLogger(["datastore", "lock"]);

/**
 * The text that differs between the CLI surfaces a method run is reachable
 * from. Everything else about the command — arguments, options, the action —
 * is identical: `swamp model method run` and `swamp behavior run` are two
 * spellings of one invocation, not two commands (swamp-club#3265).
 */
export interface RunCommandSyntax {
  /** Renders `swamp … <model> <method>` for a named definition. */
  readonly invocation: (model: string, method: string) => string;
  /** Renders `swamp … @<type> … <method> <name>` for direct type execution. */
  readonly directInvocation: (
    type: string,
    method: string,
    name: string,
  ) => string;
  /** Which tree the command is mounted in; picks the log-mode wording. */
  readonly surface: CommandSurface;
  /**
   * The preferred spelling as a full example invocation, set only on the
   * legacy syntax; listed as the last `--help` example.
   */
  readonly preferred?: string;
}

/** The preferred spelling: `swamp behavior run [@type]`. */
export const BEHAVIOR_RUN_SYNTAX: RunCommandSyntax = {
  invocation: (model, method) => `swamp behavior run ${model} ${method}`,
  directInvocation: (type, method, name) =>
    `swamp behavior run ${type} ${method} ${name}`,
  surface: "behavior",
};

/** The legacy spelling: `swamp model [@type] method run`. */
export const MODEL_METHOD_RUN_SYNTAX: RunCommandSyntax = {
  invocation: (model, method) => `swamp model method run ${model} ${method}`,
  directInvocation: (type, method, name) =>
    `swamp model ${type} method run ${method} ${name}`,
  surface: "model",
  preferred: BEHAVIOR_RUN_SYNTAX.invocation("my-server", "getSystemInfo"),
};

/** The `--help` examples, written once and rendered for each surface. */
function examples(
  s: RunCommandSyntax,
): ReadonlyArray<readonly [string, string]> {
  return [
    ["Run a method", s.invocation("my-server", "getSystemInfo")],
    [
      "Run with inputs",
      `${s.invocation("my-server", "deploy")} --input env=prod`,
    ],
    [
      "Direct type execution",
      `${
        s.directInvocation("@swamp/aws/ec2/vpc", "create", "my-vpc")
      } --input region=us-east-1`,
    ],
    [
      "Pass an array or object input (JSON-typed via :json suffix)",
      `${
        s.invocation("my-server", "search")
      } --input 'keywords:json=["a","b"]'`,
    ],
    [
      "Pipe inputs from stdin",
      `echo '{"env":"prod"}' | ${s.invocation("my-server", "deploy")} --stdin`,
    ],
    [
      "Pass text you did not write as data",
      `${
        s.invocation("github-pr", "update-body")
      } --literal-inputs --input-file body.json`,
    ],
    [
      "Batch run via NDJSON from stdin",
      `printf '{"env":"dev"}\\n{"env":"prod"}' | ${
        s.invocation("my-server", "deploy")
      } --stdin`,
    ],
    ...(s.preferred === undefined
      ? []
      : [[PREFERRED_SPELLING_EXAMPLE, s.preferred] as const]),
  ];
}

/**
 * Builds a method-run command for one CLI surface. Each call returns a new
 * Cliffy `Command`: Cliffy reparents a command instance when it is attached
 * under a second parent, so the two surfaces must never share one.
 */
export function createModelMethodRunCommand(syntax: RunCommandSyntax) {
  const target = runTargetArgument(syntax.surface);
  const command = new Command().name("run");
  for (const [title, example] of examples(syntax)) {
    command.example(title, example);
  }
  const built = command
    .description(
      `Execute a method on a ${syntax.surface}. With @type prefix, auto-creates the definition if needed.

Errors follow the --json envelope and exit codes in 'swamp --help'. Error codes this command reports (match on "code", not the message):

    lock_timeout             Another invocation holds the ${syntax.surface} lock (exit 75)
    datastore_v3_writer_busy Another process is writing the v3 datastore (exit 75)
    model_not_found          No ${syntax.surface} matches the given name
    unknown_model_type       The @type prefix does not match any installed type
    unknown_method           The ${syntax.surface} does not define the requested method
    no_evaluated_definition  No evaluated definition exists (use --last-evaluated)
    evaluated_cache_may_hold_secrets
                             Cached evaluation from an older swamp may hold secrets;
                             re-run without --last-evaluated
    evaluated_cache_holds_sensitive_arguments
                             Cached evaluation holds a sensitive argument that did not
                             come from a vault; --last-evaluated cannot replay it
    missing_deps             Required extension dependencies are not installed
    method_execution_failed  The method returned an error
    not_authenticated        Not signed in (run 'swamp auth login')
    cancelled                Operation was cancelled (e.g. Ctrl+C)

The lock wait defaults to 60 seconds. Set the SWAMP_LOCK_TIMEOUT_MS environment variable (milliseconds) to wait longer.`,
    )
    .arguments(
      `<${target}:${
        definitionNameType(syntax.surface)
      }> <method_name:string> [definition_name:string]`,
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--last-evaluated",
      "Skip CEL evaluation, use previously evaluated definition",
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
    .option("--stdin", "Read inputs from stdin (piped data)", {
      default: false,
    })
    .option(
      "--literal-inputs",
      "Treat input values as data: no expression evaluation, no @file reading (with --server, needs a serve that supports it)",
      { default: false },
    )
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
      "--timeout <duration:string>",
      "Cancellation deadline — seconds (e.g. 30, 1800) or duration string (e.g. 30s, 5m, 1h). Cooperative — only honored by methods that check AbortSignal.",
    )
    .option(
      "--server <url:string>",
      "Run through a 'swamp serve' server (ws:// or http://) instead of locally; no local repo required (env: SWAMP_SERVE_URL; in a checkout whose datastore is format 3, only this flag runs it on serve, and the env makes serve its datastore's upstream).",
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
    .action(
      // @ts-expect-error - Cliffy custom type returns unknown instead of string
      async function (
        options: AnyOptions,
        modelOrType: string,
        methodName: string,
        definitionNameArg?: string,
      ) {
        const isDirectExecution = modelOrType.startsWith("@");

        if (isDirectExecution && !definitionNameArg) {
          throw new UserError(
            "Direct type execution requires a definition name: " +
              syntax.directInvocation(modelOrType, methodName, "<name>"),
          );
        }

        const typeArg = isDirectExecution ? modelOrType : undefined;
        const modelIdOrName = isDirectExecution
          ? definitionNameArg!
          : modelOrType;
        const definitionName = isDirectExecution
          ? definitionNameArg
          : undefined;

        const server = resolveServeUrl(
          options.server as string | undefined,
        );
        if (server) {
          await runMethodViaServer(
            server,
            options,
            modelIdOrName,
            methodName,
            { typeArg, definitionName },
            syntax.surface,
          );
          return;
        }
        const ctx = createContext(options as GlobalOptions, [
          "model",
          "method",
          "run",
        ]);
        const {
          repoDir,
          repoContext,
          datastoreConfig,
          syncService,
          vaultsDir,
        } = await requireInitializedRepoUnlocked({
          repoDir: resolveRepoDir(options.repoDir),
          outputMode: ctx.outputMode,
        });

        // A run against a serve-mode checkout sees what other callers
        // commit while it runs (swamp-club#4120).
        watchV3ServeFeeds();
        const runTracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
        try {
          runTracker.reapStaleRuns(DEFAULT_STALE_TTL_MS);

          const marker = await new RepoMarkerRepository().read(
            RepoPath.create(repoDir),
          );
          const autoGc = marker?.autoGc === true;

          ctx.logger
            .debug`Running method '${methodName}' on model: ${modelIdOrName}`;

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
            literal: options.literalInputs === true,
          });

          // Parse runtime tags
          const runtimeTags = options.tag
            ? parseTags(options.tag as string[])
            : undefined;

          // Load all extension registries needed for method execution in parallel
          await Promise.all([
            modelRegistry.ensureLoaded(),
            vaultTypeRegistry.ensureLoaded(),
            reportRegistry.ensureLoaded(),
          ]);

          const deps: ModelMethodRunDeps = {
            repoDir,
            lookupDefinition: (idOrName) =>
              findDefinitionByIdOrName(repoContext.definitionRepo, idOrName),
            getModelDef: (type) => resolveModelType(type, getAutoResolver()),
            createEvaluationService: () => {
              const dqs = new DataQueryService(
                repoContext.catalogStore,
                repoContext.unifiedDataRepo,
              );
              return new ExpressionEvaluationService(
                repoContext.definitionRepo,
                repoDir,
                {
                  dataRepo: repoContext.unifiedDataRepo,
                  dataQueryService: dqs,
                },
              );
            },
            loadEvaluatedDefinition: (type, name) =>
              repoContext.evaluatedDefinitionRepo.findByNameWithProvenance(
                type,
                name,
              ),
            saveEvaluatedDefinition: (
              type,
              definition,
              provenance,
              authoredExpressions,
              writtenReferences,
              maskedPaths,
              persistedProvenance,
            ) =>
              repoContext.evaluatedDefinitionRepo.save(
                type,
                definition,
                provenance,
                authoredExpressions,
                undefined,
                writtenReferences,
                maskedPaths,
                persistedProvenance,
              ),
            createExecutionService: () => new DefaultMethodExecutionService(),
            createVaultService: () =>
              VaultService.fromRepository(repoDir, {
                vaultsDir,
                defaultVaultName: marker?.defaultVault,
              }),
            dataRepo: repoContext.unifiedDataRepo,
            catalogStore: repoContext.catalogStore,
            definitionRepo: repoContext.definitionRepo,
            outputRepo: repoContext.outputRepo,
            dataQueryService: new DataQueryService(
              repoContext.catalogStore,
              repoContext.unifiedDataRepo,
            ),
            createRunLog: async (modelType, method, definitionId) => {
              const redactor = new SecretRedactor();
              const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
              const logFilePath = join(
                swampPath(repoDir, SWAMP_SUBDIRS.outputs),
                modelType.normalized,
                method,
                `${definitionId}-${timestamp}.log`,
              );
              const logHandle = await runFileSink.register(
                [],
                logFilePath,
                redactor,
                swampPath(repoDir),
              );
              return {
                logFilePath,
                redactor,
                cleanup: () => runFileSink.unregister(logHandle),
              };
            },
            createAndSaveDefinition: isDirectExecution
              ? async (type, definition) => {
                const autoDefRepo = new YamlDefinitionRepository(
                  repoDir,
                  undefined,
                  repoContext.autoDefinitionsDir,
                  false,
                  repoContext.markDirty,
                );
                await autoDefRepo.save(type, definition);
              }
              : undefined,
            getDefinitionPath: isDirectExecution
              ? (type, id) => {
                return join(
                  repoContext.autoDefinitionsDir,
                  type.toDirectoryPath(),
                  `${id}.yaml`,
                );
              }
              : undefined,
            autoDefinitionsDir: isDirectExecution
              ? repoContext.autoDefinitionsDir
              : undefined,
            runTracker,
            workflowRepo: repoContext.workflowRepo,
            workflowRunRepo: repoContext.workflowRunRepo,
          };

          const timeoutMs = options.timeout
            ? parseTimerDuration(options.timeout as string)
            : undefined;
          const abort = new AbortController();
          const exitSuppress = suppressSyncExitOnSignal();
          const shutdownHandle = registerShutdownHandler({
            handler: () => abort.abort(),
            forceExitOnRepeat: true,
          });
          const baseLibCtx = libSwampContextForRepo(repoContext, {
            signal: abort.signal,
          });
          const libCtx = timeoutMs !== undefined
            ? baseLibCtx.withTimeout(timeoutMs)
            : baseLibCtx;

          // Pre-lookup for per-model lock acquisition (reads YAML — no lock needed)
          const preResult = await findDefinitionByIdOrName(
            repoContext.definitionRepo,
            modelIdOrName,
          );
          let modelLocks: ModelLockResult | undefined;
          // Set when a read or list run takes its model's lock only to
          // publish what it wrote (swamp-club#3934).
          let publishModel: { modelType: string; modelId: string } | undefined;
          if (preResult) {
            const model = {
              modelType: preResult.type.normalized,
              modelId: preResult.definition.id,
            };
            const lockMode = await methodRunLockMode({
              modelType: model.modelType,
              methodName,
              config: datastoreConfig,
              syncService,
              repoContext,
            });
            if (lockMode === "run") {
              const lockResult = await acquireModelLocks(
                datastoreConfig,
                [model],
                repoDir,
                syncService,
                repoContext.catalogStore,
                undefined,
                { repoContext },
              );
              if (lockResult.synced) repoContext.catalogStore.invalidate();
              modelLocks = lockResult;
              // A lapsed lease at serve cancels the run, as a signal would:
              // its cause names the lapse (swamp-club#4121).
              cancelOnLeaseLost(lockResult.leaseLost, abort);
            } else if (lockMode === "publish") {
              if (
                await pullModelsUnlocked(
                  datastoreConfig,
                  [model],
                  repoDir,
                  syncService,
                )
              ) {
                repoContext.catalogStore.invalidate();
              }
              publishModel = model;
            }
          }

          const initiatedBy = await resolveCliInitiatedBy();

          // Build the list of input sets to iterate over
          const inputSets: Record<string, unknown>[] = stdinItems
            ? stdinItems.map((item) =>
              Object.keys(cliInputs).length > 0
                ? deepMerge(item, cliInputs)
                : item
            )
            : [cliInputs];

          // What each run wrote, for the locks' push to publish
          // (swamp-club#3146).
          const written: WrittenVersion[] = [];
          // What each input set's run wrote, for its held JSON result.
          const writtenByRun: WrittenVersion[][] = inputSets.map(() => []);
          let runIndex = 0;
          let methodFailed = false;
          const runDeps: typeof deps = {
            ...deps,
            onWrittenVersions: (versions, outcome) => {
              for (const version of versions) {
                written.push(version);
                writtenByRun[runIndex]?.push(version);
              }
              if (outcome === "failed") methodFailed = true;
            },
          };
          // The versions a read or list run's publish left on this host,
          // which do not fail the run (swamp-club#3934).
          const unpublished: {
            written: WrittenVersion;
            reason: UnpublishedVersionView["reason"];
          }[] = [];
          const versionKey = (w: WrittenVersion) =>
            JSON.stringify([w.modelType, w.modelId, w.dataName, w.version]);
          /** Lists what `model`'s versions not yet listed were left as. */
          const leaveUnpublished = (
            model: { modelType: string; modelId: string },
            reason: UnpublishedVersionView["reason"],
          ) => {
            const listed = new Set(
              unpublished.map((u) => versionKey(u.written)),
            );
            for (const version of written) {
              if (
                version.modelType === model.modelType &&
                version.modelId === model.modelId &&
                !listed.has(versionKey(version))
              ) {
                unpublished.push({ written: version, reason });
              }
            }
          };
          const pushWritten = async (locks: ModelLockResult) => {
            try {
              await locks.pushWritten(written);
            } catch (error) {
              // A failed method run keeps its own error; the version it
              // could not publish is logged instead.
              if (
                !methodFailed ||
                !isUnpublishedDataError(error)
              ) {
                throw error;
              }
              if (error instanceof DataVersionConflictError) {
                for (const version of error.versions) {
                  unpublished.push({ written: version, reason: "conflict" });
                }
              }
              publishLogger.error("{message}", { message: error.message });
            }
          };
          const locks = modelLocks;
          const publishTo = publishModel;
          // Why a read or list run's publish failed, other than a conflict,
          // which is only logged (swamp-club#3934).
          let publishFailure: { error: unknown } | undefined;
          // Set once every input set ran and succeeded: only then does a
          // failed publish fail the command; otherwise it is logged.
          let runSucceeded = false;
          // In JSON mode a read or list run's result waits for its publish,
          // so it can name the versions left unpublished (swamp-club#3934).
          const holdResults = ctx.outputMode === "json" &&
            publishTo !== undefined;
          const heldResults: {
            render: (run: ModelMethodRunView) => void | Promise<void>;
            run: ModelMethodRunView;
            runIndex: number;
          }[] = [];
          const renderHeldResults = async () => {
            for (const held of heldResults.splice(0)) {
              const own = new Set(writtenByRun[held.runIndex].map(versionKey));
              const versions: UnpublishedVersionView[] = unpublished
                .filter((u) => own.has(versionKey(u.written)))
                .map((u) => ({
                  dataName: u.written.dataName,
                  version: u.written.version,
                  reason: u.reason,
                }));
              await held.render(
                versions.length > 0
                  ? { ...held.run, unpublishedVersions: versions }
                  : held.run,
              );
            }
          };
          const finished = await runCommandInRootUnit(
            repoContext,
            {
              // Progress streams in log mode; the result waits for the
              // commit (swamp-club#3759).
              output: ctx.outputMode === "log" ? "live-until-outcome" : "held",
              push: locks ? () => pushWritten(locks) : publishTo
                ? async () => {
                  if (written.length === 0) return;
                  try {
                    // Never waits on a writer (swamp-club#1992): when another
                    // run holds the lock, the next run that takes it on this
                    // host publishes what this one wrote (swamp-club#3934).
                    const publishLocks = await acquirePublishLocksOrDefer(
                      datastoreConfig,
                      publishTo,
                      written,
                      repoDir,
                      syncService,
                      repoContext.catalogStore,
                      { repoContext },
                    );
                    if (publishLocks === undefined) {
                      publishLogger.info(
                        "Behavior {model} is locked by another run, so this run's data will be published by the next run that locks it on this host",
                        {
                          model: `${publishTo.modelType}/${publishTo.modelId}`,
                        },
                      );
                      leaveUnpublished(publishTo, "deferred");
                      return;
                    }
                    try {
                      await pushWritten(publishLocks);
                    } finally {
                      try {
                        await publishLocks.release();
                      } catch (releaseError) {
                        publishLogger.warn("Failed to release locks: {error}", {
                          error: releaseError instanceof Error
                            ? releaseError.message
                            : String(releaseError),
                        });
                      }
                    }
                  } catch (error) {
                    // Another clone wrote the same version number while this
                    // run was unlocked: the method's work is done, so when the
                    // rest of its data was published a read or list run does
                    // not fail over it. Every run's summary reports write a
                    // version, so failing would fail any read that overlaps
                    // another clone's run (swamp-club#3934).
                    let cause: unknown = error;
                    if (error instanceof DataVersionConflictError) {
                      publishLogger.warn(
                        "Another swamp process wrote {versions} of behavior {model} while this run was running: the datastore keeps that copy, and this host now holds it in place of this run's",
                        {
                          versions: error.versions.map((v) =>
                            `${v.dataName} version ${v.version}`
                          ).join(", "),
                          model: `${publishTo.modelType}/${publishTo.modelId}`,
                        },
                      );
                      for (const version of error.versions) {
                        unpublished.push({
                          written: version,
                          reason: "conflict",
                        });
                      }
                      if (error.publishFailure === undefined) return;
                      // The rest was not published either: that failure
                      // decides the run, as it would without the conflict.
                      cause = error.publishFailure;
                    }
                    // Credentials the datastore refuses, such as read-only
                    // ones, never stopped a read before its data was
                    // published (swamp-club#3934), whether the refusal comes
                    // taking the lock, pulling under it or pushing: the data
                    // stays on this host, and nothing is recorded for a later
                    // lock, which the same credentials would be refused
                    // again. Only a refusal degrades; an unreachable
                    // datastore still fails.
                    if (isDatastoreAuthorizationError(cause)) {
                      publishLogger.warn(
                        "The datastore refused this host's credentials, so this run's data was not published to it and stays on this host only; a read or list run publishes what it writes, so its credentials must be able to read and write the behavior's data on the datastore: {error}",
                        {
                          error: cause instanceof Error
                            ? cause.message
                            : String(cause),
                        },
                      );
                      leaveUnpublished(publishTo, "unauthorized");
                      return;
                    }
                    publishFailure = { error: cause };
                    throw cause;
                  }
                }
                : undefined,
              release: modelLocks?.release,
              onCleanupError: (releaseError) => {
                if (releaseError === publishFailure?.error) {
                  // A run that succeeded fails below instead.
                  if (runSucceeded) return;
                  publishLogger.error(
                    "This run's data was not published to the datastore: {error}",
                    {
                      error: releaseError instanceof Error
                        ? releaseError.message
                        : String(releaseError),
                    },
                  );
                  return;
                }
                publishLogger.warn(
                  "Failed to release locks during cleanup: {error}",
                  {
                    error: releaseError instanceof Error
                      ? releaseError.message
                      : String(releaseError),
                  },
                );
              },
            },
            async () => {
              try {
                for (let i = 0; i < inputSets.length; i++) {
                  runIndex = i;
                  if (inputSets.length > 1) {
                    ctx.logger
                      .info`Running method ${methodName} [${
                      i + 1
                    }/${inputSets.length}]`;
                  }

                  const renderer = createModelMethodRunRenderer(
                    ctx.outputMode,
                    {
                      modelName: modelIdOrName,
                      methodName,
                      quiet: ctx.verbosity === "quiet",
                      verbose: ctx.verbosity === "verbose",
                      surface: syntax.surface,
                    },
                  );

                  const handlers = holdFromOutcome(renderer.handlers());
                  let heldFailed = false;
                  await runUnderModelLocks(modelLocks, () =>
                    consumeStream(
                      modelMethodRun(libCtx, runDeps, {
                        modelIdOrName,
                        methodName,
                        inputs: inputSets[i],
                        literalInputs: options.literalInputs === true,
                        lastEvaluated: options.lastEvaluated as boolean,
                        typeArg,
                        definitionName,
                        runtimeTags,
                        skipCheckNames: options.skipCheck as
                          | string[]
                          | undefined,
                        skipCheckLabels: options.skipCheckLabel as
                          | string[]
                          | undefined,
                        skipAllChecks: options.skipChecks as
                          | boolean
                          | undefined,
                        skipReportNames: options.skipReport as
                          | string[]
                          | undefined,
                        skipReportLabels: options.skipReportLabel as
                          | string[]
                          | undefined,
                        skipAllReports: options.skipReports as
                          | boolean
                          | undefined,
                        reportNames: options.report as string[] | undefined,
                        reportLabels: options.reportLabel as
                          | string[]
                          | undefined,
                        swampSha: GIT_SHA || undefined,
                        autoGc,
                        traceparent: resolveTraceparent(
                          options.traceparent as string | undefined,
                        ),
                        tracestate: resolveTracestate(
                          options.tracestate as string | undefined,
                        ),
                        initiatedBy,
                      }),
                      holdResults
                        ? {
                          ...handlers,
                          completed: (e) => {
                            if (e.run.status === "failed") heldFailed = true;
                            heldResults.push({
                              render: (run) =>
                                handlers.completed({ ...e, run }),
                              run: e.run,
                              runIndex: i,
                            });
                          },
                        }
                        : handlers,
                    ));

                  if (abort.signal.aborted) {
                    Deno.exitCode = 1;
                    return false;
                  }

                  if (renderer.runFailed() || heldFailed) {
                    Deno.exitCode = 1;
                    return false;
                  }
                }
                runSucceeded = true;
                return true;
              } catch (error) {
                if (error instanceof UserError) {
                  throw error;
                }
                const message = error instanceof Error
                  ? messageFor(error, syntax.surface)
                  : String(error);
                throw new UserError(`Method execution failed: ${message}`);
              } finally {
                shutdownHandle.dispose();
                exitSuppress.dispose();
              }
            },
          ).catch((error) => {
            // The method ran before its commit failed (swamp-club#3759).
            throw error instanceof CommitUnreachableError
              ? error.afterStepsRan()
              : error;
          })
            // A held JSON result names what the publish left unpublished.
            // Rendered whichever way the root ended; a render failure never
            // replaces the error the command is already failing with.
            .then(
              async (value) => {
                await renderHeldResults();
                return value;
              },
              async (error) => {
                try {
                  await renderHeldResults();
                } catch (renderError) {
                  publishLogger.warn(
                    "Failed to render the run's result: {error}",
                    {
                      error: renderError instanceof Error
                        ? renderError.message
                        : String(renderError),
                    },
                  );
                }
                throw error;
              },
            );
          if (!finished) return;
          if (publishFailure !== undefined) {
            const { error } = publishFailure;
            // A typed error (a lock timeout, an unpublished version) keeps
            // its own code and exit status, as on a mutating run's push.
            if (error instanceof UserError) {
              publishLogger.error(
                "This run's data was not published to the datastore",
              );
              throw error;
            }
            const message = error instanceof Error
              ? error.message
              : String(error);
            throw new UserError(
              `This run's data was not published to the datastore ` +
                `(${message.replace(/\.$/, "")}). It is on this host only; ` +
                `run the method again to write and publish it.`,
              "datastore_publish_failed",
            );
          }

          ctx.logger.debug("Method run command completed");
        } finally {
          runTracker.close();
        }
      },
    );
  return recordDefiningModule(built, import.meta.url);
}

export const modelMethodRunCommand = createModelMethodRunCommand(
  MODEL_METHOD_RUN_SYNTAX,
);

/**
 * The run syntax of the `run` subcommand of a `method` group reached as
 * `syntax`. The legacy `swamp model method run` names a direct type before
 * `method` instead, so its group is built with MODEL_METHOD_RUN_SYNTAX.
 */
function methodRunSyntax(syntax: CommandSyntax): RunCommandSyntax {
  const run = subcommandSyntax(syntax, "run").invocation;
  return {
    invocation: (model, method) => `${run} ${model} ${method}`,
    directInvocation: (type, method, name) =>
      `${run} ${type} ${method} ${name}`,
    surface: syntax.surface,
  };
}

/** The subcommands of `model method`, in registration order. */
export interface ModelMethodChildren {
  readonly run: ReturnType<typeof createModelMethodRunCommand>;
  readonly describe: ReturnType<typeof createModelMethodDescribeCommand>;
  readonly history: ReturnType<typeof createModelMethodHistoryCommand>;
}

/** The legacy spelling: `swamp model method`. */
export const MODEL_METHOD_SYNTAX: CommandSyntax = {
  invocation: "swamp model method",
  surface: "model",
};

/**
 * Builds the `method` group for one CLI surface. Children not passed are
 * built fresh from `syntax`; Cliffy reparents a command attached under a
 * second parent, so two surfaces must never share an instance.
 */
export function createModelMethodCommand(
  syntax: CommandSyntax,
  children: Partial<ModelMethodChildren> = {},
) {
  const command = new Command()
    .name("method")
    .description(`Execute ${syntax.surface} methods`)
    .error(unknownCommandErrorHandler)
    .action(groupCommandAction)
    .command(
      "run",
      children.run ?? createModelMethodRunCommand(methodRunSyntax(syntax)),
    )
    .command(
      "describe",
      children.describe ??
        createModelMethodDescribeCommand(subcommandSyntax(syntax, "describe")),
    )
    .command(
      "history",
      children.history ??
        createModelMethodHistoryCommand(subcommandSyntax(syntax, "history")),
    );
  return recordDefiningModule(command, import.meta.url);
}

export const modelMethodCommand = createModelMethodCommand(
  MODEL_METHOD_SYNTAX,
  {
    run: modelMethodRunCommand,
    describe: modelMethodDescribeCommand,
    history: modelMethodHistoryCommand,
  },
);

/**
 * The --server branch: dispatch the method run through a `swamp serve`
 * server and render the streamed events with the same renderer a local run
 * uses. No local repository is required.
 */
async function runMethodViaServer(
  server: string,
  options: AnyOptions,
  modelIdOrName: string,
  methodName: string,
  info: { typeArg?: string; definitionName?: string },
  surface: CommandSurface,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, [
    "model",
    "method",
    "run",
  ]);
  const stdinContent = options.stdin ? await readStdin() : null;
  let stdinItems: Record<string, unknown>[] | null = null;
  if (stdinContent !== null) {
    if (options.inputFile) {
      throw new UserError("Cannot combine --stdin with --input-file.");
    }
    stdinItems = parseStdinContent(stdinContent);
  }
  const literalInputs = options.literalInputs === true;
  const { inputs: cliInputs } = await parseInputs({
    input: mergeInputArgs(options),
    inputFile: stdinItems ? undefined : options.inputFile as string | undefined,
    literal: literalInputs,
  });
  const runtimeTags = options.tag
    ? parseTags(options.tag as string[])
    : undefined;

  const abort = new AbortController();
  if (options.timeout) {
    const timeoutMs = parseTimerDuration(options.timeout as string);
    setTimeout(() => abort.abort(), timeoutMs);
  }
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

  try {
    // An older server ignores literalInputs and evaluates the inputs, so the
    // flag is only sent to one that says it honours it (swamp-club#3205). The
    // probe costs one extra request, and only under --literal-inputs; it must
    // not be dropped, or the flag would fail open against an old server. It
    // runs inside the try so the shutdown handler is always disposed, and
    // under the run's signal so --timeout bounds it too.
    if (literalInputs) {
      const version = await requestServerResponse<
        { version: string; capabilities?: string[] }
      >(
        { server, token, signal: abort.signal },
        { type: "server.version" },
      );
      if (!version.capabilities?.includes(SERVE_CAPABILITY_LITERAL_INPUTS)) {
        throw new UserError(
          `The server (swamp ${version.version}) does not support --literal-inputs, so it would evaluate expressions in the inputs. Upgrade swamp serve, or run without --server.`,
        );
      }
    }
    for (let i = 0; i < inputSets.length; i++) {
      if (inputSets.length > 1) {
        ctx.logger
          .info`Running method ${methodName} [${
          i + 1
        }/${inputSets.length}] via ${
          redactServerUrl(server) ?? "(invalid URL)"
        }`;
      }
      const renderer = createModelMethodRunRenderer(ctx.outputMode, {
        modelName: modelIdOrName,
        methodName,
        quiet: ctx.verbosity === "quiet",
        verbose: ctx.verbosity === "verbose",
        surface,
      });
      await consumeStream(
        runModelMethodOverServer({
          server,
          token,
          signal: abort.signal,
          payload: {
            modelIdOrName,
            methodName,
            inputs: inputSets[i],
            ...(literalInputs ? { literalInputs: true } : {}),
            lastEvaluated: options.lastEvaluated as boolean,
            runtimeTags,
            typeArg: info.typeArg,
            definitionName: info.definitionName,
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
          },
        }) as AsyncIterable<ModelMethodRunEvent>,
        renderer.handlers(),
      );
      if (renderer.runFailed()) {
        Deno.exitCode = 1;
        return;
      }
    }
  } finally {
    shutdown.dispose();
  }
}
