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

import { z } from "zod";
import { ModelType } from "../../model_type.ts";
import {
  type DataHandle,
  type DataSpliceArgs,
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
  type SecretDestinationArgs,
} from "../../model.ts";
import { UserError } from "../../../errors.ts";
import type { SecretBagRegistry } from "../../../vaults/secret_bag_registry.ts";
import { secretOccurrencesOf } from "../../../vaults/secret_occurrences.ts";
import { coerceMethodArgs } from "../../zod_type_coercion.ts";
import { SecretDestinationRefusedError } from "../../secret_destinations.ts";
import { executeProcess } from "../../../../infrastructure/process/process_executor.ts";
import {
  createSafeMethodEnv,
  NESTED_SWAMP_ENV_VARS,
} from "../../../remote/environment_snapshot.ts";
import { processLockHolderMarker } from "../../../datastore/lock_holder_marker.ts";
import { traceHeadersToEnv } from "../../execution_envelope.ts";
import { selectShellStrategy } from "./shell_strategy.ts";
import {
  placeShellData,
  shellDialectFor,
} from "../../../vaults/shell_data_placement.ts";

const shellStrategy = selectShellStrategy();

/**
 * Schema for shell model input attributes.
 */
export const ShellInputAttributesSchema = z.object({
  run: z.string().min(1).meta({ foreignTemplate: true }).describe(
    "The shell command to execute",
  ),
  // A path destination: a secret never becomes a working directory
  // (design/enablers/typed-secrets.md Section 7.1).
  workingDir: z.string().meta({ secrets: "refuse" }).optional().describe(
    "Working directory for command execution",
  ),
  timeout: z.number().int().positive().optional().describe(
    "Timeout in milliseconds",
  ),
  env: z.record(z.string(), z.string()).optional().describe(
    "Environment variables",
  ),
  ignoreExitCode: z.boolean().optional().describe(
    "If true, non-zero exit codes will not cause the method to throw",
  ),
});

/**
 * Type for shell model input attributes.
 */
export type ShellInputAttributes = z.infer<typeof ShellInputAttributesSchema>;

/**
 * Schema for shell model data attributes.
 * Note: stdout/stderr are now stored in log artifacts, but kept here for
 * backward compatibility with existing outputs and for structured access.
 */
export const ShellDataAttributesSchema = z.object({
  exitCode: z.number().int().describe("Exit code of the command"),
  executedAt: z.string().datetime().describe(
    "Timestamp when execution completed",
  ),
  command: z.string().describe("The command that was executed"),
  durationMs: z.number().int().nonnegative().optional().describe(
    "Execution duration in milliseconds",
  ),
  stdout: z.string().optional().describe("Standard output from the command"),
  stderr: z.string().optional().describe("Standard error from the command"),
});

/**
 * Type for shell model data attributes.
 */
export type ShellDataAttributes = z.infer<typeof ShellDataAttributesSchema>;

/**
 * The shell model type identifier.
 */
export const SHELL_MODEL_TYPE = ModelType.create("command/shell");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

/**
 * The shell's own destination policy (design/enablers/typed-secrets.md
 * Section 7.2), run by the method boundary before any secret is loaded, over
 * the arguments as `unresolvedMethodArgs` carries them, so `run` and `env`
 * authored under `globalArguments` are covered too. A secret in an
 * environment variable name is refused: expression evaluation never reaches
 * an object key, but an `env` authored as a JSON string is parsed by argument
 * coercion, which is why the boundary coerces the arguments before this runs.
 * A data-origin secret at a
 * position no environment reference can expand (a here-document with a
 * quoted delimiter; PowerShell single quotes) is refused instead of pasted
 * into the command. A `run` that is not a string or an `env` that is not an
 * object is left to argument validation.
 */
export function refuseShellSecretDestinations(
  { arguments: args, secrets }: SecretDestinationArgs,
): void {
  const env = isPlainObject(args.env) ? args.env : undefined;
  const envKeys = env ? Object.keys(env) : [];
  for (const key of envKeys) {
    const [occurrence] = secrets.occurrencesIn(key);
    if (occurrence) {
      throw new SecretDestinationRefusedError(
        "an environment variable name",
        occurrence.reference,
        occurrence.location,
        "a secret can be an environment variable's value, never its name",
      );
    }
  }
  const run = args.run;
  if (typeof run !== "string") return;
  // The same plan executeCommand fills after the load: both read the
  // authored env keys from the arguments as written, and expression
  // evaluation never changes an object key, so the two agree.
  const plan = shellStrategy.planSecrets(run, envKeys, secrets.originOf);
  const refused = plan.refused[0];
  if (refused === undefined) return;
  const occurrence = secrets.occurrencesIn(run).find((o) =>
    o.start === refused.start
  );
  throw new SecretDestinationRefusedError(
    `the shell command inside ${refused.where}`,
    occurrence?.reference,
    occurrence?.location,
    "no environment variable reference expands there, so the value would " +
      `be pasted into the command line; ${refused.fix}`,
  );
}

/** The error code of data text placed where the shell cannot take it. */
export const SHELL_DATA_PLACEMENT_REFUSED = "shell_data_placement_refused";

/** How to pass data that is meant to be split or run, in every refusal. */
const DATA_IN_RUN_WORKAROUND =
  "To split a value into words or run it as code, pass it in the env " +
  "argument and reference the variable in run (POSIX: an unquoted $NAME " +
  "splits it, eval runs it; PowerShell: $env:NAME)";

/**
 * The shell's data placement (swamp-club#3868, design/enablers/expressions.md
 * Shell Safety): text in `run` that came from data (a caller's or a webhook's
 * input, a data read, a step output, an environment variable) reaches the
 * shell as one literal word through a generated `__SWAMP_IN_<n>` variable in
 * `env`, never as syntax. Authored text is unchanged. A data range where no
 * reference expands, a `run` that is nothing but data, and a host whose
 * shell swamp does not know are refused. An `env` authored as a JSON string
 * is coerced as argument validation would, so the generated names join it.
 */
export function placeShellDataSplices(
  { arguments: args, dataRangesOf, platform }: DataSpliceArgs,
): Record<string, unknown> {
  const run = args.run;
  if (typeof run !== "string") return {};
  const ranges = dataRangesOf("run");
  if (ranges.length === 0) return {};
  const dialect = shellDialectFor(platform);
  if (dialect === undefined) {
    throw new UserError(
      `Refused to run the command: it holds text from data, and swamp does ` +
        `not know the shell of platform '${platform}' to pass it safely ` +
        `(${SHELL_DATA_PLACEMENT_REFUSED})`,
      SHELL_DATA_PLACEMENT_REFUSED,
    );
  }
  const env = isPlainObject(args.env)
    ? args.env
    : coerceMethodArgs({ env: args.env }, ShellInputAttributesSchema).env;
  if (env !== undefined && !isPlainObject(env)) {
    // Argument validation refuses this env too; refused here first so the
    // generated names never replace it.
    throw new UserError(
      `Refused to run the command: env is not an object of variables, so ` +
        `the text from data in run has nowhere to go ` +
        `(${SHELL_DATA_PLACEMENT_REFUSED})`,
      SHELL_DATA_PLACEMENT_REFUSED,
    );
  }
  const authoredEnv = env ?? {};
  const placed = placeShellData(
    run,
    ranges,
    Object.keys(authoredEnv),
    dialect,
  );
  if (Object.keys(placed.env).length === 0 && !placed.refused) return {};
  if (placed.wholeCommandIsData) {
    throw new UserError(
      `Refused to run the command: run is entirely text from data, which ` +
        `swamp passes as one literal word, so it could only name a program. ` +
        `${DATA_IN_RUN_WORKAROUND} (${SHELL_DATA_PLACEMENT_REFUSED})`,
      SHELL_DATA_PLACEMENT_REFUSED,
    );
  }
  if (placed.refused) {
    throw new UserError(
      `Refused to run the command: text from data sits inside ` +
        `${placed.refused.where}, where ${placed.refused.why}, so it ` +
        `cannot be passed as one literal word; ` +
        `${placed.refused.fix}. ${DATA_IN_RUN_WORKAROUND} ` +
        `(${SHELL_DATA_PLACEMENT_REFUSED})`,
      SHELL_DATA_PLACEMENT_REFUSED,
    );
  }
  return { run: placed.command, env: { ...authoredEnv, ...placed.env } };
}

/** The error code of a child environment value swamp cannot pass on. */
export const SHELL_ENVIRONMENT_VALUE_REFUSED =
  "shell_environment_value_refused";

/**
 * Refuses a child environment value that holds a NUL character, which no
 * process environment can carry, before anything is launched
 * (design/enablers/typed-secrets.md Section 7.1). The message names the
 * authored variable, or for a generated name the vault and key the value
 * was loaded for, never the value. This check depends on loaded values, so
 * it comes after the load, unlike the destination refusals, which need none.
 */
function assertNoNulInEnvironment(
  env: Record<string, string>,
  envNames: ReadonlyMap<string, string>,
  registry: SecretBagRegistry,
): void {
  const generated = new Map(
    [...envNames].map(([sentinel, name]) => [name, sentinel]),
  );
  for (const [name, value] of Object.entries(env)) {
    if (!value.includes("\u0000")) continue;
    const sentinel = generated.get(name);
    const entry = sentinel === undefined
      ? undefined
      : registry.issuedEntryOf(sentinel);
    const what = entry
      ? `the secret '${entry.reference.key}' in vault '${entry.reference.vaultName}'`
      : `the environment variable '${name}'`;
    // The code is in the text too: the in-process executor reports a
    // method's error by its message.
    throw new UserError(
      `Refused to launch the command: ${what} holds a NUL character, which ` +
        `no process environment can carry (${SHELL_ENVIRONMENT_VALUE_REFUSED})`,
      SHELL_ENVIRONMENT_VALUE_REFUSED,
    );
  }
}

/**
 * Executes a shell command and captures the output.
 */
async function executeCommand(
  args: ShellInputAttributes,
  context: MethodContext,
): Promise<MethodResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let durationMs = 0;
  let stoppedByCancel = false;

  const redact = (text: string) =>
    context.redactor?.hasSecrets ? context.redactor.redact(text) : text;

  // Resolve vault secrets via environment variables to prevent shell injection.
  // The unresolved run field contains sentinel tokens for vault secrets.
  // The strategy replaces sentinels with shell-appropriate env var references
  // (`${VAR}` on POSIX, `$env:VAR` on PowerShell) and returns the raw secret
  // values to inject via the process environment, so the shell never parses
  // secret content as syntax. Done before the lock hand-off and the try
  // below: a refusal here is an error of the step, with no result written
  // for a command that never launched.
  let shellCommand = args.run;
  let shellEnv = args.env ?? {};
  let envNames: ReadonlyMap<string, string> = new Map();
  const secretBag = context.vaultSecrets;
  if (secretBag?.resolvesAny && context.unresolvedMethodArgs) {
    const unresolvedRun = context.unresolvedMethodArgs.run;
    if (typeof unresolvedRun === "string") {
      // The method boundary applies this policy before the load; a typed
      // caller that reaches the method another way meets it here, so the
      // command line is safe however the shell is reached.
      {
        // The authored env, with its sentinels, read as validation reads it;
        // `args.env` already holds the values.
        const authored = coerceMethodArgs(
          { env: context.unresolvedMethodArgs.env },
          ShellInputAttributesSchema,
        );
        refuseShellSecretDestinations({
          arguments: {
            run: unresolvedRun,
            env: authored.env ?? args.env ?? {},
          },
          secrets: secretOccurrencesOf(secretBag.registry),
        });
      }
      const resolved = shellStrategy.resolveSecrets(
        unresolvedRun,
        secretBag,
        Object.keys(shellEnv),
      );
      if (resolved.singleQuoted.length > 0) {
        context.onEvent?.({
          type: "vault_single_quote_warning",
          message:
            "Vault secret expression inside single quotes will not be expanded by the shell — use double quotes instead",
        });
      }
      if (resolved.dataInCommandLine) {
        context.onEvent?.({
          type: "sensitive_value_in_command_line",
          message:
            "Sensitive data value inside a quoted here-document or a single-quoted PowerShell string is passed on the command line — use an unquoted here-document delimiter or double quotes instead",
        });
      }
      shellCommand = resolved.command;
      shellEnv = { ...shellEnv, ...resolved.env };
      envNames = resolved.envNames;
    }
  }
  if (secretBag) {
    assertNoNulInEnvironment(shellEnv, envNames, secretBag.registry);
  }

  // The command is lent the locks held for this run. Begun outside the try
  // below, which turns a thrown error into a result that is still written.
  const lockHandOff = await processLockHolderMarker.beginChildHandOff();

  try {
    const invocation = shellStrategy.buildInvocation(shellCommand);
    // This execution's own trace context and held locks override whatever
    // the shared process env holds; explicit user env still wins over both.
    const processEnv = {
      ...createSafeMethodEnv(Deno.env.toObject(), NESTED_SWAMP_ENV_VARS),
      ...lockHandOff.lent,
      ...traceHeadersToEnv(context.traceHeaders),
      ...shellEnv,
    };
    const result = await executeProcess({
      command: invocation.command,
      args: invocation.args,
      cwd: args.workingDir,
      env: processEnv,
      clearEnv: true,
      timeoutMs: args.timeout,
      signal: context.signal,
      logger: context.logger,
      redactor: context.redactor,
      terminateProcessTree: true,
      normalizeCrlf: shellStrategy.normalizesCrlfOutput,
    });

    stdout = redact(result.stdout);
    stderr = redact(result.stderr);
    exitCode = result.exitCode;
    durationMs = result.durationMs;
  } catch (error) {
    // Handle execution errors (command not found, timeout, etc.)
    const rawError = error instanceof Error ? error.message : String(error);
    stderr = redact(rawError);
    exitCode = -1;
    stoppedByCancel = context.signal.aborted;
  }

  // The command has returned, so this run no longer waits on anything it
  // left running. Take the locks back before writing under them; a failure
  // here fails the method with nothing written. A command the cancel
  // stopped does not wait for a structural command still working under
  // them: the end rejects and the step stays cancelled. A command that
  // finished first waits, so a later cancel does not discard its output.
  await lockHandOff.end(stoppedByCancel ? context.signal : undefined);

  // Persisted before the exit code is judged, not after. The output is the
  // only account of what the command did, and a command that failed is the one
  // whose account is worth having: a red gate used to arrive as
  // `Command exited with code 1` and nothing else, so a review that genuinely
  // voted to reject and a review whose CLI crashed were indistinguishable, and
  // a failing test suite named no failing test.
  const resultAttributes = {
    exitCode,
    executedAt: new Date().toISOString(),
    command: redact(args.run),
    durationMs,
    stdout,
    stderr,
  };

  // Create output log content
  const outputLogParts: string[] = [];
  if (stdout) {
    outputLogParts.push(`[stdout]\n${stdout}`);
  }
  if (stderr) {
    outputLogParts.push(`[stderr]\n${stderr}`);
  }
  const outputLogContent = outputLogParts.join("\n");

  const resultHandle = await context.writeResource!(
    "result",
    "result",
    resultAttributes,
  );

  const logWriter = context.createFileWriter!("log", "log");
  const logHandle = await logWriter.writeText(outputLogContent);

  if (exitCode !== 0 && !args.ignoreExitCode) {
    // The handles ride along on the error. The execution service looks for
    // exactly this and turns them into data artifacts on the failed step, so
    // `swamp data get` reaches the output of a step that failed — the same
    // route a model that writes data and then throws on a FAIL verdict
    // already takes.
    const failure = new Error(`Command exited with code ${exitCode}`) as
      & Error
      & {
        dataHandles?: DataHandle[];
      };
    failure.dataHandles = [resultHandle, logHandle];
    throw failure;
  }

  return { dataHandles: [resultHandle, logHandle] };
}

/**
 * The shell model definition.
 *
 * A model that executes shell commands on the host system and captures
 * the output (stdout, stderr, exit code).
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const shellModel: ModelDefinition = defineModel({
  type: SHELL_MODEL_TYPE,
  version: "2026.02.09.1",
  resources: {
    "result": {
      description:
        "Shell command execution result (exit code, timing, command)",
      schema: ShellDataAttributesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    "log": {
      description: "Shell command output (stdout and stderr)",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: true,
    },
  },
  methods: {
    execute: {
      description:
        "Execute the shell command and capture stdout, stderr, and exit code",
      arguments: ShellInputAttributesSchema,
      execute: executeCommand,
      refuseSecretDestinations: refuseShellSecretDestinations,
      placeDataSplices: placeShellDataSplices,
    },
  },
});
