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
  libSwampContextForRepo,
  type ModelLockResult,
  requireInitializedRepoUnlocked,
  runUnderModelLocks,
} from "../repo_context.ts";
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
import {
  inferMethodKind,
  isMutatingKind,
  modelRegistry,
} from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { runFileSink } from "../../infrastructure/logging/logger.ts";
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
} from "../remote_run.ts";
import { SERVE_CAPABILITY_LITERAL_INPUTS } from "../../serve/protocol.ts";
import { redactServerUrl } from "../../domain/auth/server_url.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { suppressSyncExitOnSignal } from "../../infrastructure/persistence/datastore_sync_coordinator.ts";
import { parseTimerDuration } from "../duration_parser.ts";
import { resolveCliInitiatedBy } from "../auth_context.ts";
import {
  isUnpublishedDataError,
  type WrittenVersion,
} from "../../domain/datastore/datastore_sync_service.ts";
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
      "Run through a 'swamp serve' server (ws:// or http://) instead of locally; no local repo required (env: SWAMP_SERVE_URL).",
    )
    .option(
      "--token <token:string>",
      "Server token in <name>.<secret> format; only applies with --server (overrides stored credentials and SWAMP_SERVER_TOKEN)",
    )
    .option(
      "--token-file <path:string>",
      "Path to a file containing the server token; mutually exclusive with --token (env: SWAMP_SERVER_TOKEN_FILE)",
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
            { ...options, server },
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
          let mutating = true;
          if (preResult) {
            try {
              const modelDef = await resolveModelType(
                preResult.type.normalized,
                getAutoResolver(),
              );
              if (modelDef) {
                const method = modelDef.methods[methodName];
                mutating = isMutatingKind(
                  inferMethodKind(methodName, method),
                );
              }
            } catch {
              // Resolution failure — fall back to acquiring locks
            }
            if (mutating) {
              const lockResult = await acquireModelLocks(
                datastoreConfig,
                [
                  {
                    modelType: preResult.type.normalized,
                    modelId: preResult.definition.id,
                  },
                ],
                repoDir,
                syncService,
                repoContext.catalogStore,
                undefined,
                { repoContext },
              );
              if (lockResult.synced) repoContext.catalogStore.invalidate();
              modelLocks = lockResult;
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
          let methodFailed = false;
          const runDeps: typeof deps = {
            ...deps,
            onWrittenVersions: (versions, outcome) => {
              for (const version of versions) written.push(version);
              if (outcome === "failed") methodFailed = true;
            },
          };
          const locks = modelLocks;
          const finished = await runCommandInRootUnit(
            repoContext,
            {
              // Progress streams in log mode; the result waits for the
              // commit (swamp-club#3759).
              output: ctx.outputMode === "log" ? "live-until-outcome" : "held",
              push: locks
                ? async () => {
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
                    ctx.logger.error("{message}", { message: error.message });
                  }
                }
                : undefined,
              release: modelLocks?.release,
              onCleanupError: (releaseError) => {
                ctx.logger.warn(
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
                      holdFromOutcome(renderer.handlers()),
                    ));

                  if (abort.signal.aborted) {
                    Deno.exitCode = 1;
                    return false;
                  }

                  if (renderer.runFailed()) {
                    Deno.exitCode = 1;
                    return false;
                  }
                }
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
          });
          if (!finished) return;

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
    options.server as string,
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
        { server: options.server as string, token, signal: abort.signal },
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
          redactServerUrl(options.server as string) ?? "(invalid URL)"
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
          server: options.server as string,
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
