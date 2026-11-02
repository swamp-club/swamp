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
import type { ASTNode } from "cel-js";
import { getLogger } from "@logtape/logtape";
import {
  InvalidExpressionError,
  MissingModelDataError,
} from "../../domain/expressions/errors.ts";
import { extractExpressions } from "../../domain/expressions/expression_parser.ts";
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
  isMissingRunBinding,
  prepareCheckedVaultCalls,
  type VaultEvaluationScope,
} from "./cel_vault_namespace.ts";
import { coerceBigInts } from "./cel_coercion.ts";
import { composeDataName } from "../../domain/data/mod.ts";
import type { NamespaceReader } from "../../domain/data/namespace.ts";
import {
  SECRET_DESTINATION_REFUSED,
  SECRET_OPERATION_UNSUPPORTED,
  SecretRefusedError,
  UnboundExpressionError,
} from "../../domain/expressions/errors.ts";
import type { DataReadOptions } from "../../domain/expressions/model_resolver.ts";
import type { QueryView } from "../../domain/data/query_view.ts";
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
import { expressionQueryView } from "./query_view.ts";
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

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

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

/**
 * walks only arrays and plain maps, leaving other objects as they are, so a
 * timestamp reaches the method as a Date and serializes as its ISO string
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
 * cel-js needs a registered type via constructor matching, or it infers a map
 * and chokes on function-valued properties
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
 * vary forms are never recorded: their data name is composed, so it cannot be a
 * spec name
 */
interface SpecNameCandidate {
  accessor: "latest" | "version";
  modelName: string;
  dataName: string;
}

const MAX_LISTED_SPEC_INSTANCES = 3;

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
 * only the selected value matters: a missing lookup in a sibling must not
 * excuse an invalid select. Resolve from plain bindings without invoking
 * getters or replaying functions, so diagnosis does no external work
 */
function selectsDataLookup(
  error: unknown,
  context: Record<string, unknown>,
): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, node } = error as { code?: unknown; node?: unknown };
  if (code !== "no_such_key" || !isAstNode(node)) return false;
  if (node.op !== "." && node.op !== "[]") return false;
  const operand = selectedNode(node.args[0], context);
  if (operand?.op !== "rcall") return false;
  const [name, receiver] = operand.args;
  return (name === "latest" || name === "version") &&
    receiver.op === "id" && receiver.args === "data";
}

const SET_READ_ACCESSORS = ["findBySpec", "findByTag", "query"] as const;
type SetReadAccessor = typeof SET_READ_ACCESSORS[number];

function isSetReadAccessor(name: unknown): name is SetReadAccessor {
  return (SET_READ_ACCESSORS as readonly unknown[]).includes(name);
}

function setReadKey(accessor: SetReadAccessor, args: unknown[]): string {
  return JSON.stringify([accessor, ...args]);
}

/**
 * arguments are read from plain literals and bindings and matched against
 * recorded answers, so an empty answer to one call never excuses an index into
 * another
 */
function indexedEmptySetRead(
  error: unknown,
  context: Record<string, unknown>,
): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, node } = error as { code?: unknown; node?: unknown };
  if (code !== "index_out_of_bounds" || !isAstNode(node)) return undefined;
  if (node.op !== "[]") return undefined;
  const operand = selectedNode(node.args[0], context);
  if (operand?.op !== "rcall") return undefined;
  const [name, receiver, argNodes] = operand.args;
  if (
    !isSetReadAccessor(name) || receiver.op !== "id" ||
    receiver.args !== "data"
  ) return undefined;
  const data = context["data"];
  if (!(data instanceof CelDataNamespace)) return undefined;
  const args = (argNodes as ASTNode[]).map((arg) =>
    selectorValue(arg, context)
  );
  if (!args.every((arg) => typeof arg === "string")) return undefined;
  if (!data.emptySetReads.has(setReadKey(name, args))) return undefined;
  return `data.${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;
}

const UNKNOWN_SELECTOR = Symbol("unknown selector");
// Standard CEL and arithmetic only: no swamp namespace or extension functions.
const selectorEnvironment = createExtensionCelEnvironment();

/** Read only data properties: a diagnostic must never invoke a binding getter. */
function ownBinding(value: unknown, key: unknown): unknown {
  if (value === null || typeof value !== "object") return UNKNOWN_SELECTOR;
  if (
    typeof key !== "string" && typeof key !== "number" &&
    typeof key !== "bigint"
  ) {
    return UNKNOWN_SELECTOR;
  }
  const property = Object.getOwnPropertyDescriptor(value, String(key));
  return property && "value" in property ? property.value : UNKNOWN_SELECTOR;
}

/** Snapshot plain selector data, refusing getters, functions and opaque values. */
function selectorData(value: unknown, seen = new Set<object>()): unknown {
  if (
    value === null || value === undefined ||
    ["string", "boolean", "number", "bigint"].includes(typeof value)
  ) return value;
  if (typeof value !== "object" || seen.has(value)) return UNKNOWN_SELECTOR;
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) && prototype !== Object.prototype &&
    prototype !== null
  ) return UNKNOWN_SELECTOR;
  seen.add(value);
  try {
    const copy: object = Array.isArray(value)
      ? new Array(value.length)
      : Object.create(null);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !("value" in property)) return UNKNOWN_SELECTOR;
      const item = selectorData(property.value, seen);
      if (item === UNKNOWN_SELECTOR) return UNKNOWN_SELECTOR;
      Object.defineProperty(copy, key, {
        value: item,
        enumerable: property.enumerable,
      });
    }
    return copy;
  } finally {
    seen.delete(value);
  }
}

function pureSelectorValue(
  node: ASTNode,
  context: Record<string, unknown>,
): unknown {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isAstNode(value)) {
      if (value.op === "id") names.add(value.args);
      else if (value.op !== "value") visit(value.args);
    }
  };
  visit(node);
  const bindings: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(context, name);
    // A macro's local variable need not be a root binding.
    if (!property) continue;
    if (!("value" in property)) return UNKNOWN_SELECTOR;
    const value = selectorData(property.value);
    if (value === UNKNOWN_SELECTOR) return UNKNOWN_SELECTOR;
    Object.defineProperty(bindings, name, { value, enumerable: true });
  }
  try {
    return selectorEnvironment.evaluate(
      node.input.slice(node.start, node.end),
      bindings,
    );
  } catch {
    return UNKNOWN_SELECTOR;
  }
}

function selectorValue(
  node: ASTNode,
  context: Record<string, unknown>,
): unknown {
  const selected = selectedNode(node, context);
  if (!selected) return UNKNOWN_SELECTOR;
  if (selected !== node) return selectorValue(selected, context);
  switch (node.op) {
    case "value":
      return node.args;
    case "id":
      return ownBinding(context, node.args);
    case ".":
    case "[]":
      return ownBinding(
        selectorValue(node.args[0], context),
        node.op === "." ? node.args[1] : selectorValue(node.args[1], context),
      );
    default:
      return pureSelectorValue(node, context);
  }
}

/** cel-js stores literal map entries as object properties, coercing scalar keys. */
function mapSelectorKey(value: unknown): string | undefined {
  return value === null ||
      ["string", "number", "bigint", "boolean"].includes(typeof value)
    ? String(value)
    : undefined;
}

function selectedNode(
  node: ASTNode,
  context: Record<string, unknown>,
): ASTNode | undefined {
  if (node.op === "?:") {
    const condition = selectorValue(node.args[0], context);
    return typeof condition === "boolean"
      ? selectedNode(node.args[condition ? 1 : 2], context)
      : undefined;
  }
  if (node.op !== "." && node.op !== "[]") return node;
  const container = selectedNode(node.args[0], context);
  if (!container) return undefined;
  const key = node.op === "."
    ? node.args[1]
    : selectorValue(node.args[1], context);
  if (container.op === "list") {
    if (typeof key !== "bigint" && typeof key !== "number") return undefined;
    const index = Number(key);
    if (
      !Number.isSafeInteger(index) || index < 0 ||
      index >= container.args.length
    ) {
      return undefined;
    }
    return selectedNode(container.args[index], context);
  }
  if (container.op === "map") {
    const selectedKey = mapSelectorKey(key);
    // cel-js omits these entries when constructing literal maps.
    if (
      selectedKey === undefined ||
      ["__proto__", "constructor", "prototype"].includes(selectedKey)
    ) return undefined;
    // CEL keeps the last value of a repeated key. An unknown later key could
    // overwrite an earlier match, so it cannot establish a lookup's origin.
    for (let index = container.args.length - 1; index >= 0; index--) {
      const [entryKey, value] = container.args[index];
      const candidate = mapSelectorKey(selectorValue(entryKey, context));
      if (candidate === undefined) return undefined;
      if (candidate === selectedKey) return selectedNode(value, context);
    }
    return undefined;
  }
  return node;
}

function isAstNode(value: unknown): value is ASTNode {
  return typeof value === "object" && value !== null && "op" in value &&
    "args" in value;
}

/**
 * a record's version reaches CEL as a double, so data.version() accepts a
 * double; only a whole one can name a version
 */
function requireWholeVersion(
  modelName: string,
  dataName: string,
  version: unknown,
): void {
  const value = Number(version);
  if (Number.isInteger(value)) return;
  throw new Error(
    `data.version("${modelName}", "${dataName}", ${value}): the version must be a whole number`,
  );
}

export class CelDataNamespace {
  private readonly delegate: Record<string, unknown>;
  /**
   * a null lookup is supported (guards use it as a presence test), so misses
   * are recorded rather than thrown, and used to explain the No such key a
   * non-optional select raises
   */
  readonly missedLookups: string[] = [];
  /**
   * Set reads (`findBySpec`, `findByTag`, `query`) that answered no record,
   * keyed by {@link setReadKey}. An index into one is upstream data not
   * produced yet, as a select on a missed `data.latest` is.
   */
  readonly emptySetReads = new Set<string>();
  private readonly specNameCandidates: SpecNameCandidate[] = [];

  constructor(delegate: Record<string, unknown>) {
    this.delegate = delegate;
  }

  clearMissedLookups(): void {
    this.missedLookups.length = 0;
    this.emptySetReads.clear();
    this.specNameCandidates.length = 0;
  }

  private recordEmpty(
    result: unknown,
    accessor: SetReadAccessor,
    args: unknown[],
  ): unknown {
    const empty = (value: unknown) => {
      if (Array.isArray(value) && value.length === 0) {
        this.emptySetReads.add(setReadKey(accessor, args));
      }
    };
    if (result instanceof Promise) {
      return result.then((value) => {
        empty(value);
        return value;
      });
    }
    empty(result);
    return result;
  }

  get reader(): NamespaceReader {
    const namespace = this.delegate["namespace"];
    return {
      namespace: typeof namespace === "string" ? namespace : "",
      readsSoloNamespace: this.delegate["readsSoloNamespace"] === true,
    };
  }

  /**
   * delegates return a value or a Promise; the Promise arm returns the derived
   * promise so the miss is recorded before cel-js selects a field off the
   * result
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
   * data.latest and data.version take the data instance name, often not the
   * spec name; only called on the error path, so the lookup costs nothing when
   * an expression succeeds
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
      if (Array.isArray(versionOrVary)) {
        requireWholeVersion(modelName, dataName, version);
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
      requireWholeVersion(modelName, dataName, versionOrVary);
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
      return this.recordEmpty(
        (fn as (k: string, v: string) => unknown)(tagKey, tagValue),
        "findByTag",
        [tagKey, tagValue],
      );
    }
    return [];
  }

  findBySpec(modelName: string, specName: string): unknown {
    const fn = this.delegate["findBySpec"];
    if (typeof fn === "function") {
      return this.recordEmpty(
        (fn as (m: string, s: string) => unknown)(modelName, specName),
        "findBySpec",
        [modelName, specName],
      );
    }
    return [];
  }

  query(predicate: string, select?: string, view?: QueryView): unknown {
    const fn = this.delegate["query"];
    if (typeof fn === "function") {
      return this.recordEmpty(
        (fn as (pred: string, sel?: string, view?: QueryView) => unknown)(
          predicate,
          select,
          view,
        ),
        "query",
        select === undefined ? [predicate] : [predicate, select],
      );
    }
    return [];
  }
}

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
 * the returned Environment omits swamp's internal namespace types; callers may
 * register their own functions, types and operators on it
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
export { coerceBigInts };

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
 * a synchronous pass calls it per expression it is about to evaluate, since it
 * cannot wait on what the expression reads
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

export interface EvaluationScope {
  /**
   * with typed secrets on, sentinels the bag issued read as a Secret, and a
   * Secret result leaves as a sentinel issued into it
   */
  readonly secretBag?: VaultSecretBag;
  /** Required for direct typed vault calls; checks use the run's services. */
  readonly vault?: VaultEvaluationScope;
  /** Built only when a direct vault call or sensitive-field read needs it. */
  readonly getVault?: () => Promise<VaultEvaluationScope>;
  /**
   * refuse is the guard/assert destination: a result holding a secret anywhere
   * is refused with secret_destination_refused before anything reads it, while
   * bindings still read sentinels as Secrets
   */
  readonly secretResult?: "release" | "refuse";
  /**
   * references a synchronous evaluation may read; evaluate accepts a recorded
   * reference in this set and fails closed on any other, or when there is no
   * set
   */
  readonly authorizedReferences?: ReadonlySet<string>;
  /**
   * references that could not be authorized, with the error raised; a
   * synchronous evaluate that reads one fails with it before release issues a
   * sentinel, and unread ones cost nothing
   */
  readonly deniedReferences?: ReadonlyMap<string, unknown>;
}

export function createInternalCelEnvironment(): Environment {
  return buildInternalEnvironment("evaluate");
}

/**
 * check is a type-check environment nothing evaluates: Secret type, receiver
 * and allowed set with no refusal, vault bound as a receiver variable, so a
 * check rejects other operations on a vault.get result
 */
type SecretMode = "evaluate" | "check";

/** built here so the Secret modules stay inside the adapter */
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
  // with typed secrets on, own-namespace records are read as stored and tagged
  // fields become data-origin Secrets; gated on the option so a reused
  // namespace instance is adapted too
  const fromAccessor: (
    receiver: CelDataNamespace,
    result: unknown,
    accessor: DataAccessor,
  ) => unknown = typed
    ? (receiver, result, accessor) =>
      adaptDataResult(result, receiver.reader, accessor)
    : (_receiver, result) => result;
  const readOptions: DataReadOptions | undefined = typed
    ? { sensitiveFields: "stored" }
    : undefined;
  // bound per call to the receiver's reader: the one identity that decides the
  // own-namespace check for rows a predicate reads and for records fromAccessor
  // adapts afterwards
  const queryView: (receiver: CelDataNamespace) => QueryView | undefined = typed
    ? (receiver) => expressionQueryView(receiver.reader)
    : () => undefined;

  env.registerType("CelFileNamespace", CelFileNamespace);
  env.registerType("CelDataNamespace", CelDataNamespace);
  env.registerType("CelWorkersNamespace", CelWorkersNamespace);
  env.registerType("CelModelNamespace", CelModelNamespace);

  // literal('...') returns its string unchanged, so one value can mix a
  // swamp expression with another service's template text:
  // `${{ inputs.env }} on ${{ literal('{{host.name}}') }}`.
  env.registerFunction(LITERAL_FUNCTION_SIGNATURE, literal);

  env.registerFunction(
    "CelFileNamespace.contents(string, string): dyn",
    (receiver: CelFileNamespace, modelName: string, specName: string) =>
      receiver.contents(modelName, specName),
  );

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

  // A record's version is a double, so data.latest(...).version - 1 and the
  // elements of data.listVersions() reach data.version as doubles.
  env.registerFunction(
    "CelDataNamespace.version(string, string, double): dyn",
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
    "CelDataNamespace.version(string, string, list<dyn>, double): dyn",
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

  // data.query records are adapted like every other accessor's; a projection
  // answers as the view post-processed it, and an empty-string select answers
  // records, adapted the same way
  env.registerFunction(
    "CelDataNamespace.query(string): dyn",
    (receiver: CelDataNamespace, predicate: string) =>
      fromAccessor(
        receiver,
        receiver.query(predicate, undefined, queryView(receiver)),
        "data.query",
      ),
  );

  env.registerFunction(
    "CelDataNamespace.query(string, string): dyn",
    (receiver: CelDataNamespace, predicate: string, select: string) =>
      select
        ? receiver.query(predicate, select, queryView(receiver))
        : fromAccessor(
          receiver,
          receiver.query(predicate, select, queryView(receiver)),
          "data.query",
        ),
  );

  env.registerFunction(
    "CelWorkersNamespace.connected(): dyn",
    (receiver: CelWorkersNamespace) => receiver.connected(),
  );

  // model.method is effectful: with typed secrets on, the gate runs before any
  // delegate work, inputs go through the boundary into the run's bag, and the
  // returned record is adapted so tagged fields are Secrets
  const gate: () => void = typed ? gateModelMethodEffect : () => {};
  // ints are delivered as numbers on both paths
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
      // model and method names are routing arguments: a Secret there is refused
      // as a destination
      codeFor: (signature) =>
        signature.startsWith("CelModelNamespace.method(")
          ? SECRET_DESTINATION_REFUSED
          : undefined,
    });
  }
  return env;
}

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
 * refuse on a recorded fault, or a container comparison after a secret was
 * read, so an absorbed refusal never starts an effect that short-circuit would
 * have skipped; fails closed outside an evaluation
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
 * plain copy with each Secret released as a sentinel of the run's bag, so no
 * Secret reaches the delegate; with no bag, a Secret is refused as a
 * destination and the rest copied plain
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
 * a rejected adaptation is a refusal cel-js observes on await; the Promise is
 * also marked handled so an abandoned evaluation leaves no unobserved rejection
 */
function adaptModelMethodResultDeep(result: unknown): unknown {
  if (result instanceof Promise) {
    const adapted = result.then(adaptModelMethodResultDeep);
    adapted.catch(() => {});
    return adapted;
  }
  return adaptModelMethodResult(result);
}

interface SecretEvaluation {
  readonly evaluate: () => unknown;
  readonly analysis: VaultCallAnalysis;
  readonly bindings: Record<string, unknown>;
  readonly containerComparison: boolean;
  readonly boundary?: SecretBoundary;
  readonly refusesSecretResult: boolean;
}

const PREDICATE_RESULT =
  "a guard or assert predicate result that holds a secret";

export class CelEvaluator {
  private readonly env: Environment;
  private readonly warnedPatterns = new Set<string>();
  constructor() {
    this.env = createInternalCelEnvironment();
  }

  evaluate(
    expression: string,
    context: Record<string, unknown>,
    scope: EvaluationScope = {},
  ): unknown {
    return this.evaluateWithSecrets(expression, context, scope);
  }

  /**
   * cel-js propagates Promises through operators and macros; use this for
   * expressions calling async data functions, and sync evaluate() where none
   * are involved
   */
  async evaluateAsync(
    expression: string,
    context: Record<string, unknown>,
    scope: EvaluationScope = {},
  ): Promise<unknown> {
    return await this.evaluateWithSecretsAsync(expression, context, scope);
  }

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
      // authorization is async, so a record with tagged fields cannot be read
      // here; read the result as release does so an unselected record is
      // adapted and refused before release issues a sentinel
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
   * fails closed on a sensitive-field reference that prepareSynchronousReads
   * did not authorize: the sync path only accepts what was authorized ahead of
   * it, so unseen ones name evaluateAsync
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
   * authorizes sensitive-field references of records the expressions read
   * synchronously under the run's vault access; a failed check is kept per
   * reference and fails only an evaluation that reads that record
   */
  async prepareSynchronousReads(
    content: unknown,
    context: Record<string, unknown>,
    scope: EvaluationScope = {},
  ): Promise<EvaluationScope> {
    await prepareExpressionsIn(content, context);
    const authorized = new Set(scope.authorizedReferences ?? []);
    const denied = new Map(scope.deniedReferences ?? []);
    let changed = false;
    const seen = new Set<string>();
    const wrappedContext = this.wrapNamespaces(context);
    const data = wrappedContext["data"];
    const reader = data instanceof CelDataNamespace ? data.reader : undefined;
    for (const expr of extractExpressions(content)) {
      if (seen.has(expr.celExpression)) continue;
      seen.add(expr.celExpression);
      const references = synchronousSensitiveReferences(
        expr.celExpression,
        wrappedContext["model"],
        reader,
        wrappedContext["steps"],
      );
      for (const reference of references) {
        const key = sensitiveReferenceKey(reference);
        if (authorized.has(key) || denied.has(key)) continue;
        changed = true;
        try {
          const vault = scope.vault ?? await scope.getVault?.();
          if (vault === undefined) {
            denied.set(
              key,
              new Error(
                "a record with sensitive fields requires the run's vault check scope",
              ),
            );
            continue;
          }
          await vault.service.authorizeRead(
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
        if (analysis.calls.length > 0 && scope.vault === undefined) {
          checking = true;
          scope = { ...scope, vault: await scope.getVault?.() };
          checking = false;
        }
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
   * authorizes every sensitive-field reference of the evaluation's records,
   * selected or not, before the result is used; a policy decision only, no
   * existence check or load; a missing scope fails closed
   */
  private async authorizeSensitiveReferences(
    faults: FaultScope,
    scope: EvaluationScope,
    expression: string,
    wrappedContext: Record<string, unknown>,
  ): Promise<void> {
    if (faults.sensitiveReferences.size === 0) return;
    let vault: VaultEvaluationScope | undefined;
    try {
      vault = scope.vault ?? await scope.getVault?.();
    } catch (error) {
      throw this.evaluationError(error, expression, wrappedContext);
    }
    if (vault === undefined) {
      throw new InvalidExpressionError(
        "a record with sensitive fields requires the run's vault check scope",
        expression,
      );
    }
    for (const reference of faults.sensitiveReferences.values()) {
      try {
        await vault.service.authorizeRead(
          reference.vaultName,
          reference.key,
        );
      } catch (error) {
        throw this.evaluationError(error, expression, wrappedContext);
      }
    }
  }

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
   * replaces the model and steps maps with lazy views so tagged fields read as
   * Secrets; the copy leaves the caller's context untouched
   */
  private withModelView(
    wrappedContext: Record<string, unknown>,
  ): Record<string, unknown> {
    const model = wrappedContext["model"];
    const steps = wrappedContext["steps"];
    const data = wrappedContext["data"];
    const reader = data instanceof CelDataNamespace ? data.reader : undefined;
    const modelView = modelMapView(model, reader);
    const stepsMapView = stepsView(steps, reader);
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
   * fails on what the fault scope recorded whatever cel-js answered: an
   * unreadable binding, a refusal (the first decides the code), or a container
   * comparison in an expression that read a secret
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
   * release also reads a record returned unselected, so a record the accessor
   * adapter refuses keeps its code; with no bag to issue into, a Secret result
   * is refused
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
    if (isMissingRunBinding(error)) {
      return new UnboundExpressionError(
        `A run input or environment binding is missing in ${expression}`,
        expression,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    const emptySetRead = indexedEmptySetRead(error, wrappedContext);
    if (emptySetRead !== undefined) {
      return new MissingModelDataError(
        `${message}\n\n${emptySetRead} found no data record — check the ` +
          `names, or test its size() if no record may exist yet.`,
        expression,
        undefined,
        error instanceof Error ? error : undefined,
      );
    }
    const explained = this.explainMissedLookups(message, wrappedContext);
    // a select on a lookup that found no record is upstream data not produced
    // yet, which validation tolerates; recognized by the failing select itself,
    // so a miss elsewhere does not excuse an unrelated select
    const Failure = explained !== message &&
        selectsDataLookup(error, wrappedContext)
      ? MissingModelDataError
      : InvalidExpressionError;
    return new Failure(
      explained,
      expression,
      undefined,
      error instanceof Error ? error : undefined,
    );
  }

  /**
   * parses the same text evaluation does, with hyphenated model refs rewritten,
   * so an expression that evaluates is never reported invalid
   */
  validate(expression: string): ValidationResult {
    try {
      // Attempt to parse the expression — ParseResult is callable, not a
      // success/error union.  If parse() doesn't throw, the syntax is valid.
      const analysis = analyzeVaultCalls(expression);
      assertDirectVaultCalls(analysis, expression);
      this.env.parse(analysis.source.text);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

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
   * a non-optional select off a null lookup raises a generic No such key that
   * hides the cause; the hint goes below cel-js's source snippet so the caret
   * survives, gated on the key being a DataRecord field
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
