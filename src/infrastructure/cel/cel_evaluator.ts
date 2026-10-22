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

import { Environment, Optional } from "cel-js";
import { getLogger } from "@logtape/logtape";
import { InvalidExpressionError } from "../../domain/expressions/errors.ts";
import {
  extractExpressions,
  transformHyphenatedModelRefs,
} from "../../domain/expressions/expression_parser.ts";
import { maskLiteralCalls } from "../../domain/expressions/cel_string_lexer.ts";
import {
  literal,
  LITERAL_FUNCTION_SIGNATURE,
} from "../../domain/expressions/cel_grammar.ts";
import {
  analyzeVaultCalls,
  type VaultCallAnalysis,
} from "../../domain/expressions/vault_call_syntax.ts";
import {
  assertDirectVaultCalls,
  CelVaultNamespace,
  prepareCheckedVaultCalls,
  type VaultEvaluationScope,
} from "./cel_vault_namespace.ts";
import { composeDataName } from "../../domain/data/mod.ts";
import {
  SECRET_DESTINATION_REFUSED,
  SECRET_OPERATION_UNSUPPORTED,
  SecretRefusedError,
} from "../../domain/expressions/errors.ts";
import type { DataReadOptions } from "../../domain/expressions/model_resolver.ts";
import type { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import {
  INTERNAL_FUNCTION_SIGNATURES,
  SWAMP_NAMESPACE_TYPES,
  TYPED_VAULT_FUNCTION_SIGNATURES,
  TYPED_VAULT_NAMESPACE_TYPES,
} from "./cel_js_secret_refusal_inventory.ts";
import { hasContainerComparison } from "./container_comparison.ts";
import {
  detachForDestination,
  isPlainMap,
  readResult,
  refuseUnboundSecrets,
  SecretBoundary,
} from "./secret_boundary.ts";
import {
  currentFaultScope,
  type FaultScope,
  refuse,
  runInFaultScope,
  SecretRefusal,
  sensitiveReferenceKey,
} from "./secret_fault_context.ts";
import {
  registerAllowedSet,
  registerSecretRefusals,
  registerSecretType,
} from "./secret_registrations.ts";
import {
  adaptDataResult,
  adaptModelMethodResult,
  type DataAccessor,
  modelMapView,
  stepsView,
  synchronousSensitiveReferences,
} from "./sensitive_record_adapter.ts";

/**
 * Result of expression validation.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Fields of `DataRecord` — the shape `data.latest()` and `data.version()`
 * resolve to. See {@link CelEvaluator.explainMissedLookups} for why these are
 * written out rather than derived.
 */
const DATA_RECORD_FIELDS = new Set([
  "attributes",
  "content",
  "contentType",
  "createdAt",
  "dataType",
  "garbageCollection",
  "id",
  "isLatest",
  "jobName",
  "lifecycle",
  "lifetime",
  "modelId",
  "modelName",
  "modelType",
  "name",
  "namespace",
  "ownerRef",
  "ownerType",
  "path",
  "size",
  "source",
  "specName",
  "stepName",
  "streaming",
  "tags",
  "version",
  "workflowName",
  "workflowRunId",
]);

function unwrapOptional(value: unknown): unknown {
  if (value instanceof Optional) {
    return value.hasValue() ? value.value() : null;
  }
  return value;
}

/** The shape of cel-js's `uint` value. */
interface CelUnsignedInt {
  readonly value: bigint;
}

/** The shape of cel-js's `google.protobuf.Duration` value. */
interface CelDuration {
  readonly seconds: bigint;
  readonly nanos: number;
}

// cel-js does not export its uint and duration classes, so take their
// constructors from a value of each.
const celTypeProbe = new Environment();
const UnsignedIntType = (celTypeProbe.evaluate("1u") as object).constructor;
const DurationType = (celTypeProbe.evaluate("duration('0s')") as object)
  .constructor;

const NANOS_PER_SECOND = 1_000_000_000n;

type DurationConstructor = new (seconds: bigint, nanos: number) => CelDuration;

function durationNanos(duration: CelDuration): bigint {
  return duration.seconds * NANOS_PER_SECOND + BigInt(duration.nanos);
}

/**
 * Builds a duration from its total in nanoseconds, with `seconds` and `nanos`
 * sharing the sign of the total — the form cel-js gives a parsed duration.
 */
function durationFromNanos(total: bigint): CelDuration {
  return new (DurationType as DurationConstructor)(
    total / NANOS_PER_SECOND,
    Number(total % NANOS_PER_SECOND),
  );
}

// cel-js 7.6.1 (and 8.0.0) adds and subtracts durations assuming `nanos` is
// never negative, but a negative duration it parses keeps a negative `nanos`,
// so `duration('-1.5s') + duration('-0.6s')` came out as -3.1s. Its `==`
// compares the stored fields, so it also needs every duration in one form.
// Replace both methods on the shared prototype with versions that work from
// the total; this file is loaded before any CEL is evaluated, so every
// Environment in the process gets them (swamp-club#3714). Remove once cel-js
// ships a fix; cel_js_duration_pin_test.ts pins what this relies on.
if (
  typeof DurationType.prototype.addDuration === "function" &&
  typeof DurationType.prototype.subtractDuration === "function"
) {
  Object.assign(DurationType.prototype, {
    addDuration(this: CelDuration, other: CelDuration): CelDuration {
      return durationFromNanos(durationNanos(this) + durationNanos(other));
    },
    subtractDuration(this: CelDuration, other: CelDuration): CelDuration {
      return durationFromNanos(durationNanos(this) - durationNanos(other));
    },
  });
}

/**
 * Formats a duration in CEL's string form (`90s`, `1.5s`, `-1.5s`). cel-js's
 * own `toString()` misprints negative durations, so this works from the total.
 */
function formatDuration(duration: CelDuration): string {
  const total = durationNanos(duration);
  const sign = total < 0n ? "-" : "";
  const magnitude = total < 0n ? -total : total;
  const seconds = magnitude / NANOS_PER_SECOND;
  const nanos = magnitude % NANOS_PER_SECOND;
  if (nanos === 0n) return `${sign}${seconds}s`;
  const fraction = nanos.toString().padStart(9, "0").replace(/0+$/, "");
  return `${sign}${seconds}.${fraction}s`;
}

function coerceInt(value: bigint): number | bigint {
  if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
    return Number(value);
  }
  return value;
}

/**
 * Recursively converts CEL result values to the plain values the rest of
 * the codebase expects, following CEL's JSON mapping:
 * - int and uint become numbers; values outside Number.MAX_SAFE_INTEGER are
 *   left as bigint to avoid silent precision loss
 * - timestamp becomes its ISO 8601 string, duration its CEL string (`90s`)
 *   and bytes a base64 string
 * - optionals unwrap to their value, or null when empty
 */
export function coerceBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    return coerceInt(value);
  }
  if (value instanceof Optional) {
    return coerceBigInts(value.hasValue() ? value.value() : null);
  }
  if (Array.isArray(value)) {
    return value.map(coerceBigInts);
  }
  if (value instanceof Date) {
    return value.toJSON();
  }
  if (value instanceof DurationType) {
    return formatDuration(value as CelDuration);
  }
  if (value instanceof UnsignedIntType) {
    return coerceInt((value as CelUnsignedInt).value);
  }
  if (value instanceof Uint8Array) {
    return value.toBase64();
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(result, k, {
        value: coerceBigInts(v),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
}

/**
 * Converts the CEL ints in a value bound for a delegate to numbers, as
 * {@link coerceBigInts} does for results, so the value serializes as JSON.
 * Unlike coerceBigInts it walks only arrays and plain maps and leaves every
 * other object as it is, so a timestamp in the inputs of model.method
 * reaches the method as a Date and serializes as its ISO string.
 */
function coerceBigIntsForDelegate(value: unknown): unknown {
  if (typeof value === "bigint") return coerceBigInts(value);
  if (Array.isArray(value)) return value.map(coerceBigIntsForDelegate);
  if (isPlainMap(value)) {
    const result: Record<string, unknown> = Object.create(
      Object.getPrototypeOf(value),
    );
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(result, k, {
        value: coerceBigIntsForDelegate(v),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
}

/**
 * Wrapper class for file namespace context objects.
 * cel-js requires a registered type (via constructor matching) so it doesn't
 * try to infer the type as a map and choke on function-valued properties.
 */
export class CelFileNamespace {
  private readonly delegate: Record<string, unknown>;

  constructor(delegate: Record<string, unknown>) {
    this.delegate = delegate;
  }

  contents(modelName: string, specName: string): unknown {
    const fn = this.delegate["contents"];
    if (typeof fn === "function") {
      return (fn as (m: string, s: string) => unknown)(modelName, specName);
    }
    return null;
  }
}

/**
 * Wrapper class for workers namespace context objects.
 * Provides helpers for querying workers eligible for dispatch.
 */
export class CelWorkersNamespace {
  private readonly delegate: Record<string, unknown>;

  constructor(delegate: Record<string, unknown>) {
    this.delegate = delegate;
  }

  connected(): unknown {
    const fn = this.delegate["connected"];
    if (typeof fn === "function") {
      return (fn as () => unknown)();
    }
    return [];
  }
}

/**
 * A missed `data.latest()`/`data.version()` lookup whose data name may have
 * been an output spec name. Vary forms are never recorded: their data name is
 * composed, so it cannot be a spec name.
 */
interface SpecNameCandidate {
  accessor: "latest" | "version";
  modelName: string;
  dataName: string;
}

/** Spec instance names shown in the hint before the rest are counted. */
const MAX_LISTED_SPEC_INSTANCES = 3;

/**
 * Renders the hint for a lookup that passed a spec name where a data name was
 * expected. `names` are the data names written under that spec, newest first.
 */
function describeSpecInstances(
  accessor: "latest" | "version",
  modelName: string,
  specName: string,
  names: string[],
): string {
  const listed = names.slice(0, MAX_LISTED_SPEC_INSTANCES)
    .map((n) => `"${n}"`).join(", ");
  const rest = names.length - MAX_LISTED_SPEC_INSTANCES;
  const records = names.length === 1 ? "1 record" : `${names.length} records`;
  const order = names.length > 1 ? " (newest first)" : "";
  const more = rest > 0 ? `, and ${rest} more` : "";
  return `"${specName}" is an output spec name, but data.${accessor}() takes ` +
    `a data name. ${modelName} has ${records} of spec "${specName}": ` +
    `${listed}${order}${more}. Pass one of those names to ` +
    `data.${accessor}(), or use data.findBySpec("${modelName}", ` +
    `"${specName}") to get every record of that spec.`;
}

/**
 * Wrapper class for data namespace context objects.
 */
export class CelDataNamespace {
  private readonly delegate: Record<string, unknown>;
  /**
   * Lookups that resolved to no record, in call order. A null lookup is a
   * supported result — guards use it as a presence test and `.?attributes`
   * selects through it — so the miss is recorded rather than thrown, and
   * {@link CelEvaluator} uses it to explain the "No such key" that a
   * non-optional select on the missing record raises.
   */
  readonly missedLookups: string[] = [];
  private readonly specNameCandidates: SpecNameCandidate[] = [];

  constructor(delegate: Record<string, unknown>) {
    this.delegate = delegate;
  }

  /** Drops recorded misses so they cannot leak into a later evaluation. */
  clearMissedLookups(): void {
    this.missedLookups.length = 0;
    this.specNameCandidates.length = 0;
  }

  /**
   * The reader's own namespace, as the delegate carries it: the namespace
   * whose records' tagged fields are this repository's to read. Empty, the
   * solo default a context built without a repository uses, when the
   * delegate carries none.
   */
  get namespace(): string {
    const namespace = this.delegate["namespace"];
    return typeof namespace === "string" ? namespace : "";
  }

  /**
   * Records `call` when the lookup resolved to no record. Delegates return
   * either a value or a Promise; the Promise arm returns the derived promise
   * so the miss is recorded before cel-js selects a field off the result.
   */
  private recordMiss(
    result: unknown,
    call: string,
    candidate?: SpecNameCandidate,
  ): unknown {
    const miss = () => {
      this.missedLookups.push(call);
      if (candidate) this.specNameCandidates.push(candidate);
    };
    if (result instanceof Promise) {
      return result.then((value) => {
        if (value === null || value === undefined) miss();
        return value;
      });
    }
    if (result === null || result === undefined) miss();
    return result;
  }

  /**
   * Explains missed lookups whose data name is really an output spec name:
   * `data.latest()` and `data.version()` take the data (instance) name a
   * model wrote, which is often not its spec name — a model can write spec
   * `summary` as `sync-<timestamp>`. Returns one paragraph per such lookup,
   * naming the data names written under that spec. Only called on the error
   * path, so the lookup costs nothing when an expression succeeds.
   */
  explainSpecNameMisses(): string[] {
    const fn = this.delegate["specInstanceNames"];
    if (typeof fn !== "function") return [];
    const explained = new Set<string>();
    const paragraphs: string[] = [];
    for (const { accessor, modelName, dataName } of this.specNameCandidates) {
      const key = `${accessor}\0${modelName}\0${dataName}`;
      if (explained.has(key)) continue;
      explained.add(key);
      let names: string[];
      try {
        names = (fn as (m: string, s: string) => string[])(
          modelName,
          dataName,
        );
      } catch {
        // The hint is best-effort: never let it replace the original error.
        continue;
      }
      if (!Array.isArray(names) || names.length === 0) continue;
      paragraphs.push(
        describeSpecInstances(accessor, modelName, dataName, names),
      );
    }
    return paragraphs;
  }

  latest(
    modelName: string,
    dataName: string,
    varyValues?: unknown[],
    options?: DataReadOptions,
  ): unknown {
    const fn = this.delegate["latest"];
    if (typeof fn === "function") {
      const resolvedName = varyValues && varyValues.length > 0
        ? composeDataName(dataName, varyValues.map((v) => String(v)))
        : dataName;
      return this.recordMiss(
        (fn as (m: string, d: string, o?: DataReadOptions) => unknown)(
          modelName,
          resolvedName,
          options,
        ),
        `data.latest("${modelName}", "${resolvedName}")`,
        resolvedName === dataName
          ? { accessor: "latest", modelName, dataName }
          : undefined,
      );
    }
    return null;
  }

  version(
    modelName: string,
    dataName: string,
    versionOrVary: unknown,
    version?: unknown,
  ): unknown {
    const fn = this.delegate["version"];
    if (typeof fn === "function") {
      // 4-arg form: version(model, name, varyValues[], version)
      if (Array.isArray(versionOrVary)) {
        const resolvedName = versionOrVary.length > 0
          ? composeDataName(
            dataName,
            versionOrVary.map((v) => String(v)),
          )
          : dataName;
        return this.recordMiss(
          (fn as (m: string, d: string, v: number) => unknown)(
            modelName,
            resolvedName,
            Number(version),
          ),
          `data.version("${modelName}", "${resolvedName}", ${Number(version)})`,
          resolvedName === dataName
            ? { accessor: "version", modelName, dataName }
            : undefined,
        );
      }
      // 3-arg form: version(model, name, version)
      return this.recordMiss(
        (fn as (m: string, d: string, v: number) => unknown)(
          modelName,
          dataName,
          Number(versionOrVary),
        ),
        `data.version("${modelName}", "${dataName}", ${Number(versionOrVary)})`,
        { accessor: "version", modelName, dataName },
      );
    }
    return null;
  }

  listVersions(
    modelName: string,
    dataName: string,
    varyValues?: unknown[],
  ): unknown {
    const fn = this.delegate["listVersions"];
    if (typeof fn === "function") {
      const resolvedName = varyValues && varyValues.length > 0
        ? composeDataName(dataName, varyValues.map((v) => String(v)))
        : dataName;
      return (fn as (m: string, d: string) => unknown)(
        modelName,
        resolvedName,
      );
    }
    return [];
  }

  findByTag(tagKey: string, tagValue: string): unknown {
    const fn = this.delegate["findByTag"];
    if (typeof fn === "function") {
      return (fn as (k: string, v: string) => unknown)(tagKey, tagValue);
    }
    return [];
  }

  findBySpec(modelName: string, specName: string): unknown {
    const fn = this.delegate["findBySpec"];
    if (typeof fn === "function") {
      return (fn as (m: string, s: string) => unknown)(modelName, specName);
    }
    return [];
  }

  query(predicate: string, select?: string): unknown {
    const fn = this.delegate["query"];
    if (typeof fn === "function") {
      return (fn as (pred: string, sel?: string) => unknown)(
        predicate,
        select,
      );
    }
    return [];
  }
}

/**
 * Wrapper class for model namespace context objects.
 * Provides model.method() for invoking model methods from CEL expressions
 * (e.g., guard expressions).
 */
export class CelModelNamespace {
  private readonly delegate: Record<string, unknown>;

  constructor(delegate: Record<string, unknown>) {
    this.delegate = delegate;
  }

  method(
    modelName: string,
    methodName: string,
    inputs?: Record<string, unknown>,
  ): unknown {
    const fn = this.delegate["method"];
    if (typeof fn === "function") {
      return (
        fn as (
          m: string,
          n: string,
          i?: Record<string, unknown>,
        ) => unknown
      )(modelName, methodName, inputs);
    }
    return null;
  }
}

/**
 * Builds a fresh, isolated cel-js `Environment` with swamp's baseline
 * registrations for extension use.
 *
 * Options: `{ unlistedVariablesAreDyn: true }` so callers can pass arbitrary
 * context maps without pre-registering every variable.
 * `{ homogeneousAggregateLiterals: false }` so map/list literals can contain
 * mixed value types (e.g. dyn context lookups alongside string literals).
 *
 * Registrations: bigint/double arithmetic operator overloads only. The
 * returned Environment does NOT carry swamp's internal namespace types
 * (`CelFileNamespace`/`CelDataNamespace`) — those are private to swamp's
 * own expression surface. Callers may freely register their own
 * functions, types, and operators on the returned Environment.
 */
function registerArithmeticOverloads(env: Environment): void {
  env.registerOperator(
    "double + int",
    (a: number, b: bigint) => a + Number(b),
  );
  env.registerOperator(
    "int + double",
    (a: bigint, b: number) => Number(a) + b,
  );
  env.registerOperator(
    "double - int",
    (a: number, b: bigint) => a - Number(b),
  );
  env.registerOperator(
    "int - double",
    (a: bigint, b: number) => Number(a) - b,
  );
  env.registerOperator(
    "double * int",
    (a: number, b: bigint) => a * Number(b),
  );
  env.registerOperator(
    "int * double",
    (a: bigint, b: number) => Number(a) * b,
  );
  env.registerOperator(
    "double / int",
    (a: number, b: bigint) => a / Number(b),
  );
  env.registerOperator(
    "int / double",
    (a: bigint, b: number) => Number(a) / b,
  );
  env.registerOperator(
    "double % int",
    (a: number, b: bigint) => a % Number(b),
  );
  env.registerOperator(
    "int % double",
    (a: bigint, b: number) => Number(a) % b,
  );
}

export { registerArithmeticOverloads };

export function createExtensionCelEnvironment(): Environment {
  const env = new Environment({
    unlistedVariablesAreDyn: true,
    enableOptionalTypes: true,
    homogeneousAggregateLiterals: false,
  });
  registerArithmeticOverloads(env);
  return env;
}

/**
 * Awaits the context's data-namespace `prepare` for one expression, when the
 * context has one. Async evaluation calls it before every expression; a
 * synchronous evaluation pass calls it for each expression it is about to
 * evaluate, since it cannot wait on what the expression reads
 * (swamp-club#3179).
 */
export async function prepareExpressionContext(
  expression: string,
  context: Record<string, unknown>,
): Promise<void> {
  const data = context.data;
  if (
    typeof data === "object" && data !== null &&
    "prepare" in data && typeof data.prepare === "function"
  ) {
    await data.prepare(expression);
  }
}

/**
 * {@link prepareExpressionContext} for every `${{ }}` expression in
 * `content`, before a synchronous pass evaluates them.
 */
export async function prepareExpressionsIn(
  content: unknown,
  context: Record<string, unknown>,
): Promise<void> {
  const seen = new Set<string>();
  for (const expr of extractExpressions(content)) {
    if (seen.has(expr.celExpression)) continue;
    seen.add(expr.celExpression);
    await prepareExpressionContext(expr.celExpression, context);
  }
}

/**
 * The internal environment's options. Internal: only tests set them until
 * typed-secrets Phase 4 turns the path on for every entry point
 * (design/enablers/typed-secrets.md Section 10.3).
 */
export interface CelEvaluatorOptions {
  /**
   * The `Secret` value: its type, the allowed set and every refusal the
   * inventory yields, the fault context, the container rule and the boundary
   * conversion. Off, the environment is exactly what it was before them: a
   * custom binary overload marks every use of its operator maybe-async
   * (fact 4), so nothing is registered.
   */
  readonly typedSecrets?: boolean;
}

/** What one evaluation runs with. */
export interface EvaluationScope {
  /**
   * The run's issuing bag (a delivery view cannot issue). With typed
   * secrets on, sentinels it issued read as a `Secret`, and a `Secret`
   * result leaves as a sentinel issued into it.
   */
  readonly secretBag?: VaultSecretBag;
  /** Required for direct typed vault calls; checks use the run's services. */
  readonly vault?: VaultEvaluationScope;
  /**
   * What becomes of a `Secret` in the result. `release`, the default, issues
   * its sentinel into the bag. `refuse` is the predicate destination of a
   * guard or assert (design/enablers/typed-secrets.md Section 7.1): a result
   * that holds a secret anywhere is refused with `secret_destination_refused`
   * before anything reads it, while the bindings still read sentinels as
   * Secrets, so a comparison to null decides as it always did.
   */
  readonly secretResult?: "release" | "refuse";
  /**
   * The sensitive-field references a synchronous evaluation may read,
   * authorized by {@link CelEvaluator.prepareSynchronousReads} under the
   * run's vault access and keyed as the fault scope keys them. The
   * synchronous `evaluate` accepts a recorded reference in this set and
   * fails closed on any other, as it does with no set at all.
   */
  readonly authorizedReferences?: ReadonlySet<string>;
  /**
   * The sensitive-field references the authorization step could not
   * authorize, each with the error its check raised: a denial under the
   * run's vault access, an unavailable vault, or no vault scope to check
   * under. A synchronous `evaluate` that reads one fails with that error,
   * before release issues a sentinel. One the evaluation never reads costs
   * nothing, so a denied record of a named model does not fail a read of
   * another of its records.
   */
  readonly deniedReferences?: ReadonlyMap<string, unknown>;
}

/**
 * Builds the internal environment: the extension baseline plus swamp's
 * namespace types and their receiver methods.
 */
export function createInternalCelEnvironment(
  options: CelEvaluatorOptions = {},
): Environment {
  return buildInternalEnvironment(options.typedSecrets ? "evaluate" : "off");
}

/**
 * How an internal environment treats typed secrets. `off` is the legacy
 * environment. `evaluate` registers the `Secret` type, the typed vault
 * receiver, the allowed set and every refusal the inventory yields. `check`
 * is the type-check environment that nothing ever evaluates
 * (design/enablers/typed-secrets.md Section 4.3 item 4): the type, the
 * receiver and the allowed set with no refusal, and `vault` bound as a
 * variable of the receiver type, so a check accepts the allowed set and
 * rejects any other operation on a `vault.get` result.
 */
type SecretMode = "off" | "evaluate" | "check";

/**
 * The type-check environment of the static misuse diagnostics
 * (`secret_diagnostics.ts`). Built here so the `Secret` modules stay inside
 * the adapter.
 */
export function createSecretCheckEnvironment(): Environment {
  return buildInternalEnvironment("check");
}

/** Never reached: a check environment evaluates nothing. */
function neverEvaluated(): never {
  throw new Error("A type-check environment evaluates nothing");
}

function buildInternalEnvironment(mode: SecretMode): Environment {
  const env = createExtensionCelEnvironment();
  const typed = mode === "evaluate";
  // Destinations that take no secret: with typed secrets on, a value bound
  // for one is walked and copied, and a Secret in it is refused.
  const toDestination: <T>(value: T, operation: string) => T = typed
    ? <T>(value: T, operation: string) =>
      detachForDestination(value, operation) as T
    : <T>(value: T) => value;
  // Records an accessor answers: with typed secrets on, the reader's
  // own-namespace records are read as stored and their tagged fields become
  // data-origin Secrets (typed-secrets 3.3). Gated here, on the option, so a
  // namespace instance built earlier and reused is adapted all the same.
  const fromAccessor: (
    receiver: CelDataNamespace,
    result: unknown,
    accessor: DataAccessor,
  ) => unknown = typed
    ? (receiver, result, accessor) =>
      adaptDataResult(result, receiver.namespace, accessor)
    : (_receiver, result) => result;
  const readOptions: DataReadOptions | undefined = typed
    ? { sensitiveFields: "stored" }
    : undefined;

  // Register namespace types so cel-js recognizes them via constructor
  // matching instead of trying to infer them as maps.
  env.registerType("CelFileNamespace", CelFileNamespace);
  env.registerType("CelDataNamespace", CelDataNamespace);
  env.registerType("CelWorkersNamespace", CelWorkersNamespace);
  env.registerType("CelModelNamespace", CelModelNamespace);

  // literal('...') returns its string unchanged, so one value can mix a
  // swamp expression with another service's template text:
  // `${{ inputs.env }} on ${{ literal('{{host.name}}') }}`.
  env.registerFunction(LITERAL_FUNCTION_SIGNATURE, literal);

  // Register receiver methods for file namespace
  env.registerFunction(
    "CelFileNamespace.contents(string, string): dyn",
    (receiver: CelFileNamespace, modelName: string, specName: string) =>
      receiver.contents(modelName, specName),
  );

  // Register receiver methods for data namespace
  env.registerFunction(
    "CelDataNamespace.latest(string, string): dyn",
    (receiver: CelDataNamespace, modelName: string, dataName: string) =>
      fromAccessor(
        receiver,
        receiver.latest(modelName, dataName, undefined, readOptions),
        "data.latest",
      ),
  );

  env.registerFunction(
    "CelDataNamespace.version(string, string, int): dyn",
    (
      receiver: CelDataNamespace,
      modelName: string,
      dataName: string,
      version: unknown,
    ) =>
      fromAccessor(
        receiver,
        receiver.version(modelName, dataName, version),
        "data.version",
      ),
  );

  env.registerFunction(
    "CelDataNamespace.listVersions(string, string): dyn",
    (receiver: CelDataNamespace, modelName: string, dataName: string) =>
      receiver.listVersions(modelName, dataName),
  );

  // Register vary-aware overloads (3rd arg is list<dyn>)
  env.registerFunction(
    "CelDataNamespace.latest(string, string, list<dyn>): dyn",
    (
      receiver: CelDataNamespace,
      modelName: string,
      dataName: string,
      varyValues: unknown[],
    ) =>
      fromAccessor(
        receiver,
        receiver.latest(
          modelName,
          dataName,
          toDestination(varyValues, "the vary values of data.latest"),
          readOptions,
        ),
        "data.latest",
      ),
  );

  env.registerFunction(
    "CelDataNamespace.version(string, string, list<dyn>, int): dyn",
    (
      receiver: CelDataNamespace,
      modelName: string,
      dataName: string,
      varyValues: unknown[],
      version: unknown,
    ) =>
      fromAccessor(
        receiver,
        receiver.version(
          modelName,
          dataName,
          toDestination(varyValues, "the vary values of data.version"),
          version,
        ),
        "data.version",
      ),
  );

  env.registerFunction(
    "CelDataNamespace.listVersions(string, string, list<dyn>): dyn",
    (
      receiver: CelDataNamespace,
      modelName: string,
      dataName: string,
      varyValues: unknown[],
    ) =>
      receiver.listVersions(
        modelName,
        dataName,
        toDestination(varyValues, "the vary values of data.listVersions"),
      ),
  );

  env.registerFunction(
    "CelDataNamespace.findByTag(string, string): dyn",
    (receiver: CelDataNamespace, tagKey: string, tagValue: string) =>
      fromAccessor(
        receiver,
        receiver.findByTag(tagKey, tagValue),
        "data.findByTag",
      ),
  );

  env.registerFunction(
    "CelDataNamespace.findBySpec(string, string): dyn",
    (receiver: CelDataNamespace, modelName: string, specName: string) =>
      fromAccessor(
        receiver,
        receiver.findBySpec(modelName, specName),
        "data.findBySpec",
      ),
  );

  env.registerFunction(
    "CelDataNamespace.query(string): dyn",
    (receiver: CelDataNamespace, predicate: string) =>
      receiver.query(predicate),
  );

  env.registerFunction(
    "CelDataNamespace.query(string, string): dyn",
    (receiver: CelDataNamespace, predicate: string, select: string) =>
      receiver.query(predicate, select),
  );

  // Register receiver methods for workers namespace
  env.registerFunction(
    "CelWorkersNamespace.connected(): dyn",
    (receiver: CelWorkersNamespace) => receiver.connected(),
  );

  // Register receiver methods for model namespace. model.method is the
  // effectful function (design/enablers/typed-secrets.md Section 4.5): with
  // typed secrets on, the effect gate runs before any delegate work, the
  // inputs are delivered through the boundary into the run's bag, and the
  // record it returns is adapted so its tagged fields are Secrets.
  const gate: () => void = typed ? gateModelMethodEffect : () => {};
  // Ints are delivered as numbers on both paths (swamp-club#3708).
  const deliverInputs: (inputs: unknown) => Record<string, unknown> = typed
    ? (inputs) =>
      coerceBigIntsForDelegate(deliverModelMethodInputs(inputs)) as Record<
        string,
        unknown
      >
    : (inputs) => coerceBigIntsForDelegate(inputs) as Record<string, unknown>;
  const adaptResult: (result: unknown) => unknown = typed
    ? adaptModelMethodResultDeep
    : (result) => result;
  env.registerFunction(
    "CelModelNamespace.method(string, string): dyn",
    (
      receiver: CelModelNamespace,
      modelName: string,
      methodName: string,
    ) => {
      gate();
      return adaptResult(receiver.method(modelName, methodName));
    },
  );

  env.registerFunction(
    "CelModelNamespace.method(string, string, dyn): dyn",
    (
      receiver: CelModelNamespace,
      modelName: string,
      methodName: string,
      inputs: unknown,
    ) => {
      gate();
      return adaptResult(
        receiver.method(modelName, methodName, deliverInputs(inputs)),
      );
    },
  );

  if (mode === "evaluate" || mode === "check") {
    registerSecretType(env);
    env.registerType("CelVaultNamespace", CelVaultNamespace);
    env.registerFunction(
      "CelVaultNamespace.get(string, string): Secret",
      typed
        ? (receiver: CelVaultNamespace, vault: string, key: string) =>
          receiver.get(vault, key)
        : neverEvaluated,
      { async: false },
    );
    registerAllowedSet(env);
  }
  if (mode === "check") {
    env.registerVariable("vault", "CelVaultNamespace");
  }
  if (typed) {
    registerSecretRefusals(env, {
      customTypes: [...SWAMP_NAMESPACE_TYPES, ...TYPED_VAULT_NAMESPACE_TYPES],
      swampSignatures: [
        ...INTERNAL_FUNCTION_SIGNATURES,
        ...TYPED_VAULT_FUNCTION_SIGNATURES,
      ],
      // The model and method names of model.method are routing arguments
      // (Section 4.5 item 2): a Secret there is refused as a destination.
      codeFor: (signature) =>
        signature.startsWith("CelModelNamespace.method(")
          ? SECRET_DESTINATION_REFUSED
          : undefined,
    });
  }
  return env;
}

/** The error for a Promise the synchronous path cannot await. */
function unresolvedPromiseError(expression: string): InvalidExpressionError {
  return new InvalidExpressionError(
    "Expression returned an unresolved Promise. " +
      "Async CEL functions (data.latest, data.findByTag, " +
      "data.findBySpec, data.query) cannot be used in " +
      "synchronously-evaluated contexts like forEach.in. " +
      "Move the async call into a parent workflow's task.inputs " +
      "(which IS awaited) and pass the resolved value to a child " +
      "workflow. See: .claude/skills/swamp/references/workflow/" +
      "references/nested-workflows.md#when-to-use-nested-workflows",
    expression,
  );
}

/**
 * The effect gate of `model.method` (design/enablers/typed-secrets.md
 * Section 4.5 item 1), run before any delegate work: refuse when the
 * evaluation has already recorded a fault or a binding failure, or when its
 * expression has a container comparison and a secret was already read, so a
 * refusal that `||`, `&&`, `exists` or `all` absorbed never starts an effect
 * that today's short-circuit would have skipped. Outside an evaluation it
 * fails closed.
 */
function gateModelMethodEffect(): void {
  const scope = currentFaultScope();
  if (scope === undefined) {
    refuse("model.method outside an evaluation");
  }
  if (scope.faults.length > 0 || scope.boundaryFailure !== undefined) {
    refuse("an effect after a refusal", scope.faults[0]?.code);
  }
  if (scope.containerComparison && scope.secretsRead > 0) {
    refuse(
      "an effect in an expression with a container comparison that read a secret",
    );
  }
}

/**
 * The inputs of `model.method` as its delegate receives them (Section 4.5
 * item 3): a plain copy with each `Secret` released as a sentinel of the
 * run's bag, so the synthetic step loads it under its own attempt and no
 * `Secret` reaches the delegate. The copy keeps cel-js's own values (ints as
 * bigints, which the caller delivers as numbers). With no bag to issue into,
 * a `Secret` in them has nowhere to go and is refused as a destination, and
 * the rest is copied plain.
 */
function deliverModelMethodInputs(inputs: unknown): Record<string, unknown> {
  const release = currentFaultScope()?.release;
  return (release
    ? release(inputs)
    : detachForDestination(inputs, "the inputs of model.method")) as Record<
      string,
      unknown
    >;
}

/**
 * {@link adaptModelMethodResult} over what the delegate answers, a value or
 * a Promise of one. A rejected adaptation is a refusal cel-js observes when
 * it awaits the result; the Promise is also marked handled, so an
 * evaluation abandoned before that leaves no unobserved rejection.
 */
function adaptModelMethodResultDeep(result: unknown): unknown {
  if (result instanceof Promise) {
    const adapted = result.then(adaptModelMethodResultDeep);
    adapted.catch(() => {});
    return adapted;
  }
  return adaptModelMethodResult(result);
}

/** One evaluation with typed secrets on, parsed and bound. */
interface SecretEvaluation {
  readonly evaluate: () => unknown;
  readonly analysis: VaultCallAnalysis;
  readonly bindings: Record<string, unknown>;
  /** Whether the expression holds a container comparison. */
  readonly containerComparison: boolean;
  /** The conversion, when the evaluation has a run's bag. */
  readonly boundary?: SecretBoundary;
  /** Whether the result is a predicate destination, which refuses a secret. */
  readonly refusesSecretResult: boolean;
}

/** What the predicate destination names when it refuses a result. */
const PREDICATE_RESULT =
  "a guard or assert predicate result that holds a secret";

/**
 * CEL evaluator that wraps the cel-js library.
 *
 * Uses the cel-js Environment class with registered types and receiver methods
 * to support function call syntax (e.g., file.contents(), data.latest()) in
 * CEL expressions.
 */
export class CelEvaluator {
  private readonly env: Environment;
  private readonly warnedPatterns = new Set<string>();
  private readonly typedSecrets: boolean;

  constructor(options: CelEvaluatorOptions = {}) {
    this.typedSecrets = options.typedSecrets === true;
    this.env = createInternalCelEnvironment(options);
  }

  /**
   * Whether this evaluator runs with typed secrets: what a delegate that
   * answers it a record must know, since only the typed environment adapts
   * one (design/enablers/typed-secrets.md Section 4.5 item 4).
   */
  get isTyped(): boolean {
    return this.typedSecrets;
  }

  /**
   * Evaluates a CEL expression with the given context.
   *
   * @param expression - The CEL expression to evaluate
   * @param context - The context object containing model, self, workflow data
   * @param scope - What the evaluation runs with, read with typed secrets on
   * @returns The evaluated result
   * @throws InvalidExpressionError if evaluation fails
   */
  evaluate(
    expression: string,
    context: Record<string, unknown>,
    scope: EvaluationScope = {},
  ): unknown {
    if (this.typedSecrets) {
      return this.evaluateWithSecrets(expression, context, scope);
    }
    // Wrap file/data namespace objects in registered types so cel-js can
    // resolve receiver methods instead of treating them as maps. Hoisted out
    // of the try so the catch can read back which data lookups missed.
    const wrappedContext = this.wrapNamespaces(context);
    try {
      // Transform hyphenated model names to bracket notation before evaluation
      const transformedExpr = transformHyphenatedModelRefs(expression);

      // Warn about deprecated model.*.resource / model.*.file patterns
      this.warnDeprecatedPatterns(transformedExpr);

      const rawResult = this.env.evaluate(transformedExpr, wrappedContext);
      const result = unwrapOptional(rawResult);

      // Detect unresolved Promises from async CEL functions (data.latest,
      // data.findByTag, data.findBySpec, data.query).  These functions are
      // async but the sync evaluate path cannot await them, so the raw
      // Promise leaks through.  Catch it here — before coerceBigInts
      // silently converts the Promise to {} — and throw a clear error.
      if (result instanceof Promise) {
        // Suppress the dangling rejection — the async operation is still
        // in flight but we are about to throw synchronously.  Without
        // this, the eventual rejection surfaces as an unhandled promise
        // rejection in the runtime.
        result.catch(() => {});

        throw unresolvedPromiseError(expression);
      }

      return coerceBigInts(result);
    } catch (error) {
      // Re-throw InvalidExpressionError directly to avoid double-wrapping
      // (the Promise detection above already throws this type).
      if (error instanceof InvalidExpressionError) throw error;
      throw new InvalidExpressionError(
        this.explainMissedLookups(
          error instanceof Error ? error.message : String(error),
          wrappedContext,
        ),
        expression,
        undefined,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Evaluates a CEL expression that may contain async functions.
   *
   * cel-js natively propagates Promises through operators and macros.
   * When a registered function returns a Promise, env.evaluate() returns
   * a Promise. This method awaits it.
   *
   * Use this for expressions that may call data namespace functions
   * (data.findBySpec, data.latest, etc.) which are async.
   * Use the sync evaluate() for predicate filtering where no async
   * functions are involved.
   */
  async evaluateAsync(
    expression: string,
    context: Record<string, unknown>,
    scope: EvaluationScope = {},
  ): Promise<unknown> {
    if (this.typedSecrets) {
      return await this.evaluateWithSecretsAsync(expression, context, scope);
    }
    const wrappedContext = this.wrapNamespaces(context);
    try {
      // Prepare what the expression reads synchronously first: the
      // definitions behind the model names it passes to data accessors
      // (swamp-club#3029), and the content it reads through the model map
      // and file.contents (swamp-club#3179).
      await prepareExpressionContext(expression, context);
      const transformedExpr = transformHyphenatedModelRefs(expression);
      this.warnDeprecatedPatterns(transformedExpr);
      const rawResult = await this.env.evaluate(
        transformedExpr,
        wrappedContext,
      );
      return coerceBigInts(unwrapOptional(rawResult));
    } catch (error) {
      throw new InvalidExpressionError(
        this.explainMissedLookups(
          error instanceof Error ? error.message : String(error),
          wrappedContext,
        ),
        expression,
        undefined,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * {@link evaluate} with typed secrets on: the bindings read through the
   * boundary conversion, the evaluation runs in a fault scope, and a
   * refusal decides the outcome before anything else does.
   */
  private evaluateWithSecrets(
    expression: string,
    context: Record<string, unknown>,
    scope: EvaluationScope,
  ): unknown {
    const wrappedContext = this.wrapNamespaces(context);
    return runInFaultScope((faults) => {
      let run: SecretEvaluation | undefined;
      let result: unknown;
      try {
        run = this.beginWithSecrets(expression, wrappedContext, scope, faults);
        if (run.analysis.calls.length > 0) {
          throw new InvalidExpressionError(
            "vault.get requires evaluateAsync for its up-front reference checks",
            expression,
          );
        }
        result = run.evaluate();
      } catch (error) {
        faults.recording = false;
        this.refuseFaulted(faults, run, expression);
        if (error instanceof InvalidExpressionError) throw error;
        throw this.evaluationError(error, expression, wrappedContext);
      }
      // Handle a Promise the synchronous path cannot await before anything
      // can throw: a refusal absorbed beside an async call rejects it.
      if (result instanceof Promise) result.catch(() => {});
      faults.recording = false;
      this.refuseFaulted(faults, run, expression);
      if (result instanceof Promise) throw unresolvedPromiseError(expression);
      // Authorization is asynchronous, so a record with tagged fields cannot
      // be read here, as vault.get cannot (typed-secrets 3.3; Phase 4 gives
      // the synchronous passes an authorization step of their own). The
      // result is read as release reads it first, so a record the expression
      // returned without selecting into it is adapted now, and the check
      // refuses before release issues a sentinel for anything.
      try {
        readResult(result);
      } catch (error) {
        if (error instanceof SecretRefusal) {
          throw new SecretRefusedError(error.code, error.operation, expression);
        }
        throw this.evaluationError(error, expression, wrappedContext);
      }
      this.refuseSynchronousSensitiveReads(
        faults,
        scope,
        expression,
        wrappedContext,
      );
      return this.releaseWithSecrets(result, run, expression);
    });
  }

  /**
   * Fails a synchronous evaluation closed on a sensitive-field reference it
   * read that {@link prepareSynchronousReads} did not authorize: with the
   * error the step's check raised for it, or, for one the step never saw,
   * naming evaluateAsync, since the authorization is asynchronous and the
   * synchronous path can only accept what was authorized ahead of it
   * (typed-secrets 3.3 and 4.1).
   */
  private refuseSynchronousSensitiveReads(
    faults: FaultScope,
    scope: EvaluationScope,
    expression: string,
    wrappedContext: Record<string, unknown>,
  ): void {
    for (const key of faults.sensitiveReferences.keys()) {
      if (scope.authorizedReferences?.has(key)) continue;
      const denial = scope.deniedReferences?.get(key);
      if (denial !== undefined) {
        throw this.evaluationError(denial, expression, wrappedContext);
      }
      throw new InvalidExpressionError(
        "a record with sensitive fields requires evaluateAsync for the authorization of its references",
        expression,
      );
    }
  }

  /**
   * The authorization step of the synchronous passes
   * (design/enablers/typed-secrets.md Section 3.4, typed-secrets 4.1). It
   * prepares the context for every expression in `content` as
   * {@link prepareExpressionsIn} does, and with typed secrets on, it takes
   * the `model.<name>.resource` records those expressions read
   * synchronously, from the same analysis the data namespace's `prepare`
   * uses, and the output sources of the `steps.<name>` contexts they read
   * (typed-secrets 4.2), parses their sensitive-fields tags (no vault read)
   * and authorizes
   * each reference through the scope's vault service under the run's vault
   * access, as the asynchronous path does after evaluation. The scope it
   * returns carries the authorized keys, so a synchronous `evaluate` under
   * it accepts those reads and keeps failing closed on any other. The read
   * set names models, not records, so a check that fails (a denial, an
   * unavailable vault, no vault scope) is kept for its reference and fails
   * the evaluation that reads the record holding it, before release issues
   * a sentinel; a reference the evaluation never reads costs nothing. A
   * record whose tag does not parse is left for the evaluation to refuse.
   * With typed secrets off, or no record read, the scope is returned as
   * given.
   */
  async prepareSynchronousReads(
    content: unknown,
    context: Record<string, unknown>,
    scope: EvaluationScope = {},
  ): Promise<EvaluationScope> {
    await prepareExpressionsIn(content, context);
    if (!this.typedSecrets) return scope;
    const authorized = new Set(scope.authorizedReferences ?? []);
    const denied = new Map(scope.deniedReferences ?? []);
    let changed = false;
    const seen = new Set<string>();
    const wrappedContext = this.wrapNamespaces(context);
    const data = wrappedContext["data"];
    const ownNamespace = data instanceof CelDataNamespace
      ? data.namespace
      : undefined;
    for (const expr of extractExpressions(content)) {
      if (seen.has(expr.celExpression)) continue;
      seen.add(expr.celExpression);
      const references = synchronousSensitiveReferences(
        expr.celExpression,
        wrappedContext["model"],
        ownNamespace,
        wrappedContext["steps"],
      );
      for (const reference of references) {
        const key = sensitiveReferenceKey(reference);
        if (authorized.has(key) || denied.has(key)) continue;
        changed = true;
        if (scope.vault === undefined) {
          denied.set(
            key,
            new Error(
              "a record with sensitive fields requires the run's vault check scope",
            ),
          );
          continue;
        }
        try {
          await scope.vault.service.authorizeRead(
            reference.vaultName,
            reference.key,
          );
          authorized.add(key);
        } catch (error) {
          denied.set(key, error);
        }
      }
    }
    return changed
      ? { ...scope, authorizedReferences: authorized, deniedReferences: denied }
      : scope;
  }

  /** {@link evaluateAsync} with typed secrets on, as {@link evaluateWithSecrets}. */
  private async evaluateWithSecretsAsync(
    expression: string,
    context: Record<string, unknown>,
    scope: EvaluationScope,
  ): Promise<unknown> {
    const wrappedContext = this.wrapNamespaces(context);
    return await runInFaultScope(async (faults) => {
      let run: SecretEvaluation | undefined;
      let result: unknown;
      let checking = false;
      let executing = false;
      try {
        // Reject aliases before context preparation or argument evaluation can
        // start external work. Every direct call is checked, even in dead branches.
        const analysis = analyzeVaultCalls(expression);
        assertDirectVaultCalls(analysis, expression);
        if (analysis.calls.length > 0 && (!scope.secretBag || !scope.vault)) {
          throw new InvalidExpressionError(
            "vault.get requires the run's secret bag and vault check scope",
            expression,
          );
        }
        await prepareExpressionContext(expression, context);
        // Preparation can issue sentinels. Bind only after it completes so
        // the boundary sees the registry and context that execution will read.
        run = this.beginWithSecrets(
          expression,
          wrappedContext,
          scope,
          faults,
          analysis,
        );
        let execute = run.evaluate;
        if (run.analysis.calls.length > 0 && scope.secretBag && scope.vault) {
          checking = true;
          execute = await prepareCheckedVaultCalls(
            this.env,
            run.analysis,
            expression,
            run.bindings,
            scope.secretBag,
            scope.vault,
            () => this.refuseFaulted(faults, run, expression),
          );
          checking = false;
        }
        executing = true;
        result = await execute();
      } catch (error) {
        faults.recording = false;
        this.refuseFaulted(faults, run, expression);
        // Reference checks have their own domain error contract. In particular,
        // preserve unavailable/access-denied codes and the provider's failure.
        if (
          checking || (!executing && error instanceof InvalidExpressionError)
        ) {
          throw error;
        }
        throw this.evaluationError(error, expression, wrappedContext);
      }
      faults.recording = false;
      this.refuseFaulted(faults, run, expression);
      // Release first: it adapts records the expression returned unread, and
      // their references must be authorized too.
      const released = this.releaseWithSecrets(result, run, expression);
      await this.authorizeSensitiveReferences(
        faults,
        scope,
        expression,
        wrappedContext,
      );
      return released;
    });
  }

  /**
   * Authorizes every sensitive-field reference the evaluation's records hold
   * under the run's vault access, selected or not, before the result is used
   * (design/enablers/typed-secrets.md Section 3.4). A policy decision only:
   * no existence check, probe or load. A denial fails the evaluation as the
   * read-time denial does with typed secrets off, and a missing scope fails
   * closed.
   */
  private async authorizeSensitiveReferences(
    faults: FaultScope,
    scope: EvaluationScope,
    expression: string,
    wrappedContext: Record<string, unknown>,
  ): Promise<void> {
    if (faults.sensitiveReferences.size === 0) return;
    if (scope.vault === undefined) {
      throw new InvalidExpressionError(
        "a record with sensitive fields requires the run's vault check scope",
        expression,
      );
    }
    for (const reference of faults.sensitiveReferences.values()) {
      try {
        await scope.vault.service.authorizeRead(
          reference.vaultName,
          reference.key,
        );
      } catch (error) {
        throw this.evaluationError(error, expression, wrappedContext);
      }
    }
  }

  /**
   * Parses normalized source, scans it for a container comparison, and
   * binds the context through the boundary conversion. Calling the parsed
   * program is what `env.evaluate` does, so no state lands on a shared
   * program (fact 7).
   */
  private beginWithSecrets(
    expression: string,
    wrappedContext: Record<string, unknown>,
    scope: EvaluationScope,
    faults: FaultScope,
    analysis: VaultCallAnalysis = analyzeVaultCalls(expression),
  ): SecretEvaluation {
    assertDirectVaultCalls(analysis, expression);
    this.warnDeprecatedPatterns(analysis.source.text);
    const program = this.env.parse(analysis.source.text);
    const boundary = scope.secretBag === undefined
      ? undefined
      : new SecretBoundary(scope.secretBag);
    const context = this.withModelView(wrappedContext);
    const bindings = boundary?.bind(context) ?? context;
    const containerComparison = hasContainerComparison(program.ast);
    // What the effectful function reads before it starts (Section 4.5).
    faults.containerComparison = containerComparison;
    faults.release = boundary === undefined
      ? undefined
      : (value) => boundary.release(value);
    return {
      evaluate: () => program(bindings),
      analysis,
      bindings,
      containerComparison,
      boundary,
      refusesSecretResult: scope.secretResult === "refuse",
    };
  }

  /**
   * The context with a plain model map replaced by the accessor adapter's
   * lazy view, so `model.<name>.resource` records read with their tagged
   * fields as Secrets (typed-secrets 3.3), and the steps map replaced by its
   * view, so `steps.<name>.outputs` read through their sources the same way
   * (typed-secrets 4.2). A context whose `model` is the method receiver
   * {@link wrapNamespaces} installs, or that has neither map, is returned as
   * it is. The copy keeps the caller's context untouched. Both maps hold
   * only this repository's records, so a context with no data namespace to
   * name the reader's own adapts every record they hold.
   */
  private withModelView(
    wrappedContext: Record<string, unknown>,
  ): Record<string, unknown> {
    const model = wrappedContext["model"];
    const steps = wrappedContext["steps"];
    const data = wrappedContext["data"];
    const ownNamespace = data instanceof CelDataNamespace
      ? data.namespace
      : undefined;
    const modelView = modelMapView(model, ownNamespace);
    const stepsMapView = stepsView(steps, ownNamespace);
    if (modelView === model && stepsMapView === steps) return wrappedContext;
    const context: Record<string, unknown> = Object.create(
      Object.getPrototypeOf(wrappedContext),
      Object.getOwnPropertyDescriptors(wrappedContext),
    );
    const replace = (key: string, value: unknown): void => {
      Object.defineProperty(context, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    };
    if (modelView !== model) replace("model", modelView);
    if (stepsMapView !== steps) replace("steps", stepsMapView);
    return context;
  }

  /**
   * Fails the evaluation on what its fault scope recorded, whatever cel-js
   * answered: a binding the conversion could not read, a refusal (the first
   * one decides the code), or a container comparison in an expression that
   * read a secret (design/enablers/typed-secrets.md Section 4.3).
   */
  private refuseFaulted(
    faults: FaultScope,
    run: SecretEvaluation | undefined,
    expression: string,
  ): void {
    if (faults.boundaryFailure !== undefined) {
      throw new InvalidExpressionError(
        faults.boundaryFailure.message,
        expression,
      );
    }
    const fault = faults.faults[0];
    if (fault !== undefined) {
      throw new SecretRefusedError(fault.code, fault.operation, expression);
    }
    if (run?.containerComparison && faults.secretsRead > 0) {
      throw new SecretRefusedError(
        SECRET_OPERATION_UNSUPPORTED,
        "a container comparison (in, or == or != with no scalar literal " +
          "or null operand) in an expression that reads a secret",
        expression,
      );
    }
  }

  /**
   * Converts a result at the boundary, before the adapter's own
   * post-processing: each `Secret` leaves as its sentinel, and with no
   * run's bag to issue into, a `Secret` result is refused. Release reads a
   * record the expression returned without selecting into it, so a record
   * the accessor adapter refuses there keeps its code.
   */
  private releaseWithSecrets(
    result: unknown,
    run: SecretEvaluation,
    expression: string,
  ): unknown {
    try {
      if (run.refusesSecretResult) {
        // The predicate destination: the result is read as release reads
        // it, so a record returned unread is adapted and refused too, and
        // nothing is issued into the bag (Section 7.1).
        return coerceBigInts(
          unwrapOptional(detachForDestination(result, PREDICATE_RESULT)),
        );
      }
      if (run.boundary === undefined) {
        refuseUnboundSecrets(result, expression);
        return coerceBigInts(unwrapOptional(result));
      }
      return coerceBigInts(unwrapOptional(run.boundary.release(result)));
    } catch (error) {
      if (error instanceof SecretRefusedError) throw error;
      if (error instanceof SecretRefusal) {
        throw new SecretRefusedError(error.code, error.operation, expression);
      }
      throw new InvalidExpressionError(
        error instanceof Error ? error.message : String(error),
        expression,
      );
    }
  }

  private evaluationError(
    error: unknown,
    expression: string,
    wrappedContext: Record<string, unknown>,
  ): InvalidExpressionError {
    return new InvalidExpressionError(
      this.explainMissedLookups(
        error instanceof Error ? error.message : String(error),
        wrappedContext,
      ),
      expression,
      undefined,
      error instanceof Error ? error : undefined,
    );
  }

  /**
   * Validates a CEL expression without evaluating it. Parses the same text
   * evaluation does — hyphenated model refs (`model.web-1a`) are rewritten
   * first — so an expression that evaluates is never reported as invalid.
   *
   * @param expression - The CEL expression to validate
   * @returns Validation result with error message if invalid
   */
  validate(expression: string): ValidationResult {
    try {
      // Attempt to parse the expression — ParseResult is callable, not a
      // success/error union.  If parse() doesn't throw, the syntax is valid.
      if (this.typedSecrets) {
        const analysis = analyzeVaultCalls(expression);
        assertDirectVaultCalls(analysis, expression);
        this.env.parse(analysis.source.text);
      } else this.env.parse(transformHyphenatedModelRefs(expression));
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Wraps file and data namespace context objects in their registered CEL types.
   */
  private wrapNamespaces(
    context: Record<string, unknown>,
  ): Record<string, unknown> {
    const file = context["file"];
    const data = context["data"];
    const workers = context["workers"];
    const modelMethod = context["modelMethod"];
    if (!file && !data && !workers && !modelMethod) return context;

    const wrapped = { ...context };
    if (
      file && typeof file === "object" && !(file instanceof CelFileNamespace)
    ) {
      wrapped["file"] = new CelFileNamespace(file as Record<string, unknown>);
    }
    if (
      data && typeof data === "object" && !(data instanceof CelDataNamespace)
    ) {
      wrapped["data"] = new CelDataNamespace(data as Record<string, unknown>);
    } else if (data instanceof CelDataNamespace) {
      // An already-wrapped namespace is reused across evaluations; drop the
      // previous expression's misses so they cannot explain this one's error.
      data.clearMissedLookups();
    }
    if (
      workers && typeof workers === "object" &&
      !(workers instanceof CelWorkersNamespace)
    ) {
      wrapped["workers"] = new CelWorkersNamespace(
        workers as Record<string, unknown>,
      );
    }
    if (
      modelMethod && typeof modelMethod === "object" &&
      !(modelMethod instanceof CelModelNamespace)
    ) {
      wrapped["model"] = new CelModelNamespace(
        modelMethod as Record<string, unknown>,
      );
      delete wrapped["modelMethod"];
    }
    return wrapped;
  }

  /**
   * Appends an explanation when a "No such key" error is really a data lookup
   * that found no record.
   *
   * `data.latest()` and `data.version()` return null when the record is
   * missing, and a non-optional select off that null raises cel-js's generic
   * "No such key: attributes" — which points the caret at the field and hides
   * the real cause. The hint names the lookups that missed, and is appended
   * below cel-js's own source snippet so the caret survives.
   *
   * Gated on the selected key being a field of `DataRecord`, so an expression
   * that mixes an optional miss with a genuine misspelled attribute is not
   * told to make the misspelling optional. The field set is written out rather
   * than derived from the `DataRecord` type, which carries no runtime keys;
   * drift is harmless either way — a missing entry only costs the hint, and a
   * stale one only adds it to an expression that already names a missed
   * lookup.
   */
  private explainMissedLookups(
    message: string,
    wrappedContext: Record<string, unknown>,
  ): string {
    // cel-js appends a source snippet and caret after the first line, so this
    // matches the prefix — never the whole message.
    const key = message.match(/^No such key: (\w+)/)?.[1];
    if (!key || !DATA_RECORD_FIELDS.has(key)) return message;
    const data = wrappedContext["data"];
    if (!(data instanceof CelDataNamespace)) return message;
    const missed = [...new Set(data.missedLookups)];
    if (missed.length === 0) return message;
    const explained =
      `${message}\n\n${
        missed.join(" and ")
      } found no data record — check the model and data names, or use ` +
      `.?${key} if the record may not exist yet.`;
    const specHints = data.explainSpecNameMisses();
    return specHints.length === 0
      ? explained
      : `${explained}\n\n${specHints.join("\n\n")}`;
  }

  /**
   * Emits a deprecation warning when an expression uses model.*.resource or
   * model.*.file patterns. Warnings are deduplicated per expression.
   */
  private warnDeprecatedPatterns(expression: string): void {
    // Match model.X.resource or model["X"].resource (and .file). Text passed
    // through literal() is not a reference, so it never warns.
    const pattern = /model(?:\.\w[\w-]*|\["[^"]+"\])\.(?:resource|file)\b/;
    if (pattern.test(maskLiteralCalls(expression))) {
      if (!this.warnedPatterns.has(expression)) {
        this.warnedPatterns.add(expression);
        getLogger(["expressions"])
          .warn`Deprecated: expression ${expression} uses model.*.resource or model.*.file which will be removed in a future release. Use data.latest() or data.version() instead.`;
      }
    }
  }
}
