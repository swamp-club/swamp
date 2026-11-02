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

import { basename } from "@std/path";
import type { z } from "zod";
import {
  type DataHandle,
  inferMethodKind,
  isMutatingKind,
  type MethodContext,
  type MethodDefinition,
  type MethodResult,
  type ModelDefinition,
  modelRegistry,
} from "./model.ts";
import {
  type LockHandOff,
  MAX_REMOTE_LOCK_IDS,
  processLockHolderMarker,
  type RemoteLockHolder,
} from "../datastore/lock_holder_marker.ts";
import { Definition } from "../definitions/definition.ts";
import {
  describeUnreadReference,
  type SecretRedactor,
  type UnreadReferenceLookup,
} from "../secrets/mod.ts";
import type { WrittenVersion } from "../datastore/datastore_sync_service.ts";
import { markErrorPaths, UserError } from "../errors.ts";
import type { DataArtifactRef } from "./model_output.ts";
import { executionErrorFrom, ModelOutput } from "./model_output.ts";
import { refuseSecretDestinations } from "./secret_destinations.ts";
import { DataOutputValidationService } from "./data_output_validation_service.ts";
import { DefinitionUpgradeService } from "./definition_upgrade_service.ts";
import { resolveStaleness } from "../definitions/definition_staleness.ts";
import {
  assertNoReservedRunTags,
  modelRequiresVault,
  outputSpecTags,
} from "./data_writer.ts";
import { sensitiveOutputTargets } from "./sensitive_output_vault.ts";
import {
  currentVaultAccess,
  VaultAccessDeniedError,
} from "../vaults/run_vault_access.ts";
import {
  coerceMethodArgs,
  getObjectShape,
  isRecordSchema,
  parseGlobalArgumentsLeniently,
} from "./zod_type_coercion.ts";
import { extractExpressions } from "../expressions/expression_parser.ts";
import { containsSwampExpression } from "../expressions/swamp_namespaces.ts";
import {
  type DataRange,
  keyPath,
  methodArgumentPath,
  ProvenanceMap,
} from "../expressions/provenance_map.ts";
import {
  containsEnvExpression,
  containsVaultExpression,
} from "../expressions/expression_evaluation_service.ts";
import type { Data } from "../data/data.ts";
import type { ExecutionOutput } from "./execution_envelope.ts";
import { InProcessExecutor } from "./in_process_executor.ts";
import {
  injectTraceContext,
  withSpan,
} from "../../infrastructure/tracing/mod.ts";
import {
  getRemoteStepDispatcher,
  isRemoteOnlyMode,
  type LegacyStepDelivery,
  remoteOutputsOf,
  type RemoteStepResult,
} from "../remote/remote_dispatch.ts";
import type { RpcStreamEvent } from "../remote/protocol.ts";
import type { Logger } from "@logtape/logtape";
import { escapeLogTemplate } from "../../infrastructure/logging/logger.ts";
import { hasPlacement } from "../remote/scheduler.ts";
import {
  wordedError,
  wordedText,
  wordedUserError,
} from "../behavior_wording.ts";
import { createDataId } from "../data/data_id.ts";
import {
  extractDeliveredSensitiveValues,
  extractRefusedSensitiveValues,
  extractSensitiveFieldValues,
  maskRefusedIssues,
  type ReportedIssue,
  schemaThrew,
} from "./sensitive_field_extractor.ts";
import { type SecretLoader, secretReadKey } from "../vaults/secret_loader.ts";
import {
  type SecretReference,
  SENTINEL_MARK,
} from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { vaultReferenceText } from "../secrets/run_sensitive_values.ts";
import { argumentParseContext } from "../untrusted_parse.ts";
import {
  type SecretOccurrences,
  secretOccurrencesOf,
} from "../vaults/secret_occurrences.ts";

interface PreparedDelivery {
  definition: Definition;
  context: MethodContext;
  globalArgsParseInput: Record<string, unknown>;
  checkUnresolvedMethodArgs: Record<string, unknown>;
}

interface RemoteDelivery {
  legacyDelivery: () => Promise<LegacyStepDelivery>;
  validated: (() => Promise<void>) | undefined;
}

/**
 * called at most once however often the result is: a re-dispatched remote
 * attempt reports validated arguments from each worker, and the caller's record
 * is written once
 */
function onceOnly(
  hook: (() => Promise<void>) | undefined,
): (() => Promise<void>) | undefined {
  if (hook === undefined) return undefined;
  let called: Promise<void> | undefined;
  return () => called ??= hook();
}

/**
 * called while the method runs on the worker, so a thrown error cannot stop it:
 * it is logged as a warning and the step keeps the reported outcome, since
 * failing a step that ran would invite a rerun
 */
function reportedOnly(
  hook: (() => Promise<void>) | undefined,
  context: Pick<MethodContext, "logger" | "redactor">,
): (() => Promise<void>) | undefined {
  if (hook === undefined) return undefined;
  return async () => {
    try {
      await hook();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.logger.warn(
        "Could not record the arguments the worker validated: {error}",
        { error: redacted(message, context.redactor) },
      );
    }
  };
}

/**
 * each sentinel is written as the reference text a persisted definition holds,
 * so the hash is stable across runs and computed from no value
 */
function withReferenceText(
  definition: Definition,
  bag: VaultSecretBag | undefined,
): Definition {
  if (!bag?.resolvesAny) return definition;
  const registry = bag.registry;
  const write = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(VaultSecretBag.SENTINEL_PATTERN, (sentinel) => {
        const entry = registry.issuedEntryOf(sentinel);
        return entry === undefined
          ? sentinel
          : vaultReferenceText(entry.reference);
      });
    }
    if (Array.isArray(value)) return value.map(write);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, write(item)]),
      );
    }
    return value;
  };
  return Definition.fromData(
    write(definition.toData()) as ReturnType<Definition["toData"]>,
  );
}

function filterDeclaredResourceData(
  allData: Data[],
  declaredResources: Record<string, unknown>,
): Data[] {
  const specNames = new Set(Object.keys(declaredResources));
  return allData.filter((d) => isDeclaredResourceData(d, specNames));
}

function isDeclaredResourceData(
  data: Data,
  specNames: ReadonlySet<string>,
): boolean {
  return data.tags["type"] === "resource" &&
    data.tags["specName"] !== undefined &&
    specNames.has(data.tags["specName"]);
}

function collectPersistedHandles(outputs: ExecutionOutput[]): DataHandle[] {
  const handles: DataHandle[] = [];
  for (const output of outputs) {
    if (output.kind === "persisted") {
      handles.push(output.handle);
    }
  }
  return handles;
}

function formatZodError(error: { issues: readonly ReportedIssue[] }): string {
  if (error.issues.length === 1) {
    const issue = error.issues[0];
    const path = issue.path.length > 0 ? ` at "${issue.path.join(".")}"` : "";
    return `${issue.message}${path}`;
  }
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? ` at "${issue.path.join(".")}"` : "";
      return `${issue.message}${path}`;
    })
    .join("; ");
}

export interface MethodExecutionService {
  execute(
    definition: Definition,
    method: MethodDefinition,
    context: MethodContext,
  ): Promise<MethodResult>;

  /**
   * one call is one delivery attempt: it loads the vault references in the
   * global arguments and the method's arguments once
   */
  executeWorkflow(
    definition: Definition,
    modelDef: ModelDefinition,
    methodName: string,
    context: MethodContext,
    options?: MethodDeliveryOptions,
  ): Promise<MethodResult>;
}

export interface MethodDeliveryOptions {
  /**
   * where data sits after the runtime pass, so placeDataSplices keeps data text
   * from being parsed as syntax; required, since leaving it out would run data
   * as authored text (pass ProvenanceMap.authored() if none)
   */
  argumentProvenance: ProvenanceMap;
  /**
   * the loader of the evaluator whose runtime pass issued the references, not
   * part of the context a method or check receives; without one, a vault
   * reference in the arguments fails at delivery
   */
  secretLoader?: SecretLoader;
  /**
   * called once arguments pass their schema, before the method runs, so refused
   * arguments never replace the last good record; a thrown error fails the run,
   * except on a worker's report, where it is only logged
   */
  onArgumentsValidated?: () => Promise<void>;
  /**
   * stored sensitive-field references whose vault read failed: an argument
   * still holding one fails naming the vault, key and provider error, not as an
   * unresolved expression; not part of the method's context
   */
  unreadReferences?: UnreadReferenceLookup;
}

function unreadReferenceError(
  location: string,
  value: unknown,
  unread: UnreadReferenceLookup | undefined,
): Error | undefined {
  if (!unread) return undefined;
  for (const expr of extractExpressions(value, location)) {
    const reference = unread.unreadReferenceFor(expr.raw);
    if (!reference) continue;
    // An argument and a data field, never a filesystem path.
    const argument = expr.path;
    const field = reference.fieldPath;
    return new Error(
      `Could not read ${argument}: it holds the stored reference of sensitive field ${field}, whose vault could not be read (${
        describeUnreadReference(reference)
      })`,
    );
  }
  return undefined;
}

/**
 * a run holding more locks than a worker accepts lends none: the step runs
 * without them, and a structural swamp it starts waits on the locks held for
 * the run
 */
function lockHandOffFor(
  context: Pick<MethodContext, "logger">,
): () => Promise<LockHandOff<RemoteLockHolder | undefined>> {
  const source = processLockHolderMarker.remoteHandOff();
  // A re-key replaces nonces one for one, so the count holds for every
  // attempt and the warning is logged once per step.
  const held = source.holder()?.lockIds.length ?? 0;
  if (held > MAX_REMOTE_LOCK_IDS) {
    context.logger
      .warn`Not handing ${held} held per-model locks to the worker: a dispatch carries at most ${MAX_REMOTE_LOCK_IDS}. A structural swamp command started by this step (for example swamp data gc) will wait on them until the lock timeout.`;
    return () =>
      Promise.resolve({ lent: undefined, end: () => Promise.resolve() });
  }
  return () => source.begin();
}

/**
 * a worker supplies the event, so it is checked, not trusted: a line is split
 * on every line separator so it cannot pass for several records, and an
 * unrecognised level falls back to the stream
 */
function logRemoteOutput(logger: Logger, event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  const { type, line, stream, level } = event as Record<string, unknown>;
  if (type !== "output" || typeof line !== "string") return;
  const parts = line.split(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/);
  // A trailing newline is the end of the last line, not an empty one after it.
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  for (const part of parts) {
    const message = escapeLogTemplate(part);
    if (level === "error") {
      logger.error(message);
    } else if (
      level === "warning" || (level !== "info" && stream === "stderr")
    ) {
      logger.warn(message);
    } else {
      logger.info(message);
    }
  }
}

/**
 * attached to the dispatch error as writtenVersions; only the lock's flush
 * reads them to publish what the worker left behind, never shown as the step's
 * artifacts
 */
export function writtenVersionsOf(error: unknown): WrittenVersion[] {
  if (typeof error !== "object" || error === null) return [];
  const versions = (error as { writtenVersions?: unknown }).writtenVersions;
  if (!Array.isArray(versions)) return [];
  return versions.filter((v): v is WrittenVersion =>
    typeof v === "object" && v !== null &&
    typeof v.modelType === "string" && typeof v.modelId === "string" &&
    typeof v.dataName === "string" && typeof v.version === "number" &&
    (v.dataId === undefined || typeof v.dataId === "string")
  );
}

/**
 * the error can come from extension code, so entries without the fields a
 * handle is identified and recorded by are dropped
 */
export function recoveredDataHandles(error: unknown): DataHandle[] {
  if (typeof error !== "object" || error === null) return [];
  const handles = (error as { dataHandles?: unknown }).dataHandles;
  if (!Array.isArray(handles)) return [];
  return handles.filter(isDataHandleShaped);
}

function isDataHandleShaped(value: unknown): value is DataHandle {
  if (typeof value !== "object" || value === null) return false;
  const handle = value as Record<string, unknown>;
  return typeof handle.dataId === "string" &&
    typeof handle.name === "string" &&
    typeof handle.version === "number" &&
    typeof handle.tags === "object" && handle.tags !== null;
}

/**
 * raw method arguments over raw global arguments, sentinels in place of
 * secrets; a global holding an unresolved swamp expression is left out as in
 * execute(), while another system's template text is kept
 */
export function unresolvedArgumentsOf(
  definition: Definition,
  methodName: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definition.globalArguments)) {
    if (containsSwampExpression(value)) continue;
    merged[key] = value;
  }
  return { ...merged, ...definition.getMethodArguments(methodName) };
}

export interface StepArguments {
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
}

/**
 * a string argument holding data whose text differs from the one the provenance
 * was recorded on cannot be placed, so it is refused rather than run as
 * authored text; identity when there is no hook or no data
 */
export function dataSplicePlacer(
  definition: Definition,
  method: MethodDefinition,
  methodName: string,
  provenance: ProvenanceMap,
): (args: StepArguments, platform: string) => StepArguments {
  const hook = method.placeDataSplices;
  const methodArgs = definition.getMethodArguments(methodName);
  const pathOf = (key: string) =>
    Object.hasOwn(methodArgs, key)
      ? methodArgumentPath(methodName, key)
      : keyPath("globalArguments", key);
  const expected = unresolvedArgumentsOf(definition, methodName);
  const holdsData = Object.keys(expected).some((key) =>
    provenance.hasDataAtOrBelow(pathOf(key))
  );
  if (!hook || !holdsData) return (args) => args;
  const rangesOf = (key: string): readonly DataRange[] => {
    const value = expected[key];
    if (typeof value !== "string") return [];
    const path = pathOf(key);
    return provenance.isWholeDataAt(path)
      ? [[0, value.length]]
      : provenance.rangesAt(path);
  };
  return (args, platform) => {
    const { globalArgs, methodArgs: stepMethodArgs } = args;
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(globalArgs)) {
      if (!containsSwampExpression(value)) merged[key] = value;
    }
    Object.assign(merged, stepMethodArgs);
    const changes = hook({
      arguments: merged,
      dataRangesOf: (key) => {
        const ranges = rangesOf(key);
        if (ranges.length > 0 && merged[key] !== expected[key]) {
          throw new UserError(
            `Refused to run ${methodName}: argument ${key} holds text from ` +
              `data, and its text changed after evaluation, so swamp cannot ` +
              `tell which part is data. Pass the value in the env argument ` +
              `and reference the variable instead of splicing it into ` +
              `${key} (shell_data_placement_refused)`,
            "shell_data_placement_refused",
          );
        }
        return ranges;
      },
      platform,
    });
    if (Object.keys(changes).length === 0) return args;
    const placedGlobals = { ...globalArgs };
    const placedMethodArgs = { ...stepMethodArgs };
    for (const [key, value] of Object.entries(changes)) {
      // Written where it was authored; the method argument wins the merge.
      // A global the merge left out (it still holds an expression) is never
      // replaced: the method did not see it, so the change goes beside it.
      if (
        Object.hasOwn(stepMethodArgs, key) || !Object.hasOwn(merged, key)
      ) {
        placedMethodArgs[key] = value;
      } else {
        placedGlobals[key] = value;
      }
    }
    return { globalArgs: placedGlobals, methodArgs: placedMethodArgs };
  };
}

function withStepArguments(
  definition: Definition,
  methodName: string,
  placed: StepArguments,
): Definition {
  const copy = Definition.fromData(definition.toData());
  for (const [key, value] of Object.entries(placed.globalArgs)) {
    copy.setGlobalArgument(key, value);
  }
  copy.setMethodArguments(methodName, placed.methodArgs);
  return copy;
}

export interface StepSecretDelivery {
  vaultSecrets: VaultSecretBag | undefined;
  sentinelArguments: Record<string, unknown> | undefined;
  secrets: SecretOccurrences | undefined;
}

/**
 * refuse then load: a secret at a destination that takes none is refused from
 * sentinels alone, before any vault read; references are then loaded once for
 * this attempt only, so the next attempt loads again
 */
export async function deliverStepSecrets(input: {
  definition: Definition;
  modelDef: ModelDefinition;
  /** Absent when no method is named: only the global arguments are checked. */
  method: MethodDefinition | undefined;
  methodName: string;
  vaultSecrets: VaultSecretBag | undefined;
  secretLoader: SecretLoader | undefined;
  /** False for a remotely placed step, whose shell is the worker's. */
  localPlacement: boolean;
  /**
   * false when this attempt's refusals already ran: serve runs them for a
   * remotely placed step before scheduling and delivery does not repeat them;
   * defaults to true
   */
  refuse?: boolean;
}): Promise<StepSecretDelivery> {
  const { definition, methodName, vaultSecrets } = input;
  const registry = vaultSecrets?.registry;
  const secrets = registry !== undefined && vaultSecrets?.resolvesAny === true
    ? secretOccurrencesOf(registry)
    : undefined;
  const sentinelArguments = secrets !== undefined
    ? unresolvedArgumentsOf(definition, methodName)
    : undefined;
  if (
    input.refuse !== false && registry !== undefined &&
    sentinelArguments !== undefined
  ) {
    refuseSecretDestinations({
      modelDef: input.modelDef,
      method: input.method,
      globalArguments: definition.globalArguments,
      mergedArguments: sentinelArguments,
      registry,
      localPlacement: input.localPlacement,
    });
  }
  const loaded = vaultSecrets?.resolvesAny && input.secretLoader
    ? await input.secretLoader.load(vaultSecrets, {
      globalArguments: definition.globalArguments,
      methodArguments: definition.getMethodArguments(methodName),
    })
    : vaultSecrets;
  return { vaultSecrets: loaded, sentinelArguments, secrets };
}

/**
 * a global takes the value global validation parsed, except leaves holding a
 * sentinel keep their authored form so a secret stays a sentinel for the
 * shell's fill; method arguments stay as authored
 */
function withParsedGlobals(
  merged: Record<string, unknown>,
  definition: Definition,
  methodName: string,
  secrets: SecretOccurrences,
): Record<string, unknown> {
  const holdsSentinel = (value: unknown): boolean => {
    if (typeof value === "string") {
      return secrets.occurrencesIn(value).length > 0;
    }
    if (Array.isArray(value)) return value.some(holdsSentinel);
    if (value !== null && typeof value === "object") {
      return Object.values(value).some(holdsSentinel);
    }
    return false;
  };
  const isPlain = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
  const overlay = (parsed: unknown, authored: unknown): unknown => {
    if (!holdsSentinel(authored)) return parsed;
    if (typeof authored === "string") return authored;
    if (Array.isArray(authored) && Array.isArray(parsed)) {
      return authored.length === parsed.length
        ? parsed.map((item, index) => overlay(item, authored[index]))
        : authored;
    }
    if (isPlain(authored) && isPlain(parsed)) {
      const out: Record<string, unknown> = { ...parsed };
      for (const [key, item] of Object.entries(authored)) {
        if (holdsSentinel(item)) out[key] = overlay(parsed[key], item);
      }
      return out;
    }
    return authored;
  };
  const methodArguments = definition.getMethodArguments(methodName);
  const result: Record<string, unknown> = {};
  const excluded = new Set<string>();
  for (const [key, parsed] of Object.entries(definition.globalArguments)) {
    if (Object.hasOwn(methodArguments, key)) continue;
    if (containsSwampExpression(parsed)) {
      excluded.add(key);
      continue;
    }
    result[key] = overlay(parsed, merged[key]);
  }
  for (const [key, value] of Object.entries(merged)) {
    if (!Object.hasOwn(result, key) && !excluded.has(key)) result[key] = value;
  }
  return result;
}

/**
 * ends in one fix: list the vault in the workflow when its vaults list refused,
 * otherwise the refusal's grant advice, or a grant change when it gives none
 */
function preRunRefusalHint(
  error: VaultAccessDeniedError,
  vaultName: string,
): string {
  const inner = /[.!?]$/.test(error.message)
    ? error.message
    : `${error.message}.`;
  if (error.denial.workflow !== undefined) {
    return `${inner} Add '${vaultName}' to the vaults list of workflow ` +
      `'${error.denial.workflow}', or point the output at a vault that ` +
      `list names.`;
  }
  if (inner.includes(`add a vault:${vaultName} allow grant`)) {
    return `${inner} Or point the output at a vault the principal holds.`;
  }
  return `${inner} Change the principal's vault:${vaultName} grants so it ` +
    `may read and write it, or point the output at a vault the principal ` +
    `holds.`;
}

/**
 * per-method arguments take precedence over merged globals that hold no
 * unresolved expression; raw arguments keep their sentinels for the shell's
 * env-var delivery; parseInput is what the schema received
 */
function parseMethodArguments(
  definition: Definition,
  method: MethodDefinition,
  methodName: string,
  secretBag: VaultSecretBag | undefined,
  redactor: SecretRedactor | undefined,
  unread?: UnreadReferenceLookup,
): {
  rawMethodArgs: Record<string, unknown>;
  resolvedGlobalArgs: Record<string, unknown>;
  filteredRawGlobalArgs: Record<string, unknown>;
  parseInput: Record<string, unknown>;
  parsed: { data: unknown };
} {
  const rawMethodArgs = definition.getMethodArguments(methodName);

  // resolved so extension models receive exact secret values with no escaping
  const resolvedMethodArgs = secretBag?.resolvesAny
    ? secretBag.resolveDeep(rawMethodArgs) as Record<string, unknown>
    : rawMethodArgs;
  const resolvedGlobalArgs = secretBag?.resolvesAny
    ? secretBag.resolveDeep(
      definition.globalArguments,
    ) as Record<string, unknown>
    : definition.globalArguments;

  // globals with unresolved swamp expressions are excluded recursively: a Proxy
  // on context.globalArgs guards them and they could pass validation as plain
  // strings; other systems' template text merges as is
  const filteredGlobalArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resolvedGlobalArgs)) {
    if (containsSwampExpression(value)) {
      continue;
    }
    filteredGlobalArgs[key] = value;
  }
  // a separate filter over raw globals so vault sentinels are preserved for
  // unresolvedMethodArgs
  const filteredRawGlobalArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definition.globalArguments)) {
    if (containsSwampExpression(value)) {
      continue;
    }
    filteredRawGlobalArgs[key] = value;
  }

  // Method arguments are always delivered, so one still holding a stored
  // reference its vault could not read fails here, before the method
  // receives the reference text as if it were the secret.
  const unreadError = unreadReferenceError(
    "methodArguments",
    resolvedMethodArgs,
    unread,
  );
  if (unreadError) throw unreadError;

  const mergedArgs = isRecordSchema(method.arguments)
    ? resolvedMethodArgs
    : { ...filteredGlobalArgs, ...resolvedMethodArgs };
  const methodArgs = coerceMethodArgs(mergedArgs, method.arguments);
  // each issue carries what its failing check received, so a refusal under a
  // transform can register the transformed spelling first; under serve's
  // untrusted policy the parse stops at the first failure per container
  let argsResult: z.ZodSafeParseResult<unknown>;
  try {
    argsResult = method.arguments.safeParse(methodArgs, argumentParseContext());
  } catch (error) {
    throw schemaThrew(error, method.arguments, "Method arguments");
  }

  if (!argsResult.success) {
    throw refusedParse(
      "Method arguments",
      method.arguments,
      methodArgs,
      argsResult.error.issues,
      redactor,
    );
  }
  return {
    rawMethodArgs,
    resolvedGlobalArgs,
    filteredRawGlobalArgs,
    parseInput: methodArgs,
    parsed: argsResult,
  };
}

function redacted(
  text: string,
  redactor: SecretRedactor | undefined,
): string {
  return redactor?.hasSecrets ? redactor.redact(text) : text;
}

/**
 * registers with the run's redactor what the refusal may echo (each issue's
 * input at a sensitive position, transformed spellings, keys the parse
 * introduced) before reporting through it
 */
function refusedParse(
  subject: "Method arguments" | "Global arguments",
  schema: z.ZodTypeAny,
  parseInput: unknown,
  issues: readonly z.ZodIssue[],
  redactor: SecretRedactor | undefined,
): Error {
  if (redactor) {
    for (
      const secret of extractRefusedSensitiveValues(schema, parseInput, issues)
    ) {
      redactor.addSecret(secret);
    }
  }
  const described = formatZodError({
    issues: maskRefusedIssues(schema, parseInput, issues),
  });
  return new Error(
    redacted(`${subject} validation failed: ${described}`, redactor),
  );
}

/**
 * registers what the method will receive at sensitive positions as parsed
 * (transform output, numbers, derived keys), since its error or output can echo
 * them; any shape, as a schema may deliver an array or scalar
 */
function registerDeliveredSecrets(
  schema: z.ZodTypeAny,
  parseInput: unknown,
  delivered: unknown,
  redactor: SecretRedactor | undefined,
): void {
  if (!redactor) return;
  for (
    const secret of extractDeliveredSensitiveValues(
      schema,
      parseInput,
      delivered,
    )
  ) {
    redactor.addSecret(secret);
  }
}

/**
 * lenient: a field holding an unresolved expression is skipped, as is each key
 * in skip; every other field is coerced and checked, with an unknown key
 * refused
 */
function parseGlobalArguments(
  schema: z.ZodTypeAny,
  rawGlobalArgs: Record<string, unknown>,
  redactor: SecretRedactor | undefined,
  skip: ReadonlySet<string> = new Set(),
): { coerced: Record<string, unknown>; data: Record<string, unknown> } {
  const skipKeys = new Set(skip);
  const resolvedGlobalArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawGlobalArgs)) {
    if (skipKeys.has(key)) continue;
    if (containsSwampExpression(value)) {
      skipKeys.add(key);
    } else {
      resolvedGlobalArgs[key] = value;
    }
  }

  const coerced = coerceMethodArgs(resolvedGlobalArgs, schema);
  const shape = getObjectShape(schema);
  if (shape) {
    const unknownKeys = Object.keys(rawGlobalArgs).filter(
      (k) => !Object.hasOwn(shape, k),
    );
    if (unknownKeys.length > 0) {
      const validKeys = Object.keys(shape).join(", ");
      throw new Error(
        `Global arguments validation failed: Unknown argument(s): ${
          unknownKeys.join(", ")
        }. Valid arguments are: ${validKeys || "none"}`,
      );
    }
  }

  // lenient: provided fields are validated, missing ones not required, as
  // direct execution makes ephemeral instances; unresolved fields are skipped
  // (the globalArgs Proxy guards them), resolved ones get defaults
  let result: ReturnType<typeof parseGlobalArgumentsLeniently>;
  try {
    result = parseGlobalArgumentsLeniently(schema, coerced, skipKeys);
  } catch (error) {
    throw schemaThrew(error, schema, "Global arguments");
  }
  if (!result.success) {
    throw refusedParse(
      "Global arguments",
      schema,
      coerced,
      result.issues,
      redactor,
    );
  }
  return { coerced, data: result.data };
}

/**
 * the arguments serve cannot validate before a worker is chosen, since their
 * values are loaded only then
 */
function keysHoldingSentinels(
  args: Record<string, unknown>,
  bag: VaultSecretBag | undefined,
): Set<string> {
  const keys = new Set<string>();
  if (!bag?.resolvesAny) return keys;
  const secrets = secretOccurrencesOf(bag.registry);
  const holds = (value: unknown): boolean => {
    if (typeof value === "string") {
      return secrets.occurrencesIn(value).length > 0;
    }
    if (Array.isArray(value)) return value.some(holds);
    if (value !== null && typeof value === "object") {
      return Object.values(value).some(holds);
    }
    return false;
  };
  for (const [key, value] of Object.entries(args)) {
    if (holds(value)) keys.add(key);
  }
  return keys;
}

export class DefaultMethodExecutionService implements MethodExecutionService {
  private readonly dataOutputValidationService =
    new DataOutputValidationService();

  modelInvocationService?: {
    invoke: (
      options: Parameters<NonNullable<MethodContext["runModel"]>>[0],
      callerContext: MethodContext,
    ) => ReturnType<NonNullable<MethodContext["runModel"]>>;
  };

  workflowGateService?:
    import("./workflow_gate_service.ts").WorkflowGateService;

  execute(
    definition: Definition,
    method: MethodDefinition,
    context: MethodContext,
  ): Promise<MethodResult> {
    return this.#execute(definition, method, context);
  }

  /**
   * this is the run's one parse of the arguments, whose result the method
   * receives
   */
  async #execute(
    definition: Definition,
    method: MethodDefinition,
    context: MethodContext,
    onArgumentsValidated?: () => Promise<void>,
    unread?: UnreadReferenceLookup,
  ): Promise<MethodResult> {
    const {
      rawMethodArgs,
      resolvedGlobalArgs,
      filteredRawGlobalArgs,
      parseInput,
      parsed: argsResult,
    } = parseMethodArguments(
      definition,
      method,
      context.methodName,
      context.vaultSecrets,
      context.redactor,
      unread,
    );
    registerDeliveredSecrets(
      method.arguments,
      parseInput,
      argsResult.data,
      context.redactor,
    );
    if (onArgumentsValidated) await onArgumentsValidated();
    const secretBag = context.vaultSecrets;

    // globalArgs is wrapped in a Proxy that throws a clear error when the
    // method accesses a field with an unresolved swamp expression, so methods
    // that do not need it succeed
    const globalArgsProxy = new Proxy(resolvedGlobalArgs, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && containsSwampExpression(value)) {
          // A stored sensitive-field reference left as text because its
          // vault could not be read is reported as that read's failure.
          const unreadError = unreadReferenceError(
            `globalArguments.${prop}`,
            value,
            unread,
          );
          if (unreadError) throw unreadError;
          const exprs = extractExpressions(value);
          const hasVault = exprs.some((e) =>
            containsVaultExpression(e.celExpression)
          );
          const hasEnv = exprs.some((e) =>
            containsEnvExpression(e.celExpression)
          );
          // A runtime expression left unresolved is most often one that arrived
          // as data content rather than being written in the definition — the
          // runtime pass only resolves author-written references. Say so, rather
          // than sending the user to check a vault that is working fine.
          const hint = hasVault || hasEnv
            ? " (contains a vault.get() or env reference that was not resolved — expression syntax arriving as data content is left as literal text and never evaluated; if you wrote this reference in the definition, check vault configuration and run with --log-level debug for details)"
            : "";
          throw new Error(
            `Unresolved expression in globalArguments.${prop}${hint}: ${
              JSON.stringify(value)
            }`,
          );
        }
        return value;
      },
    });

    const enrichedContext: MethodContext = {
      ...context,
      globalArgs: globalArgsProxy,
      definition: {
        id: definition.id,
        name: definition.name,
        version: definition.version,
        tags: definition.tags,
      },
      // keep sentinels so the shell model resolves secrets via env vars; a run
      // with secrets reads the merge executeWorkflow built before resolving
      // globals, since definition now holds values, else it is built here
      unresolvedMethodArgs:
        (secretBag?.resolvesAny && context.unresolvedMethodArgs) ||
        { ...filteredRawGlobalArgs, ...rawMethodArgs },
    };

    const result = await method.execute(argsResult.data, enrichedContext);

    if (result.dataHandles) {
      const validation = this.dataOutputValidationService.validate(
        result.dataHandles,
      );

      if (!validation.valid) {
        throw new Error(
          `Data output validation failed: ${validation.errors.join("; ")}`,
        );
      }
    }

    return result;
  }

  /**
   * the dispatch result carries only identities; metadata comes from the
   * datastore, which the data plane wrote moments ago
   */
  async #rebuildRemoteHandle(
    context: MethodContext,
    output: RemoteStepResult["outputs"][number],
  ): Promise<DataHandle> {
    const data = await context.dataRepository.findByName(
      context.modelType,
      context.modelId,
      output.name,
      output.version,
    );
    if (data === null) {
      // The write was durable before the dispatch result returned; a miss
      // here means the record vanished out from under us — fail loudly
      // rather than fabricate metadata.
      throw new Error(
        `Remotely-written output '${output.name}' v${output.version} was not found in the datastore`,
      );
    }
    return {
      name: data.name,
      specName: output.specName,
      kind: output.type,
      dataId: createDataId(output.dataId),
      version: data.version,
      size: data.size ?? 0,
      tags: { ...data.tags },
      metadata: {
        contentType: data.contentType,
        lifetime: data.lifetime,
        garbageCollection: data.garbageCollection,
        streaming: data.streaming,
        tags: { ...data.tags },
        ownerDefinition: { ...data.ownerDefinition },
      },
    };
  }

  /**
   * the outputs a failed dispatch wrote become the error's dataHandles, as an
   * in-process failure's do; an output that cannot be rebuilt is skipped so the
   * method's own error is what the step reports
   */
  async #attachRemoteFailureHandles(
    context: MethodContext,
    error: unknown,
  ): Promise<void> {
    const outputs = remoteOutputsOf(error);
    if (outputs.length === 0) return;
    const handles: DataHandle[] = [];
    for (const output of outputs) {
      try {
        handles.push(await this.#rebuildRemoteHandle(context, output));
      } catch (rebuildError) {
        const message = rebuildError instanceof Error
          ? rebuildError.message
          : String(rebuildError);
        context.logger.warn(
          "Could not record output {name} of the failed remote method: {error}",
          { name: output.name, error: redacted(message, context.redactor) },
        );
      }
    }
    if (handles.length > 0) {
      (error as Record<string, unknown>).dataHandles = handles;
    }
  }

  /**
   * arguments travel with sentinels in place plus the reference behind each, no
   * value; a version 6 worker loads them itself, a version 5 worker gets the
   * legacyDelivery frame, built only once a worker is chosen
   */
  async #executeRemotely(
    context: MethodContext,
    executionRequest: import("./execution_envelope.ts").ExecutionRequest,
    modelDef: ModelDefinition,
    currentDefinition: Definition,
    methodName: string,
    delivery: RemoteDelivery,
    placeData: (args: StepArguments, platform: string) => StepArguments,
  ): Promise<RemoteStepResult> {
    const dispatcher = getRemoteStepDispatcher();
    if (dispatcher === null) {
      throw new UserError(
        `Step requests remote placement but no worker dispatcher is active — ` +
          `remote execution requires running under 'swamp serve' with enrolled workers: ` +
          `pass --server <url> to run the workflow on serve`,
      );
    }

    const { globalArgs, methodArgs } = executionRequest;
    const secretBag = context.vaultSecrets;
    // one computation for the entries the step's arguments carry and the
    // references serve admits to the dispatch's loads, so what serve authorizes
    // is what the worker loads
    const referenceBag = secretBag?.resolvesAny
      ? secretBag.referenceEntriesFor({ methodArgs, globalArgs })
      : [];
    const secretReferences: SecretReference[] = [];
    const seen = new Set<string>();
    for (const { reference } of referenceBag) {
      const id = secretReadKey(reference);
      if (seen.has(id)) continue;
      seen.add(id);
      secretReferences.push(reference);
    }
    // a literal a schema marks sensitive is authored text outside the
    // typed-secrets contract; serve's dispatch redactor masks it as the
    // worker's does; text holding a sentinel is not a value
    const redactorSeeds: string[] = [];
    const methodArgSchema = modelDef.methods[methodName]?.arguments;
    for (
      const [schema, args] of [
        [modelDef.globalArguments, globalArgs],
        [methodArgSchema, methodArgs],
      ] as const
    ) {
      if (!schema) continue;
      for (const value of extractSensitiveFieldValues(schema, args)) {
        if (!value.includes(SENTINEL_MARK)) redactorSeeds.push(value);
      }
    }

    return await withSpan("swamp.remote.dispatch", {
      "model.type": context.modelType.normalized,
      "method.name": methodName,
    }, () =>
      dispatcher.executeRemote({
        placement: context.placement!,
        modelDef,
        modelType: context.modelType,
        modelId: context.modelId,
        methodName,
        definitionName: currentDefinition.name,
        definitionTags: currentDefinition.tags,
        definitionMeta: executionRequest.definitionMeta,
        globalArgs,
        methodArgs,
        resourceSpecs: executionRequest.resourceSpecs,
        fileSpecs: executionRequest.fileSpecs,
        traceHeaders: injectTraceContext(),
        runtimeTags: context.runtimeTags,
        tagOverrides: context.tagOverrides,
        dataOutputOverrides: context.dataOutputOverrides,
        workflowName: context.tagOverrides?.workflow,
        workflowRunId: context.tagOverrides?.workflowRunId,
        jobName: context.tagOverrides?.job,
        stepName: context.tagOverrides?.step,
        signal: context.signal,
        dataRepo: context.dataRepository,
        referenceBag: referenceBag.length > 0 ? referenceBag : undefined,
        secretReferences: secretReferences.length > 0
          ? secretReferences
          : undefined,
        redactorSeeds: redactorSeeds.length > 0 ? redactorSeeds : undefined,
        legacyDelivery: delivery.legacyDelivery,
        placeArguments: placeData,
        onArgumentsValidated: reportedOnly(delivery.validated, context),
        beginLockHandOff: lockHandOffFor(context),
        declaredWrites: context.declaredWrites,
        onEvent: (event: RpcStreamEvent) => {
          if (event.kind === "method_event" && "event" in event) {
            logRemoteOutput(context.logger, event.event);
            context.onEvent?.(
              event.event as Parameters<
                NonNullable<
                  MethodContext["onEvent"]
                >
              >[0],
            );
          } else if (
            event.kind === "queued" && "requirement" in event
          ) {
            context.onEvent?.({
              type: "step_queued",
              requirement: event.requirement as string,
            });
          } else if (
            event.kind === "target_disconnected" && "target" in event
          ) {
            context.onEvent?.({
              type: "step_target_disconnected",
              target: event.target as string,
            });
          }
        },
      }));
  }

  /**
   * shared by every path that runs a method body: build the sentinel merge,
   * refuse secret destinations unless done before dispatch, load references
   * once, validate globals, lay them under the merge
   */
  async #prepareDelivery(input: {
    definition: Definition;
    modelDef: ModelDefinition;
    method: MethodDefinition;
    methodName: string;
    context: MethodContext;
    secretLoader: SecretLoader | undefined;
    localPlacement: boolean;
    refuse: boolean;
  }): Promise<PreparedDelivery> {
    const { modelDef, method, methodName } = input;
    let currentDefinition = input.definition;
    let context = input.context;
    const delivery = await deliverStepSecrets({
      definition: currentDefinition,
      modelDef,
      method,
      methodName,
      vaultSecrets: context.vaultSecrets,
      secretLoader: input.secretLoader,
      localPlacement: input.localPlacement,
      refuse: input.refuse,
    });
    const { secrets, sentinelArguments } = delivery;
    if (delivery.vaultSecrets !== context.vaultSecrets) {
      context = { ...context, vaultSecrets: delivery.vaultSecrets };
    }

    // sentinels are resolved into a copy of the definition, never the caller's
    // object, so no value outlives the attempt and a second delivery loads
    // again from sentinels; validators like url() need real values
    const secretBag = context.vaultSecrets;
    if (secretBag?.resolvesAny) {
      currentDefinition = Definition.fromData({
        ...currentDefinition.toData(),
        globalArguments: secretBag.resolveDeep(
          currentDefinition.globalArguments,
        ) as Record<string, unknown>,
      });
    }

    // strip unresolved fields before validation (e.g. delete without
    // create-time inputs) so methods that do not need them proceed; a Proxy on
    // context.globalArgs throws if the method accesses one
    let globalArgsParseInput: Record<string, unknown> = {};
    if (modelDef.globalArguments) {
      const rawGlobalArgs = currentDefinition.globalArguments;
      const globalArgsSchema = modelDef.globalArguments;
      const { coerced: coercedGlobalArgs, data } = parseGlobalArguments(
        globalArgsSchema,
        rawGlobalArgs,
        context.redactor,
      );
      // what the method reads from its context is what this parse made, a
      // transform's output included, so it is registered as a method argument's
      // parse is
      registerDeliveredSecrets(
        globalArgsSchema,
        coercedGlobalArgs,
        data,
        context.redactor,
      );
      // The unresolved fields the parse skipped travel too, as written.
      globalArgsParseInput = { ...rawGlobalArgs, ...coercedGlobalArgs };
      for (const [key, value] of Object.entries(data)) {
        currentDefinition.setGlobalArgument(key, value);
      }
    }

    // mirrors execute()'s merge: per-method args override globals, unresolved
    // expressions filtered; with secrets it is the pre-resolution merge with
    // validation-parsed values under its non-secret globals
    const checkUnresolvedMethodArgs =
      sentinelArguments === undefined || secrets === undefined
        ? unresolvedArgumentsOf(currentDefinition, methodName)
        : withParsedGlobals(
          sentinelArguments,
          currentDefinition,
          methodName,
          secrets,
        );
    if (sentinelArguments !== undefined) {
      // the checks and the method see this merge with sentinels in place as
      // unresolvedMethodArgs; execute() reads it from the context since the
      // definition now holds the values
      context = {
        ...context,
        unresolvedMethodArgs: checkUnresolvedMethodArgs,
      };
    }

    return {
      definition: currentDefinition,
      context,
      globalArgsParseInput,
      checkUnresolvedMethodArgs,
    };
  }

  /**
   * parses a remote step's sentinel-free arguments on serve before scheduling,
   * so a bad one fails at once, not as a queue timeout; sentinel-holding ones
   * are left to delivery; works on a copy of the definition
   */
  async #checkBeforeScheduling(input: {
    definition: Definition;
    context: MethodContext;
    modelDef: ModelDefinition;
    method: MethodDefinition;
    methodName: string;
    options: MethodDeliveryOptions;
    validated: (() => Promise<void>) | undefined;
  }): Promise<void> {
    const { definition, context, modelDef, method, methodName } = input;
    const bag = context.vaultSecrets;
    const rawGlobalArgs = definition.globalArguments;
    const rawMethodArgs = definition.getMethodArguments(methodName);
    const globalSkip = keysHoldingSentinels(rawGlobalArgs, bag);
    // The keys of the method's merge that hold a sentinel, wherever it was
    // authored: a method argument holding none overrides a global one that
    // does.
    const methodSkip = keysHoldingSentinels(
      isRecordSchema(method.arguments)
        ? rawMethodArgs
        : unresolvedArgumentsOf(definition, methodName),
      bag,
    );

    if (globalSkip.size === 0 && methodSkip.size === 0) {
      const prepared = await this.#prepareDelivery({
        definition: Definition.fromData(definition.toData()),
        modelDef,
        method,
        methodName,
        context,
        secretLoader: undefined,
        localPlacement: false,
        // The refusals ran before this check.
        refuse: false,
      });
      const { parseInput, parsed } = parseMethodArguments(
        prepared.definition,
        method,
        methodName,
        prepared.context.vaultSecrets,
        prepared.context.redactor,
        input.options.unreadReferences,
      );
      registerDeliveredSecrets(
        method.arguments,
        parseInput,
        parsed.data,
        prepared.context.redactor,
      );
      await input.validated?.();
      return;
    }

    // fails here as the method's own parse does: a version 6 worker has no
    // record of the run's unread references; this reads expression text, never
    // a value
    const unreadError = unreadReferenceError(
      "methodArguments",
      rawMethodArgs,
      input.options.unreadReferences,
    );
    if (unreadError) throw unreadError;

    let parsedGlobals: Record<string, unknown> = {};
    if (modelDef.globalArguments) {
      parsedGlobals = parseGlobalArguments(
        modelDef.globalArguments,
        rawGlobalArgs,
        context.redactor,
        globalSkip,
      ).data;
    }
    const merged: Record<string, unknown> = isRecordSchema(method.arguments)
      ? {}
      : { ...parsedGlobals };
    for (const [key, value] of Object.entries(rawMethodArgs)) {
      merged[key] = value;
    }
    for (const key of methodSkip) delete merged[key];
    const methodArgs = coerceMethodArgs(merged, method.arguments);
    // With no field of the merge left out, it is the method's whole input.
    let issues: readonly z.ZodIssue[] | undefined;
    try {
      if (methodSkip.size === 0) {
        const parsed = method.arguments.safeParse(
          methodArgs,
          argumentParseContext(),
        );
        if (!parsed.success) issues = parsed.error.issues;
      } else {
        const parsed = parseGlobalArgumentsLeniently(
          method.arguments,
          methodArgs,
          methodSkip,
        );
        if (!parsed.success) issues = parsed.issues;
      }
    } catch (error) {
      throw schemaThrew(error, method.arguments, "Method arguments");
    }
    if (issues !== undefined) {
      throw refusedParse(
        "Method arguments",
        method.arguments,
        methodArgs,
        issues,
        context.redactor,
      );
    }
  }

  /**
   * version 5 worker frame, built once a worker is chosen: loads and resolves
   * references, validates arguments, calls the caller's hook; works on a copy
   * so the dispatched definition keeps its sentinels
   */
  async #legacyDelivery(input: {
    definition: Definition;
    context: MethodContext;
    modelDef: ModelDefinition;
    method: MethodDefinition;
    methodName: string;
    options: MethodDeliveryOptions;
    validated: (() => Promise<void>) | undefined;
  }): Promise<LegacyStepDelivery> {
    const { modelDef, method, methodName, options } = input;
    const prepared = await this.#prepareDelivery({
      definition: Definition.fromData(input.definition.toData()),
      modelDef,
      method,
      methodName,
      context: input.context,
      secretLoader: options.secretLoader,
      localPlacement: false,
      // The refusals ran before the step was scheduled.
      refuse: false,
    });
    const { context, definition } = prepared;
    // the worker parses the shipped arguments itself; the caller's record of
    // the evaluation and the redactor still need the parse here, before
    // anything leaves
    const { parseInput, parsed } = parseMethodArguments(
      definition,
      method,
      methodName,
      context.vaultSecrets,
      context.redactor,
      options.unreadReferences,
    );
    registerDeliveredSecrets(
      method.arguments,
      parseInput,
      parsed.data,
      context.redactor,
    );
    await input.validated?.();

    const unresolvedMethodArgs = definition.getMethodArguments(methodName);
    const secretBag = context.vaultSecrets;
    const methodArgs = secretBag?.resolvesAny
      ? secretBag.resolveDeep(unresolvedMethodArgs) as Record<string, unknown>
      : unresolvedMethodArgs;
    const globalArgs = secretBag?.resolvesAny
      ? secretBag.resolveDeep(
        definition.globalArguments,
      ) as Record<string, unknown>
      : definition.globalArguments;

    // The entries this step delivers: its own, and any the run issued
    // earlier that its unresolved arguments carry. Nothing else of the run
    // reaches the worker.
    const shippedEntries = secretBag?.resolvesAny
      ? secretBag.entriesFor({
        methodArgs: unresolvedMethodArgs,
        globalArgs: definition.globalArguments,
      })
      : [];
    const secretValues = shippedEntries.map((entry) => entry.value);
    if (modelDef.globalArguments) {
      // the worker's redactor gets what a local run registers: delivered
      // secrets less text the parse input held only at plain positions and
      // schema-declared keys, so a region or port is not masked there
      const parseInput = secretBag?.resolvesAny
        ? secretBag.resolveDeep(prepared.globalArgsParseInput) as Record<
          string,
          unknown
        >
        : prepared.globalArgsParseInput;
      secretValues.push(
        ...extractDeliveredSensitiveValues(
          modelDef.globalArguments,
          parseInput,
          globalArgs,
        ),
      );
    }
    const methodArgSchema = modelDef.methods[methodName]?.arguments;
    if (methodArgSchema) {
      secretValues.push(
        ...extractSensitiveFieldValues(methodArgSchema, methodArgs),
      );
    }
    return {
      globalArgs,
      methodArgs,
      secretValues: secretValues.length > 0 ? secretValues : undefined,
      // the worker rebuilds the bag from these and resolves the args itself, so
      // a command/shell step gets its secrets as environment variables there,
      // as it does locally
      ...(shippedEntries.length > 0
        ? { unresolvedMethodArgs, secretBag: shippedEntries }
        : {}),
    };
  }

  /**
   * the refusals ran on serve before dispatch, as for every remotely placed
   * step, so they are not repeated here
   */
  async executeDispatched(
    definition: Definition,
    modelDef: ModelDefinition,
    methodName: string,
    context: MethodContext,
    options: {
      secretLoader: SecretLoader;
      onArgumentsValidated?: () => Promise<void>;
    },
  ): Promise<MethodResult> {
    const method = modelDef.methods[methodName];
    if (!method) {
      throw wordedError(
        wordedText((w) => `Method '${methodName}' not found in ${w.noun}`),
      );
    }
    const prepared = await this.#prepareDelivery({
      definition,
      modelDef,
      method,
      methodName,
      context,
      secretLoader: options.secretLoader,
      localPlacement: false,
      refuse: false,
    });
    return await this.#execute(
      prepared.definition,
      method,
      prepared.context,
      options.onArgumentsValidated,
    );
  }

  executeWorkflow(
    definition: Definition,
    modelDef: ModelDefinition,
    methodName: string,
    context: MethodContext,
    options: MethodDeliveryOptions = {
      argumentProvenance: ProvenanceMap.authored(),
    },
  ): Promise<MethodResult> {
    return withSpan("swamp.model.method", {
      "model.name": definition.name,
      "model.type": context.modelType.normalized,
      "method.name": methodName,
    }, async () => {
      const method = modelDef.methods[methodName];
      if (!method) {
        throw wordedError(
          wordedText((w) => `Method '${methodName}' not found in ${w.noun}`),
        );
      }

      // refuse a reserved tag before anything runs, so the run fails ahead of
      // the method's side effects; the writers refuse the method's own write
      // overrides when it writes
      assertNoReservedRunTags({
        modelType: context.modelType,
        definitionTags: definition.tags,
        specs: outputSpecTags(modelDef),
        tagOverrides: context.tagOverrides,
        runtimeTags: context.runtimeTags,
        dataOutputOverrides: context.dataOutputOverrides,
      });

      const upgradeService = new DefinitionUpgradeService();
      const upgradeResult = upgradeService.upgrade(definition, modelDef);
      let currentDefinition = upgradeResult.definition;

      // warn once per run for a definition whose arguments will not be
      // migrated, derived from the resolved state: upgradable was just
      // migrated, current is fine, invalid already threw
      if (!upgradeResult.upgraded) {
        const upgradeToVersions = (modelDef.upgrades ?? []).map(
          (upgrade) => upgrade.toVersion,
        );
        const staleness = resolveStaleness(
          definition.typeVersion,
          modelDef.version,
          upgradeToVersions,
        );
        if (staleness.state === "stranded") {
          context.logger
            .warn`Definition ${definition.name} was created for ${context.modelType.normalized} version ${staleness.definitionVersion}, but the installed version is ${modelDef.version} and no upgrade entry covers the gap. Its global arguments will not be migrated — the extension must ship a version upgrade.`;
        }
        // An unstamped definition is only worth mentioning when there is an
        // upgrade chain it is declining to run. Without one there is nothing
        // to migrate and the warning would fire on every run of every
        // hand-written definition.
        if (staleness.state === "unknown" && upgradeToVersions.length > 0) {
          context.logger
            .warn`Definition ${definition.name} records no typeVersion, so the upgrade chain for ${context.modelType.normalized} will not run against it. Its global arguments are used as written. Record the version they were authored for — typeVersion: ${modelDef.version} if they are current — to make that explicit.`;
        }
      }

      // the in-memory definition may hold per-process sentinels that are
      // meaningless after exit, so re-read the original from disk, apply the
      // upgrade to that copy and persist it
      if (upgradeResult.upgraded && context.definitionRepository) {
        const originalDefinition = await context.definitionRepository.findById(
          context.modelType,
          definition.id,
        );
        if (originalDefinition) {
          const diskUpgrade = upgradeService.upgrade(
            originalDefinition,
            modelDef,
          );
          const fromPath = context.definitionRepository.getPath(
            context.modelType,
            definition.id,
          );
          await context.definitionRepository.save(
            context.modelType,
            diskUpgrade.definition,
          );
          context.logger
            .info`Upgraded definition ${definition.name} from typeVersion ${diskUpgrade.fromVersion} to ${diskUpgrade.toVersion}`;
          // saving also moves a legacy uuid-named file to its name-based path
          const toPath = context.definitionRepository.getPath(
            context.modelType,
            definition.id,
          );
          if (toPath !== fromPath) {
            context.logger.info`Moved definition file ${
              basename(fromPath)
            } to ${basename(toPath)}`;
          }
        }
      }

      // A remotely placed step runs its method body on a worker; checks and
      // the shell policy belong to the host that runs the body.
      const isRemotePlacement = context.placement &&
        hasPlacement(context.placement);

      // data text is placed for the shell of the host that runs the body: this
      // host's before the merge and checks read the arguments, or the chosen
      // worker's on every dispatch attempt
      const placeData = dataSplicePlacer(
        definition,
        method,
        methodName,
        options.argumentProvenance,
      );
      if (!isRemotePlacement) {
        const authoredArgs: StepArguments = {
          globalArgs: currentDefinition.globalArguments,
          methodArgs: currentDefinition.getMethodArguments(methodName),
        };
        const placed = placeData(authoredArgs, Deno.build.os);
        if (placed !== authoredArgs) {
          currentDefinition = withStepArguments(
            currentDefinition,
            methodName,
            placed,
          );
        }
      }

      // the sentinel merge is built before resolution writes values, so a
      // secret under globalArguments goes through the environment, never the
      // command line; then refusals, then one load per attempt
      const validated = onceOnly(options.onArgumentsValidated);
      let remoteDelivery: RemoteDelivery | undefined;
      let checkUnresolvedMethodArgs: Record<string, unknown> = {};
      if (isRemotePlacement) {
        await deliverStepSecrets({
          definition: currentDefinition,
          modelDef,
          method,
          methodName,
          vaultSecrets: context.vaultSecrets,
          secretLoader: undefined,
          localPlacement: false,
        });
        const dispatched = { definition: currentDefinition, context };
        await this.#checkBeforeScheduling({
          ...dispatched,
          modelDef,
          method,
          methodName,
          options,
          validated,
        });
        let legacy: Promise<LegacyStepDelivery> | undefined;
        remoteDelivery = {
          // Built at most once per attempt, so a re-dispatch to another
          // version 5 worker reuses its one load, as before.
          legacyDelivery: () =>
            legacy ??= this.#legacyDelivery({
              ...dispatched,
              modelDef,
              method,
              methodName,
              options,
              validated,
            }),
          validated,
        };
      } else {
        const prepared = await this.#prepareDelivery({
          definition: currentDefinition,
          modelDef,
          method,
          methodName,
          context,
          secretLoader: options.secretLoader,
          localPlacement: true,
          refuse: true,
        });
        currentDefinition = prepared.definition;
        context = prepared.context;
        checkUnresolvedMethodArgs = prepared.checkUnresolvedMethodArgs;
      }

      const methodKind = inferMethodKind(methodName, method);

      // Skip pre-flight checks for remotely-placed steps — checks run on
      // the orchestrator where worker-local filesystem state is unavailable.
      if (isRemotePlacement && modelDef.checks && isMutatingKind(methodKind)) {
        context.logger.info(
          "Skipping pre-flight checks for remotely-placed step",
        );
      }

      if (modelDef.checks && isMutatingKind(methodKind) && !isRemotePlacement) {
        const defChecks = currentDefinition.checkSelection;
        const requiredCheckNames = new Set(defChecks?.require ?? []);
        const skippedCheckNames = new Set(defChecks?.skip ?? []);

        const applicableChecks = Object.entries(modelDef.checks).filter(
          ([name, check]) => {
            if (skippedCheckNames.has(name)) return false;
            if (check.appliesTo && !check.appliesTo.includes(methodName)) {
              return false;
            }
            if (requiredCheckNames.has(name)) return true;
            if (context.skipAllChecks) return false;
            if (context.skipCheckNames?.includes(name)) return false;
            if (
              context.skipCheckLabels &&
              check.labels?.some((l) => context.skipCheckLabels!.includes(l))
            ) {
              return false;
            }
            return true;
          },
        );

        if (applicableChecks.length > 0) {
          context.logger.info(
            `Running ${applicableChecks.length} pre-flight check(s)`,
          );

          const failures: Array<{ checkName: string; errors: string[] }> = [];

          for (const [checkName, check] of applicableChecks) {
            try {
              const checkResult = await check.execute({
                ...context,
                methodName,
                globalArgs: currentDefinition.globalArguments,
                definition: {
                  id: currentDefinition.id,
                  name: currentDefinition.name,
                  version: currentDefinition.version,
                  tags: currentDefinition.tags,
                },
                unresolvedMethodArgs: checkUnresolvedMethodArgs,
              });
              if (!checkResult || typeof checkResult.pass !== "boolean") {
                failures.push({
                  checkName,
                  errors: [
                    "Check returned invalid result (expected { pass: boolean })",
                  ],
                });
              } else if (!checkResult.pass) {
                failures.push({
                  checkName,
                  errors: checkResult.errors ?? ["Check failed"],
                });
              }
            } catch (error) {
              failures.push({
                checkName,
                errors: [
                  error instanceof Error ? error.message : String(error),
                ],
              });
            }
          }

          if (failures.length > 0) {
            const lines = [
              `Pre-flight checks failed for "${currentDefinition.name}" → ${methodName}:`,
            ];
            for (const failure of failures) {
              lines.push(`  ${failure.checkName}:`);
              for (const err of failure.errors) {
                lines.push(`    - ${err}`);
              }
            }
            throw new UserError(lines.join("\n"));
          }
        }
      }

      if (
        isMutatingKind(methodKind) && modelRequiresVault(modelDef.resources)
      ) {
        // Count user vaults only: serve registers the reserved _token-secrets
        // vault everywhere, and data_writer refuses to store data in it.
        const hasVault = context.vaultService &&
          context.vaultService.getUserVaultNames().length > 0;
        if (!hasVault) {
          throw wordedUserError(
            wordedText((w) =>
              `${w.Noun} "${currentDefinition.name}" has sensitive resource output ` +
              `fields but no vault is configured. Create a vault before ` +
              `running this method: swamp vault create <type> <name>`
            ),
          );
        }
        // a refusal at the put would land after the method's side effects, so
        // every vault its sensitive outputs may land in is decided here; a
        // key-dependent grant outcome is left to the put, which knows the key
        const access = currentVaultAccess();
        if (access && context.vaultService) {
          const targets = sensitiveOutputTargets(
            modelDef.resources,
            context.dataOutputOverrides,
            context.vaultService,
          );
          for (const { vaultName, vaultKey } of targets) {
            for (const action of ["write", "read"] as const) {
              try {
                await access.check(
                  vaultName,
                  action,
                  action === "write" ? "put" : "get",
                  vaultKey,
                  vaultKey === undefined ? { keyUnknown: true } : undefined,
                );
              } catch (error) {
                if (!(error instanceof VaultAccessDeniedError)) throw error;
                throw wordedUserError(
                  wordedText((w) =>
                    `${w.Noun} "${currentDefinition.name}" stores sensitive ` +
                    `output in vault '${vaultName}', which this run may not ` +
                    `${action}: ${preRunRefusalHint(error, vaultName)}`
                  ),
                  "vault_access_denied",
                );
              }
            }
          }
        }
      }

      // block only when all declared resource data is deleted, so old
      // historical entries cause no false positives; reads stop at the first
      // live resource, so cost does not grow with data
      if (methodKind === "read" || methodKind === "update") {
        const resources = modelDef.resources ?? {};
        if (Object.keys(resources).length > 0) {
          const specNames = new Set(Object.keys(resources));
          let deleted: Data | undefined;
          let live = false;
          for await (
            const data of context.dataRepository.iterateForModel(
              context.modelType,
              context.modelId,
            )
          ) {
            if (!isDeclaredResourceData(data, specNames)) continue;
            if (!data.isDeleted) {
              live = true;
              break;
            }
            deleted ??= data;
          }
          if (!live && deleted !== undefined) {
            let deletedAt = "unknown";
            try {
              const content = await context.dataRepository.getContent(
                context.modelType,
                context.modelId,
                deleted.name,
              );
              if (content) {
                const marker = JSON.parse(
                  new TextDecoder().decode(content),
                );
                if (marker.deletedAt) {
                  deletedAt = marker.deletedAt;
                }
              }
            } catch {
              // Use default "unknown" timestamp
            }
            throw new UserError(
              `Resource '${deleted.name}' was deleted at ${deletedAt} — run a 'create' method to re-create it first`,
            );
          }
        }
      }

      // a remote step's definition holds per-run sentinels, so hash it with
      // each written as its reference text; the hash stays stable and holds no
      // value
      const definitionHash = await (isRemotePlacement
        ? withReferenceText(currentDefinition, context.vaultSecrets)
        : currentDefinition).computeHash();

      const executionRequest:
        import("./execution_envelope.ts").ExecutionRequest = {
          protocolVersion: 1,
          modelType: context.modelType.normalized,
          modelId: context.modelId,
          methodName,
          globalArgs: currentDefinition.globalArguments,
          methodArgs: currentDefinition.getMethodArguments(methodName),
          definitionMeta: {
            id: currentDefinition.id,
            name: currentDefinition.name,
            version: currentDefinition.version,
            tags: currentDefinition.tags,
          },
          resourceSpecs: modelDef.resources
            ? Object.fromEntries(
              Object.entries(modelDef.resources).map(([name, spec]) => [
                name,
                { description: spec.description },
              ]),
            )
            : undefined,
          fileSpecs: modelDef.files
            ? Object.fromEntries(
              Object.entries(modelDef.files).map(([name, spec]) => [
                name,
                { contentType: spec.contentType },
              ]),
            )
            : undefined,
          traceHeaders: injectTraceContext(),
        };

      // Pre-create ModelOutput before execution so its ID is available
      // as parentOutputId for nested runModel() invocations.
      let output: ModelOutput | undefined;
      if (context.outputRepository) {
        const provenance = context._invocationProvenance
          ? {
            definitionHash,
            modelVersion: modelDef.version,
            triggeredBy: context._invocationProvenance.triggeredBy,
            parentOutputId: context._invocationProvenance.parentOutputId,
            callerExtension: context._invocationProvenance.callerExtension,
            bundleFingerprint: modelDef.sourceFingerprint,
          }
          : {
            definitionHash,
            modelVersion: modelDef.version,
            triggeredBy: "manual" as const,
            bundleFingerprint: modelDef.sourceFingerprint,
          };
        output = ModelOutput.create({
          definitionId: currentDefinition.id,
          methodName,
          status: "running",
          provenance,
        });
        context._currentOutputId = output.id;
        await context.outputRepository.save(modelDef.type, methodName, output);
      }

      let currentHandles: DataHandle[];
      let result: MethodResult;

      if (method.rollbackOnFailure && isRemotePlacement) {
        throw new Error(
          `Method '${methodName}' declares rollbackOnFailure but has remote ` +
            `placement — deferred-latest writes are not yet supported for ` +
            `remote execution. Remove rollbackOnFailure or run locally.`,
        );
      }

      try {
        if (isRemotePlacement) {
          // remote placement runs only the method body on a worker; output
          // records stay at the orchestrator, and pre-flight checks are skipped
          // because they cannot see worker-local state
          let remoteResult: RemoteStepResult;
          try {
            remoteResult = await this.#executeRemotely(
              context,
              executionRequest,
              modelDef,
              currentDefinition,
              methodName,
              remoteDelivery!,
              placeData,
            );
          } catch (error) {
            await this.#attachRemoteFailureHandles(context, error);
            throw error;
          }
          // rebuild full handles from the persisted records: downstream
          // consumers read metadata like ownerDefinition, which the wire-thin
          // dispatch outputs do not carry
          currentHandles = await Promise.all(
            remoteResult.outputs.map((output) =>
              this.#rebuildRemoteHandle(context, output)
            ),
          );
          result = {
            dataHandles: currentHandles,
            executor: remoteResult.workerName,
          };
        } else if (
          isRemoteOnlyMode() &&
          !modelRegistry.isInternal(context.modelType)
        ) {
          throw wordedUserError(
            wordedText((w) =>
              `Step '${methodName}' on ${w.noun} '${context.modelType.normalized}' ` +
              `has no placement but the server is running in remote-only mode. ` +
              `Add a placement block (target, labels, or platform) to the ` +
              `workflow step, job, or workflow so it can be dispatched to a ` +
              `remote worker.`
            ),
          );
        } else {
          const inProcessExecutor = new InProcessExecutor(
            {
              // the run's one parse of the arguments happens in #execute, which
              // calls the caller's hook before the method body
              execute: (definition, method, context) =>
                this.#execute(
                  definition,
                  method,
                  context,
                  options.onArgumentsValidated,
                  options.unreadReferences,
                ),
            },
            currentDefinition,
            method,
            modelDef,
            context,
            methodName,
            this.modelInvocationService,
            this.workflowGateService,
          );
          const executionResult = await withSpan("swamp.method.execute", {
            "model.type": context.modelType.normalized,
          }, () =>
            inProcessExecutor.execute(executionRequest));

          if (executionResult.outputs.some((o) => o.kind === "pending")) {
            throw new Error(
              "In-process execution unexpectedly produced pending outputs — " +
                "this is a bug; in-process execution should only produce " +
                "persisted outputs",
            );
          }
          // process outputs first, even on error: data may be written before
          // the method throws, and handles must survive the error path
          currentHandles = collectPersistedHandles(executionResult.outputs);

          if (executionResult.status === "error") {
            // a coded UserError comes back as one, so a failed workflow step
            // records its code
            const message = executionResult.error ?? "Method execution failed";
            const err = markErrorPaths(
              executionResult.errorCode !== undefined
                ? new UserError(message, executionResult.errorCode)
                : new Error(message),
              executionResult.errorPaths ?? [],
            );
            (err as unknown as Record<string, unknown>).dataHandles =
              currentHandles;
            throw err;
          }

          result = {
            dataHandles: currentHandles,
            executor: "loopback",
          };
        }
      } catch (error) {
        if (output && context.outputRepository) {
          // the record holds the error with every delivered value and, in a
          // typed run, every sentinel, masked
          output.markFailed(executionErrorFrom(error, context.redactor));
          await context.outputRepository.save(
            modelDef.type,
            methodName,
            output,
          );
        }
        throw error;
      }

      const storedArtifacts: DataArtifactRef[] = currentHandles.map((h) => ({
        dataId: h.dataId,
        name: h.name,
        version: h.version,
        tags: h.tags,
      }));

      if (output && context.outputRepository) {
        for (const artifact of storedArtifacts) {
          output.addDataArtifact(artifact);
        }
        output.markSucceeded();
        await context.outputRepository.save(modelDef.type, methodName, output);
      }

      // mark only declared resource data; markers keep the last known active
      // state so data.latest() still resolves attributes after deletion,
      // keeping workflow re-runs idempotent
      if (methodKind === "delete") {
        const resources = modelDef.resources ?? {};
        if (Object.keys(resources).length > 0) {
          const existingData = await context.dataRepository.findAllForModel(
            context.modelType,
            context.modelId,
          );
          const resourceData = filterDeclaredResourceData(
            existingData,
            resources,
          );
          for (const data of resourceData) {
            if (!data.isDeleted) {
              let lastKnownState: Record<string, unknown> = {};
              if (data.contentType === "application/json") {
                try {
                  const activeContent = await context.dataRepository.getContent(
                    context.modelType,
                    context.modelId,
                    data.name,
                  );
                  if (activeContent) {
                    lastKnownState = JSON.parse(
                      new TextDecoder().decode(activeContent),
                    ) as Record<string, unknown>;
                  }
                } catch {
                  // Not valid JSON or read error — proceed with empty state
                }
              }

              const marker = data.withDeletionMarker({
                version: data.version + 1,
              });
              const markerContent = new TextEncoder().encode(JSON.stringify({
                ...lastKnownState,
                deletedAt: new Date().toISOString(),
                deletedByMethod: methodName,
              }));
              await context.dataRepository.save(
                context.modelType,
                context.modelId,
                marker,
                markerContent,
              );

              currentHandles.push({
                name: data.name,
                specName: data.tags["specName"] ?? data.name,
                kind: "resource",
                dataId: marker.id,
                version: marker.version,
                size: markerContent.byteLength,
                tags: { ...marker.tags },
                metadata: {
                  contentType: marker.contentType,
                  lifetime: marker.lifetime,
                  garbageCollection: marker.garbageCollection,
                  streaming: marker.streaming,
                  tags: { ...marker.tags },
                  ownerDefinition: marker.ownerDefinition,
                  lifecycle: marker.lifecycle,
                },
              });
            }
          }
        }
      }

      return {
        ...result,
        dataHandles: currentHandles,
      };
    });
  }
}
