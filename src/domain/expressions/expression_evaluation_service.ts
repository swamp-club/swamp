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

import type { ModelType } from "../models/model_type.ts";
import { SecretDestinationRefusedError } from "../models/secret_destinations.ts";
import type { Definition } from "../definitions/definition.ts";
import { Definition as DefinitionClass } from "../definitions/definition.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  CelEvaluator,
  type EvaluationScope,
} from "../../infrastructure/cel/cel_evaluator.ts";
import type {
  CelExpressionEvaluator,
  CelExpressionValidator,
} from "./cel_runtime.ts";
import { firstRejection } from "./expression_rejection_report.ts";
import {
  AUTHORED_ORIGIN,
  containsExpression,
  extractCelExpression,
  extractExpressions,
  replaceExpressions,
  replaceExpressionsTracked,
  type SpliceOrigin,
  type SpliceSanitizer,
  type TrackedSplice,
} from "./expression_parser.ts";
import { sensitiveValuesOf } from "./sensitive_context.ts";
import { fromPersistedStepContexts } from "./step_output_sources.ts";
import {
  isDeliveredWithMethod,
  isOutsideMethodDelivery,
  sensitiveSpliceSanitizer,
  type SplicePair,
} from "./splice_pair.ts";
import { definitionDescriptionPaths } from "./description_paths.ts";
import { getLogger } from "@logtape/logtape";
import { type ASTNode, parse as parseCel } from "cel-js";
import type { ExpressionLocation } from "./expression.ts";
import {
  extractModelRefs,
  requiresModelNamespace,
} from "./dependency_extractor.ts";
import {
  buildEnvContext,
  type ExpressionContext,
  ModelResolver,
  type ModelResolverRepositories,
} from "./model_resolver.ts";
import { CyclicDependencyError } from "./errors.ts";
import {
  AUTHORED_DEFINITION,
  type DefinitionPassProvenance,
  evaluateDefinitionExpressions,
} from "./definition_expression_pass.ts";
import { ProvenanceMap } from "./provenance_map.ts";
import {
  failedOnForeignRoot,
  isForeignExpression,
  unlistedForeignRootError,
} from "./swamp_namespaces.ts";
import {
  attachBindingProvenance,
  bindingProvenanceOf,
  spliceOrigin,
} from "./splice_origin.ts";
import { BINDING_MACROS, freeRoots } from "./cel_grammar.ts";
import {
  lexSegments,
  maskLiteralCalls,
  stripStringLiterals,
} from "./cel_string_lexer.ts";
import { analyzeVaultCalls } from "./vault_call_syntax.ts";
import type { FailedExpressions } from "./unresolved_expression_guard.ts";
import type {
  RunSensitiveValues,
  SecretRedactor,
  UnreadReferenceLookup,
} from "../secrets/mod.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { secretOccurrencesOf } from "../vaults/secret_occurrences.ts";
import type { SecretLoader } from "../vaults/secret_loader.ts";
import type { ProbeRedactor } from "../vaults/secret_reference_check.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  findVaultGetCalls,
  isDynamicVaultArgument,
} from "./vault_reference_extractor.ts";
import {
  CyclicDependencyError as TopoCyclicError,
  type GraphNode,
  TopologicalSortService,
} from "../workflows/topological_sort_service.ts";

import {
  captureDeferredBindings,
  type DeferredExpression,
  deferredExpressionReference,
  isDeferredExpression,
} from "./deferred_expression.ts";

const VAULT_PATTERN = /(?<![.\w])vault\b/;

/**
 * every form of env must be classified as runtime, or it would be evaluated in
 * the persist phase, where the context also carries the process environment
 */
const ENV_PATTERN = /(?<![.\w])env\b/;

/**
 * a view of the run's registry when the context carries the run's sensitive
 * values, otherwise a registry of its own for paths with no run, such as
 * validate pre-flight checks
 */
function bagFor(context: ExpressionContext | undefined): VaultSecretBag {
  return new VaultSecretBag(
    sensitiveValuesOf(context)?.sentinels ?? new SecretBagRegistry(),
  );
}

/**
 * a routing destination sees references only; check even literal text, as an
 * earlier pass may have issued its sentinel; keys are checked before entering
 * them so no sentinel becomes an error path
 */
function refuseRoutingSecrets(
  value: unknown,
  registry: SecretBagRegistry,
  destination: string,
  location: string,
): void {
  const secrets = secretOccurrencesOf(registry);
  const seen = new WeakSet<object>();
  const text = (value: string, at: string): void => {
    const occurrence = secrets.occurrencesIn(value)[0];
    if (occurrence) {
      throw new SecretDestinationRefusedError(
        destination,
        occurrence.reference,
        at,
        "routing values must not contain secrets",
      );
    }
  };
  const visit = (value: unknown, at: string): void => {
    if (typeof value === "string") return text(value, at);
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      text(key, at);
      visit(item, at ? `${at}.${key}` : key);
    }
  };
  visit(value, location);
}

/**
 * Walks a parsed CEL tree looking for a reference to the root `env`
 * identifier, skipping identifiers shadowed by a macro-bound variable so that
 * `list.map(env, env)` is not mistaken for an environment access.
 */
function astReferencesEnv(node: ASTNode, bound: ReadonlySet<string>): boolean {
  switch (node.op) {
    case "value":
      return false;
    case "id":
      return node.args === "env" && !bound.has("env");
    case ".":
    case ".?":
      return astReferencesEnv(node.args[0], bound);
    case "!_":
    case "-_":
      return astReferencesEnv(node.args, bound);
    case "list":
      return node.args.some((a) => astReferencesEnv(a, bound));
    case "map":
      return node.args.some(([k, v]) =>
        astReferencesEnv(k, bound) || astReferencesEnv(v, bound)
      );
    case "call":
      return node.args[1].some((a) => astReferencesEnv(a, bound));
    case "rcall": {
      const [name, receiver, args] = node.args;
      if (astReferencesEnv(receiver, bound)) return true;
      const first = args[0];
      if (
        name === "bind" && receiver.op === "id" && receiver.args === "cel" &&
        args.length === 3 && first?.op === "id"
      ) {
        return astReferencesEnv(args[1], bound) ||
          astReferencesEnv(args[2], new Set(bound).add(first.args));
      }
      if (BINDING_MACROS.has(name) && first?.op === "id") {
        const inner = new Set(bound).add(first.args);
        return args.slice(1).some((a) => astReferencesEnv(a, inner));
      }
      return args.some((a) => astReferencesEnv(a, bound));
    }
    default:
      return (node.args as ASTNode[]).some((a) => astReferencesEnv(a, bound));
  }
}

/**
 * decided on the parsed tree so text inside a string literal never counts; when
 * the text does not parse a conservative textual scan stands in, so an error
 * can only defer to runtime
 */
export function containsVaultExpression(celExpression: string): boolean {
  const roots = freeRoots(celExpression);
  if (roots !== undefined) return roots.has("vault");
  return VAULT_PATTERN.test(stripStringLiterals(celExpression));
}

export function containsEnvExpression(celExpression: string): boolean {
  try {
    return astReferencesEnv(parseCel(celExpression).ast, new Set());
  } catch {
    // cel-js rejects some syntax the evaluator accepts (optional `.?` access);
    // the textual scan is conservative, so an error can only defer to runtime.
    return ENV_PATTERN.test(stripStringLiterals(celExpression));
  }
}

export function containsRuntimeExpression(celExpression: string): boolean {
  return isDeferredExpression(celExpression) ||
    containsVaultExpression(celExpression) ||
    containsEnvExpression(celExpression);
}

/**
 * later passes re-parse spliced data as CEL, so without this set a data string
 * holding vault.get or env text would resolve a secret; pass the pre-CEL
 * source's set, and spell out unrestricted explicitly
 */
export type AuthoredExpressions =
  | ReadonlySet<string>
  | "unrestricted";

/**
 * call on author-written source before any CEL evaluation; keyed on raw text
 * because substitution can replace a whole subtree at a path and workflow paths
 * do not map onto definition paths
 */
export function collectAuthoredExpressions(
  data: unknown,
  into: Set<string> = new Set(),
): Set<string> {
  for (const expr of extractExpressions(data)) {
    into.add(expr.raw);
  }
  return into;
}

function referencedBindingPaths(cel: string): string[] {
  // A literal() argument is text, so it reads no binding.
  return [
    ...maskLiteralCalls(cel).matchAll(
      /\b(inputs|self|run|steps)((?:\.[A-Za-z0-9_]+|\[\d+\])*)/g,
    ),
  ]
    .map((m) => m[1] + m[2]);
}

function overlaps(a: string, b: string): boolean {
  const under = (path: string, root: string) =>
    path === root || path.startsWith(root + ".") ||
    path.startsWith(root + "[");
  return under(a, b) || under(b, a);
}

let constantEvaluator: CelEvaluator | undefined;

interface ConstantOutputs {
  byConstant: Map<string, Set<string>>;
  all: Set<string>;
}

const constantOutputCache = new WeakMap<
  ReadonlySet<string>,
  ConstantOutputs
>();

/**
 * a constant reads no binding, so its output is text the author wrote on
 * purpose and a later refusing pass has nothing to report; derived only from
 * authored, which data cannot extend
 */
function constantOutputs(authored: ReadonlySet<string>): ConstantOutputs {
  const cached = constantOutputCache.get(authored);
  if (cached) return cached;
  const outputs: ConstantOutputs = { byConstant: new Map(), all: new Set() };
  for (const raw of authored) {
    const cel = extractCelExpression(raw);
    if (cel === null || freeRoots(cel)?.size !== 0) continue;
    let value: unknown;
    try {
      constantEvaluator ??= new CelEvaluator();
      value = constantEvaluator.evaluate(cel, {});
    } catch {
      continue;
    }
    const produced = new Set(extractExpressions(value).map((e) => e.raw));
    if (produced.size === 0) continue;
    outputs.byConstant.set(raw, produced);
    for (const output of produced) outputs.all.add(output);
  }
  constantOutputCache.set(authored, outputs);
  return outputs;
}

/**
 * a nested workflow inherits these from its parent so the child also recognises
 * literal() output as the parent author's text; evaluating a constant reads no
 * binding, so inheriting grants no access
 */
export function authoredConstantsProducing(
  authored: ReadonlySet<string>,
  raws: Iterable<string>,
): Set<string> {
  const wanted = new Set(raws);
  const constants = new Set<string>();
  for (const [constant, produced] of constantOutputs(authored).byConstant) {
    if ([...produced].some((raw) => wanted.has(raw))) {
      constants.add(constant);
    }
  }
  return constants;
}

/**
 * not worth a warning when the text is another templating system's or an
 * authored constant produced it, and only the first time the step's rejection
 * report sees it
 */
function reportsRefusal(
  expr: ExpressionLocation,
  authored: AuthoredExpressions,
): boolean {
  if (isForeignExpression(expr.celExpression)) return false;
  if (
    authored !== "unrestricted" && constantOutputs(authored).all.has(expr.raw)
  ) return false;
  return firstRejection(expr.raw);
}

/**
 * the raw expression text is logged because it is the reference, never a
 * resolved value: nothing has been evaluated at this point
 */
export function partitionAuthored(
  expressions: ExpressionLocation[],
  authored: AuthoredExpressions,
  unread?: UnreadReferenceLookup,
): ExpressionLocation[] {
  if (authored === "unrestricted") {
    return expressions;
  }
  const allowed: ExpressionLocation[] = [];
  for (const expr of expressions) {
    if (authored.has(expr.raw)) {
      allowed.push(expr);
      continue;
    }
    if (!reportsRefusal(expr, authored)) continue;
    if (warnedUnread(expr, unread)) continue;
    getLogger(["swamp", "expressions"])
      .warn`Refusing to evaluate expression at ${expr.path}: it was not written in the definition or workflow source, so it arrived as data content. Left as literal text. Raw: ${expr.raw}`;
  }
  return allowed;
}

/**
 * warns in place of the data-content warning when a refused expression is the
 * stored reference of a sensitive field whose vault read failed in this run;
 * the text is refused either way
 */
function warnedUnread(
  expr: ExpressionLocation,
  unread: UnreadReferenceLookup | undefined,
): boolean {
  const reference = unread?.unreadReferenceFor(expr.raw);
  if (!reference) return false;
  getLogger(["swamp", "expressions"])
    .warn`Could not read sensitive field ${reference.fieldPath} at ${expr.path} from vault ${reference.vaultName} (key ${reference.key}): ${reference.reason}. Left as its stored reference.`;
  return true;
}

/**
 * drops every occurrence overlapping data in provenance: expression text that
 * arrived as data never evaluates, even when its raw text matches an authored
 * expression
 */
export function partitionAuthoredAt(
  expressions: ExpressionLocation[],
  authored: AuthoredExpressions,
  provenance: ProvenanceMap,
  unread?: UnreadReferenceLookup,
): ExpressionLocation[] {
  const allowed = partitionAuthored(expressions, authored, unread);
  if (provenance.isAuthored) return allowed;
  return allowed.filter((expr) => {
    const inData = expr.start === undefined || expr.end === undefined
      ? provenance.hasDataAtOrBelow(expr.path)
      : provenance.overlapsData(expr.path, expr.start, expr.end);
    if (
      inData && reportsRefusal(expr, authored) && !warnedUnread(expr, unread)
    ) {
      getLogger(["swamp", "expressions"])
        .warn`Refusing to evaluate expression at ${expr.path}: it sits in data content, not in the definition or workflow source. Left as literal text. Raw: ${expr.raw}`;
    }
    return !inData;
  });
}

function bindingTreeProvenance(context: ExpressionContext): ProvenanceMap {
  const bindings = bindingProvenanceOf(context);
  return ProvenanceMap.authored()
    .graft("inputs", bindings.inputs ?? ProvenanceMap.authored())
    .graft("self", bindings.self ?? ProvenanceMap.authored())
    .graft("run", bindings.run ?? ProvenanceMap.authored())
    .withWholeData("steps");
}

/** older records carry no provenance and keep their earlier behaviour */
function deferredBindingsProvenance(record: DeferredExpression): ProvenanceMap {
  return record.provenance === undefined
    ? ProvenanceMap.authored()
    : ProvenanceMap.fromData(record.provenance);
}

export interface RuntimeResolutionResult {
  definition: Definition;
  secretBag: VaultSecretBag;
  failedExpressions?: FailedExpressions;
  /**
   * the incoming provenance carried through plus each runtime splice's origin,
   * so an env.X value or deferred data read is data where it landed; offsets
   * index definition, sentinels included
   */
  provenance: ProvenanceMap;
}

interface UnevaluatedPolicy {
  keep: (error: unknown, expression: ExpressionLocation) => boolean;
  into: Map<string, Error>;
}

interface RuntimePassOptions {
  skipPath?: (path: string) => boolean;
  unevaluated?: UnevaluatedPolicy;
}

export interface EvaluatedDefinition {
  definition: Definition;
  type: ModelType;
  authoredExpressions: ReadonlySet<string>;
  hadExpressions: boolean;
  failedExpressions?: FailedExpressions;
  /**
   * present only when a bag was given; definition keeps real values for
   * caching, reports and self.globalArguments
   */
  sanitizedDefinition?: Definition;
  /**
   * Where data sits in `definition`'s data. Absent means nothing in it is
   * data, as for a definition evaluated straight from source.
   */
  provenance?: ProvenanceMap;
  sanitizedProvenance?: ProvenanceMap;
  /**
   * The definition as it was before evaluation. Its expression paths are the
   * positions a persisted evaluation must treat as values.
   */
  sourceDefinition?: Definition;
}

/**
 * only a step's task inputs pass foreign text through; everything else a
 * step-time pass covers (placement, say) must be resolved by swamp
 */
export type ForeignTextRule = "fail" | "passThrough";

export interface PassEvaluatorOptions {
  readonly secretBag?: VaultSecretBag;
  readonly location: string;
  /**
   * The predicate destination of a guard or assert: a result that holds a
   * secret is refused instead of leaving as a sentinel.
   */
  readonly secretResult?: "refuse";
  readonly destination?: string;
}

export interface PassEvaluator
  extends CelExpressionEvaluator, CelExpressionValidator {
  /** call it before evaluate; evaluateAsync prepares and authorizes for itself */
  prepare(content: unknown, context: Record<string, unknown>): Promise<void>;
}

export class ExpressionEvaluationService {
  private readonly celEvaluator: CelEvaluator;
  private readonly sortService: TopologicalSortService;
  private readonly modelResolver: ModelResolver;
  private readonly definitionRepo: YamlDefinitionRepository;

  constructor(
    definitionRepo: YamlDefinitionRepository,
    repoDir?: string,
    repos?: ModelResolverRepositories,
  ) {
    this.celEvaluator = new CelEvaluator();
    this.sortService = new TopologicalSortService();
    this.definitionRepo = definitionRepo;
    this.modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      ...repos,
    });
  }

  /**
   * loading every model definition is only needed when the workflow reads the
   * model or file namespaces
   */
  buildEvaluationContext(
    needsModelNamespace: boolean,
    sensitiveValues: RunSensitiveValues,
  ): Promise<ExpressionContext> {
    return needsModelNamespace
      ? this.modelResolver.buildContext(sensitiveValues)
      : Promise.resolve(this.modelResolver.buildLightContext(sensitiveValues));
  }

  private scopeFor(
    secretBag: VaultSecretBag,
    location: string,
    redactor: ProbeRedactor | undefined,
  ): EvaluationScope {
    let vault: ReturnType<ModelResolver["vaultEvaluationScope"]> | undefined;
    return {
      secretBag,
      // A rejected scope is not kept: the next read in the pass asks again,
      // so a transient failure building the vault service fails one read.
      getVault: () =>
        vault ??= this.modelResolver.vaultEvaluationScope(location, redactor)
          .catch((error) => {
            vault = undefined;
            throw error;
          }),
    };
  }

  /**
   * synchronous passes prepare authorization for their own reads; authorization
   * never carries from one pass to another
   */
  passEvaluatorFor(
    sensitiveValues: RunSensitiveValues | undefined,
    options: PassEvaluatorOptions,
  ): PassEvaluator {
    const registry = options.secretBag?.registry ??
      sensitiveValues?.sentinels ??
      new SecretBagRegistry();
    const evaluator = this.celEvaluator;
    let scope: EvaluationScope = {
      ...this.scopeFor(
        options.secretBag ?? new VaultSecretBag(registry),
        options.location,
        sensitiveValues?.probeRedactor,
      ),
      ...(options.secretResult === undefined
        ? {}
        : { secretResult: options.secretResult }),
    };
    const routed = (value: unknown): unknown => {
      if (options.destination !== undefined) {
        refuseRoutingSecrets(
          value,
          registry,
          options.destination,
          options.location,
        );
      }
      return value;
    };
    return {
      evaluate: (expression, context) =>
        routed(evaluator.evaluate(expression, context, scope)),
      evaluateAsync: async (expression, context) =>
        routed(await evaluator.evaluateAsync(expression, context, scope)),
      validate: (expression) => evaluator.validate(expression),
      prepare: async (content, context) => {
        scope = await evaluator.prepareSynchronousReads(
          content,
          context,
          scope,
        );
      },
    };
  }

  private checkForExpressions(data: unknown): boolean {
    if (typeof data === "string") {
      return containsExpression(data);
    } else if (Array.isArray(data)) {
      return data.some((item) => this.checkForExpressions(item));
    } else if (data !== null && typeof data === "object") {
      return Object.values(data).some((value) =>
        this.checkForExpressions(value)
      );
    }
    return false;
  }

  async evaluateDataPair<T>(
    pair: SplicePair<T>,
    context: ExpressionContext,
    authored: AuthoredExpressions,
    secretBag: VaultSecretBag,
    foreignText: ForeignTextRule = "fail",
  ): Promise<SplicePair<T>> {
    const origins = new Map<string, SpliceOrigin>();
    const values = await this.evaluateDataValues(
      pair.raw,
      context,
      authored,
      pair.rawProvenance,
      origins,
      foreignText,
      secretBag,
    );
    if (values.size === 0) return pair;
    return pair.splice(
      values,
      sensitiveSpliceSanitizer(secretBag),
      undefined,
      (raw) => origins.get(raw) ?? { map: ProvenanceMap.data() },
    );
  }

  /**
   * this seam runs over already-substituted data, so anything not in authored
   * arrived as data content and stays literal text; pass unrestricted only for
   * unsubstituted source
   */
  async evaluateData(
    data: unknown,
    context: ExpressionContext,
    authored: AuthoredExpressions,
  ): Promise<unknown> {
    const bag = bagFor(context);
    const values = await this.evaluateDataValues(
      data,
      context,
      authored,
      undefined,
      undefined,
      undefined,
      bag,
    );
    if (values.size === 0) return data;
    return replaceExpressions(
      data,
      values,
      undefined,
      sensitiveSpliceSanitizer(bag),
    );
  }

  async evaluateDataTracked(
    data: unknown,
    provenance: ProvenanceMap,
    context: ExpressionContext,
    authored: AuthoredExpressions,
    foreignText: ForeignTextRule = "fail",
  ): Promise<TrackedSplice> {
    const bag = bagFor(context);
    const origins = new Map<string, SpliceOrigin>();
    const values = await this.evaluateDataValues(
      data,
      context,
      authored,
      provenance,
      origins,
      foreignText,
      bag,
    );
    if (values.size === 0) return { data, provenance };
    return replaceExpressionsTracked(
      data,
      values,
      provenance,
      (raw) => origins.get(raw) ?? { map: ProvenanceMap.data() },
      undefined,
      sensitiveSpliceSanitizer(bag),
    );
  }

  private async evaluateDataValues(
    data: unknown,
    context: ExpressionContext,
    authored: AuthoredExpressions,
    provenance: ProvenanceMap = ProvenanceMap.authored(),
    origins?: Map<string, SpliceOrigin>,
    foreignText: ForeignTextRule = "fail",
    secretBag?: VaultSecretBag,
  ): Promise<Map<string, unknown>> {
    const expressions = partitionAuthoredAt(
      extractExpressions(data),
      authored,
      provenance,
      sensitiveValuesOf(context),
    );
    if (expressions.length === 0) {
      return new Map();
    }

    // In a typed run the pass binds the run's sentinels as Secrets and a
    // Secret result leaves as a sentinel issued into a bag over the run's
    // registry; the same typed evaluator handles every entry point.
    const passEvaluator = await this.passEvaluatorFor(
      sensitiveValuesOf(context),
      { location: expressions[0].path, secretBag },
    );

    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsRuntimeExpression(expr.celExpression)) {
        continue;
      }

      // skip invalid CEL so prose documenting expression syntax keeps its raw
      // text; the syntax check decides, since the typed one would also refuse a
      // vault alias, which is not prose
      if (!this.celEvaluator.validate(expr.celExpression).valid) {
        continue;
      }

      let value: unknown;
      try {
        value = await passEvaluator.evaluateAsync(
          expr.celExpression,
          context,
        );
      } catch (error) {
        // in a step's task inputs another templating system's text stays raw
        // and reaches the method as literal text; classified only after it
        // fails, so a mistake here can never stop an expression that evaluates
        if (
          foreignText !== "passThrough" ||
          !isForeignExpression(expr.celExpression) ||
          !failedOnForeignRoot(error)
        ) throw error;
        // CEL named the known root it stopped at; name the unlisted one.
        const unlisted = unlistedForeignRootError(
          expr.celExpression,
          expr.path,
          error,
        );
        if (unlisted) throw unlisted;
        continue;
      }
      evaluatedValues.set(expr.raw, value);
      origins?.set(expr.raw, spliceOrigin(expr.celExpression, context, value));
    }

    return evaluatedValues;
  }

  /**
   * runtime expressions may read the model or file namespaces too (env.X +
   * model.y), so the runtime pass makes the same choice from the expressions
   * that remain
   */
  async buildRuntimeContext(
    definition: Definition,
    sensitiveValues: RunSensitiveValues,
    inputs?: Record<string, unknown>,
    deferredExpressions: readonly DeferredExpression[] = [],
  ): Promise<ExpressionContext> {
    const ctx =
      requiresModelNamespace([definition.toData(), deferredExpressions])
        ? await this.modelResolver.buildContext(sensitiveValues)
        : this.modelResolver.buildLightContext(sensitiveValues);
    if (inputs) {
      ctx.inputs = inputs;
    }
    ctx.deferredExpressions = deferredExpressions;
    return ctx;
  }

  async evaluateDefinition(
    definition: Definition,
    type: ModelType,
    sensitiveValues: RunSensitiveValues,
    inputValues?: Record<string, unknown>,
    context?: ExpressionContext,
    secretBag?: VaultSecretBag,
    options: {
      definition?: DefinitionPassProvenance;
      inputs?: ProvenanceMap;
      /** On replay, only expressions vouched for by source/cache may run. */
      authoredExpressions?: ReadonlySet<string>;
      methodName?: string;
    } = {},
  ): Promise<EvaluatedDefinition> {
    secretBag ??= new VaultSecretBag(sensitiveValues.sentinels);
    const definitionData = definition.toData();
    const definitionProvenance = options.definition ?? AUTHORED_DEFINITION;
    const authoredExpressions = options.authoredExpressions ??
      collectAuthoredExpressions(
        inputValues,
        collectAuthoredExpressions(definitionData),
      );

    const ctx = context ??
      await this.buildRuntimeContext(definition, sensitiveValues, inputValues);

    if (inputValues) {
      ctx.inputs = inputValues;
      attachBindingProvenance(ctx, {
        inputs: options.inputs ?? ProvenanceMap.authored(),
      });
    }

    ctx.self = {
      id: definition.id,
      name: definition.name,
      version: definition.version,
      tags: definition.tags,
      globalArguments: definition.globalArguments,
    };
    // self is rebound, so its provenance is too: global arguments routed
    // from data (a direct execution's literal inputs) stay data.
    attachBindingProvenance(ctx, {
      self: ProvenanceMap.authored().graft(
        "globalArguments",
        definitionProvenance.raw.subtree("globalArguments"),
      ),
    });

    const methodName = options.methodName;
    // A replay supplies the original authored set: cached data cannot vouch
    // for its own expressions. The fresh pass retains its ordinary rules.
    let expressions = extractExpressions(definitionData).filter((expr) =>
      methodName === undefined || isDeliveredWithMethod(expr.path, methodName)
    );
    if (options.authoredExpressions !== undefined) {
      expressions = partitionAuthoredAt(
        expressions,
        authoredExpressions,
        definitionProvenance.raw,
        sensitiveValues,
      );
    }

    if (expressions.length === 0) {
      return {
        definition,
        type,
        hadExpressions: false,
        authoredExpressions,
        sourceDefinition: definition,
        provenance: definitionProvenance.raw,
      };
    }

    // In a typed run the pass issues into a bag of the run's registry so a
    // Secret from a data read leaves CEL as a sentinel.
    const passEvaluator = await this.passEvaluatorFor(sensitiveValues, {
      secretBag,
      location: definition.name,
    });

    // Evaluate CEL-only expressions; runtime expressions (vault, env, and
    // mixed) are left raw — they are resolved at runtime only, never persisted.
    const {
      data: evaluatedData,
      sanitizedData,
      failedExpressions,
      provenance: evaluatedProvenance,
      sanitizedProvenance,
    } = await evaluateDefinitionExpressions(
      definitionData,
      expressions.filter((expr) =>
        !containsRuntimeExpression(expr.celExpression)
      ),
      ctx,
      passEvaluator,
      sensitiveSpliceSanitizer(secretBag),
      definitionData,
      definitionProvenance,
      methodName === undefined
        ? undefined
        : (path) => isOutsideMethodDelivery(path, methodName),
    );

    const evaluatedDefinition = DefinitionClass.fromData(evaluatedData);

    return {
      definition: evaluatedDefinition,
      type,
      hadExpressions: true,
      authoredExpressions,
      failedExpressions,
      sourceDefinition: definition,
      provenance: evaluatedProvenance,
      ...(sanitizedData
        ? {
          sanitizedDefinition: DefinitionClass.fromData(sanitizedData),
          sanitizedProvenance,
        }
        : {}),
    };
  }

  deferChildInputs(
    data: unknown,
    context: ExpressionContext,
    authored: AuthoredExpressions,
    omitBindings: readonly string[] = [],
    provenance: ProvenanceMap = ProvenanceMap.authored(),
  ) {
    const deferredExpressions = [...(context.deferredExpressions ?? [])];
    const values = new Map<string, unknown>();
    let bindings: DeferredExpression["bindings"] | undefined;
    let bindingsProvenance: ProvenanceMap | undefined;
    for (
      const expr of partitionAuthoredAt(
        extractExpressions(data),
        authored,
        provenance,
        sensitiveValuesOf(context),
      )
    ) {
      if (
        !containsRuntimeExpression(expr.celExpression) ||
        isDeferredExpression(expr.celExpression) || values.has(expr.raw)
      ) continue;
      const id = crypto.randomUUID();
      bindings ??= captureDeferredBindings(context, omitBindings);
      bindingsProvenance ??= bindingTreeProvenance(context);
      deferredExpressions.push({
        id,
        expression: this.bindOmittedVaultSelectors(
          expr.raw,
          context,
          omitBindings,
        ),
        bindings,
        ...(bindingsProvenance.isAuthored
          ? {}
          : { provenance: bindingsProvenance.toData() }),
      });
      values.set(expr.raw, deferredExpressionReference(id));
    }
    // A reference is swamp's own text, so it is spliced as authored.
    const tracked = replaceExpressionsTracked(
      data,
      values,
      provenance,
      () => ({ map: ProvenanceMap.authored() }),
    );
    return {
      data: tracked.data,
      deferredExpressions,
      provenance: tracked.provenance,
    };
  }

  /**
   * a child cannot capture resume inputs but a vault selector using one must
   * keep the reference the parent selected; bind just that selector, loading no
   * vault value; the child resolves under its own vault access
   */
  private bindOmittedVaultSelectors(
    expression: string,
    context: ExpressionContext,
    omitBindings: readonly string[],
  ): string {
    if (omitBindings.length === 0) return expression;
    let result = "";
    let last = 0;
    for (const call of findVaultGetCalls(expression)) {
      let changed = false;
      const bind = (
        quote: string,
        quoted: string,
        bare: string,
        label: string,
      ): string => {
        if (quoted !== undefined) return `${quote}${quoted}${quote}`;
        if (!isDynamicVaultArgument(bare)) return bare;
        if (
          !referencedBindingPaths(bare).some((path) =>
            omitBindings.some((omitted) => overlaps(path, omitted))
          )
        ) {
          return bare;
        }
        // a vault selector is a routing value: in a typed run a Secret in it is
        // refused rather than written into the child's expression as sentinel
        // text
        const registry = sensitiveValuesOf(context)?.sentinels;
        const evaluator = this.celEvaluator;
        const value = registry === undefined
          ? evaluator.evaluate(bare, context)
          : evaluator.evaluate(bare, context, {
            secretBag: new VaultSecretBag(registry),
            secretResult: "refuse",
          });
        if (typeof value !== "string") {
          throw new Error(`vault.get() ${label} must resolve to a string`);
        }
        changed = true;
        // Parentheses keep this a CEL constant, whose escapes are decoded
        // by CEL; legacy quoted vault arguments are otherwise verbatim.
        return `(${JSON.stringify(value)})`;
      };
      const vault = bind(call[1], call[2], call[3], "vault name");
      const key = bind(call[4], call[5], call[6], "secret key");
      // A trailing line comment must end before the separator or closing
      // parenthesis, including when only the other argument was bound.
      const args = [vault, key].map((arg) =>
        lexSegments(arg).at(-1)?.kind === "comment" ? `${arg}\n` : arg
      );
      result += expression.slice(last, call.index) +
        (changed ? `vault.get(${args.join(", ")})` : call[0]);
      last = call.index + call[0].length;
    }
    return result + expression.slice(last);
  }

  async evaluateAllDefinitions(
    sensitiveValues: RunSensitiveValues,
  ): Promise<EvaluatedDefinition[]> {
    const allDefinitions = await this.definitionRepo.findAllGlobal();

    const nodes = this.buildDefinitionDependencyGraph(allDefinitions);

    let sortedNames: string[];
    try {
      const sortResult = this.sortService.sort(nodes);
      sortedNames = this.sortService.flatten(sortResult);
    } catch (error) {
      if (error instanceof TopoCyclicError) {
        throw new CyclicDependencyError(error.cycle);
      }
      throw error;
    }

    // Build initial context from the definitions already loaded above, so the
    // repository is not walked a second time.
    const context = await this.modelResolver.buildContext(
      sensitiveValues,
      undefined,
      undefined,
      undefined,
      allDefinitions,
    );

    const definitionMap = new Map<
      string,
      { definition: Definition; type: ModelType }
    >();
    for (const { definition, type } of allDefinitions) {
      definitionMap.set(definition.name, { definition, type });
    }

    const results: EvaluatedDefinition[] = [];
    for (const name of sortedNames) {
      const entry = definitionMap.get(name);
      if (!entry) continue;

      const ctxWithSelf: ExpressionContext = {
        ...context,
        self: {
          id: entry.definition.id,
          name: entry.definition.name,
          version: entry.definition.version,
          tags: entry.definition.tags,
          globalArguments: entry.definition.globalArguments,
        },
      };

      const result = await this.evaluateDefinition(
        entry.definition,
        entry.type,
        sensitiveValues,
        undefined,
        ctxWithSelf,
      );
      results.push(result);

      if (result.hadExpressions) {
        const modelData = context.model[name] ?? {
          input: {
            id: result.definition.id,
            name: result.definition.name,
            version: result.definition.version,
            tags: result.definition.tags,
            globalArguments: {},
          },
        };
        modelData.definition = {
          id: result.definition.id,
          name: result.definition.name,
          version: result.definition.version,
          tags: result.definition.tags,
          globalArguments: result.definition.globalArguments,
          inputs: result.definition.inputs,
        };
        context.model[name] = modelData;
        context.model[result.definition.id] = modelData;
      }
    }

    return results;
  }

  private buildDefinitionDependencyGraph(
    definitions: { definition: Definition; type: ModelType }[],
  ): GraphNode[] {
    const nodes: GraphNode[] = [];
    const nameSet = new Set(definitions.map((d) => d.definition.name));

    for (const { definition } of definitions) {
      const definitionData = definition.toData();
      const expressions = extractExpressions(definitionData);

      const dependencies: string[] = [];
      for (const expr of expressions) {
        const refs = extractModelRefs(expr.celExpression);
        for (const ref of refs) {
          // Only add if it's a known definition name (not self, not UUID for simplicity)
          if (nameSet.has(ref) && ref !== definition.name) {
            if (!dependencies.includes(ref)) {
              dependencies.push(ref);
            }
          }
        }
      }

      nodes.push({
        name: definition.name,
        weight: 0,
        dependencies,
      });
    }

    return nodes;
  }

  hasDefinitionExpressions(definition: Definition): boolean {
    const data = definition.toData();
    return this.checkForExpressions(data);
  }

  /**
   * vault secrets become sentinels standing for their references, no value is
   * read; the caller's delivery loads the bag; expressions not in authored
   * arrived via data substitution and stay literal text
   */
  async resolveRuntimeExpressionsInDefinition(
    definition: Definition,
    redactor: SecretRedactor | undefined,
    expressionContext: ExpressionContext | undefined,
    authored: AuthoredExpressions,
    options: {
      /**
       * The step's bag. Sentinels the definition pass already spliced for
       * sensitive data values live in it, so the method receives one bag.
       */
      secretBag?: VaultSecretBag;
      /**
       * Global arguments with real values, bound as `self.globalArguments`
       * so CEL never reads the sentinels the executed copy carries.
       */
      rawGlobalArguments?: Record<string, unknown>;
      /**
       * Where data sits in `definition`'s data. An occurrence overlapping
       * data is neither resolved nor substituted.
       */
      provenance?: ProvenanceMap;
      /**
       * given, the pass covers runtime expressions of the global arguments and
       * this method's subtree only; every other method's are left as authored,
       * with nothing substituted into them even from a shared raw text
       */
      methodName?: string;
      /**
       * true leaves a failed expression as its authored text, records it in
       * failedExpressions and goes on; false, the default, fails the pass with
       * the error
       */
      keepUnevaluated?: (
        error: unknown,
        expression: ExpressionLocation,
      ) => boolean;
    } = {},
  ): Promise<RuntimeResolutionResult> {
    const logger = getLogger(["swamp", "expressions"]);
    const secretBag = options.secretBag ?? bagFor(expressionContext);
    const definitionData = definition.toData();
    const expressions = extractExpressions(definitionData);
    const provenance = options.provenance ?? ProvenanceMap.authored();

    // description prose may document the syntax and is never resolved; only
    // runtime expressions of the delivery's method, at authored positions, are
    // resolved
    const methodName = options.methodName;
    const isDescription = definitionDescriptionPaths(definitionData);
    const runtimeExpressions = partitionAuthoredAt(
      expressions.filter((expr) =>
        !isDescription(expr.path) &&
        containsRuntimeExpression(expr.celExpression) &&
        (methodName === undefined ||
          isDeliveredWithMethod(expr.path, methodName))
      ),
      authored,
      provenance,
      sensitiveValuesOf(expressionContext),
    );

    logger.debug(
      `Runtime expression resolution: ${expressions.length} total expressions, ${runtimeExpressions.length} runtime (vault/env)`,
    );
    for (const expr of runtimeExpressions) {
      logger.debug`Runtime expression at ${expr.path}: ${expr.raw}`;
    }

    if (runtimeExpressions.length === 0) {
      return { definition, secretBag, provenance };
    }

    // A runtime expression can also read a sensitive data value
    // (`env.X + data.latest(...)`), so its result is sanitized as it is
    // spliced into an argument, like the definition pass does.
    const sanitizer = sensitiveSpliceSanitizer(secretBag);
    const failedExpressions = new Map<string, Error>();
    const resolved = await this.resolveRuntimeInExpressions(
      definitionData,
      runtimeExpressions,
      redactor,
      secretBag,
      expressionContext,
      options.rawGlobalArguments,
      sanitizer,
      provenance,
      {
        skipPath: (path) =>
          isDescription(path) ||
          (methodName !== undefined &&
            isOutsideMethodDelivery(path, methodName)),
        unevaluated: options.keepUnevaluated &&
          { keep: options.keepUnevaluated, into: failedExpressions },
      },
    );

    const result: RuntimeResolutionResult = {
      definition: resolved.definition,
      secretBag,
      provenance: resolved.provenance,
    };
    if (failedExpressions.size > 0) {
      result.failedExpressions = failedExpressions;
    }
    return result;
  }

  /**
   * a method boundary loads the step's bag with a loader that reads vault.get()
   * values at delivery through the same vault service the existence checks ask
   */
  secretLoader(redactor: SecretRedactor | undefined): SecretLoader {
    return this.modelResolver.secretLoader(redactor);
  }

  /**
   * typed routing callers supply a destination: references in both input and
   * result are refused without loading, even when no expression remains; legacy
   * callers and trusted validation load inline, no bag returned
   */
  async resolveRuntimeExpressionsInData(
    data: unknown,
    redactor: SecretRedactor | undefined,
    expressionContext: ExpressionContext | undefined,
    authored: AuthoredExpressions,
    provenance: ProvenanceMap = ProvenanceMap.authored(),
    /** Typed routing refuses before any load; legacy/trusted callers still load. */
    destination?: PassEvaluatorOptions & { destination: string },
  ): Promise<unknown> {
    const secretBag = destination?.secretBag ?? bagFor(expressionContext);
    const refusing = destination !== undefined;
    const refuse = (value: unknown): void => {
      if (refusing) {
        refuseRoutingSecrets(
          value,
          secretBag.registry,
          destination.destination,
          destination.location,
        );
      }
    };
    refuse(data);
    const expressions = extractExpressions(data);
    const runtimeExpressions = partitionAuthoredAt(
      expressions.filter((expr) =>
        containsRuntimeExpression(expr.celExpression)
      ),
      authored,
      provenance,
      sensitiveValuesOf(expressionContext),
    );

    if (runtimeExpressions.length === 0) {
      return data;
    }

    const celContext: ExpressionContext = {
      model: {},
      ...expressionContext,
      env: buildEnvContext(),
    };
    const resolved = (await this.resolveRuntimeData(
      data,
      runtimeExpressions,
      celContext,
      redactor,
      secretBag,
      undefined,
      provenance,
    )).data;

    if (refusing) {
      refuse(resolved);
      return resolved;
    }

    // For the data path, load and resolve sentinels to raw values
    // immediately since there's no shell context to worry about.
    if (secretBag.resolvesAny) {
      const loaded = await this.secretLoader(redactor).load(
        secretBag,
        resolved,
      );
      return loaded.resolveDeep(resolved);
    }
    return resolved;
  }

  /**
   * the CEL pass splices data content into the tree, so the caller must supply
   * provenance collected from authored source before any substitution, and both
   * passes apply it
   */
  async resolveAllExpressionsInData(
    data: unknown,
    context: ExpressionContext,
    redactor: SecretRedactor | undefined,
    authored: AuthoredExpressions,
    provenance: ProvenanceMap = ProvenanceMap.authored(),
    destination?: PassEvaluatorOptions & { destination: string },
  ): Promise<unknown> {
    const afterCel = await this.evaluateDataTracked(
      data,
      provenance,
      context,
      authored,
    );
    return await this.resolveRuntimeExpressionsInData(
      afterCel.data,
      redactor,
      context,
      authored,
      afterCel.provenance,
      destination,
    );
  }

  private async resolveRuntimeInExpressions(
    definitionData: ReturnType<Definition["toData"]>,
    runtimeExpressions: ExpressionLocation[],
    redactor?: SecretRedactor,
    secretBag?: VaultSecretBag,
    expressionContext?: ExpressionContext,
    rawGlobalArguments?: Record<string, unknown>,
    sanitizer?: SpliceSanitizer,
    provenance: ProvenanceMap = ProvenanceMap.authored(),
    pass?: RuntimePassOptions,
  ): Promise<{ definition: Definition; provenance: ProvenanceMap }> {
    const celContext: ExpressionContext = {
      model: {},
      ...expressionContext,
      self: {
        id: definitionData.id,
        name: definitionData.name,
        version: definitionData.version,
        tags: definitionData.tags,
        globalArguments: rawGlobalArguments ??
          definitionData.globalArguments ?? {},
        ...expressionContext?.self,
      },
      env: buildEnvContext(),
    };
    const resolved = await this.resolveRuntimeData(
      definitionData,
      runtimeExpressions,
      celContext,
      redactor,
      secretBag ?? bagFor(expressionContext),
      sanitizer,
      provenance,
      pass,
    );
    return {
      definition: DefinitionClass.fromData(
        resolved.data as ReturnType<Definition["toData"]>,
      ),
      provenance: resolved.provenance,
    };
  }

  private async resolveRuntimeData(
    data: unknown,
    expressions: ExpressionLocation[],
    context: ExpressionContext,
    redactor: SecretRedactor | undefined,
    secretBag: VaultSecretBag,
    sanitizer?: SpliceSanitizer,
    provenance: ProvenanceMap = ProvenanceMap.authored(),
    pass: RuntimePassOptions = {},
  ): Promise<TrackedSplice> {
    sanitizer ??= sensitiveSpliceSanitizer(secretBag);
    const records = new Map(
      (context.deferredExpressions ?? []).map((
        record,
      ) => [deferredExpressionReference(record.id), record]),
    );
    const resolvedReferences = new Map<string, unknown>();
    const resolving = new Set<string>();
    // only the bindings an expression reads are resolved, so an unused
    // reference (a missing env var or vault key in another input) never becomes
    // a dependency of it; resolved references are memoized
    const withBindings = async (
      ctx: ExpressionContext,
      cel: string,
      location: string,
    ): Promise<ExpressionContext> => {
      const { inputs, self, run } = ctx;
      // the steps subtree is whole data, so nothing in it is spliced: the
      // context's own steps stay, keeping the sources a step context carries
      // under its symbol key; a rebuilt copy would drop them
      return {
        ...ctx,
        ...await resolveBindings(
          { inputs, self, run },
          cel,
          bindingTreeProvenance(ctx),
          location,
        ) as object,
      };
    };

    const resolveBindings = async (
      bindings: unknown,
      cel: string,
      bindingMap: ProvenanceMap,
      location: string,
    ): Promise<unknown> => {
      const read = referencedBindingPaths(cel);
      const values = new Map<string, unknown>();
      for (const expr of extractExpressions(bindings)) {
        if (
          records.has(expr.raw) &&
          read.some((path) => overlaps(path, expr.path)) &&
          !(expr.start !== undefined && expr.end !== undefined &&
            bindingMap.overlapsData(expr.path, expr.start, expr.end))
        ) {
          values.set(expr.raw, await resolve(expr, context, location));
        }
      }
      if (bindingMap.isAuthored) return replaceExpressions(bindings, values);
      return replaceExpressionsTracked(
        bindings,
        values,
        bindingMap,
        () => ({ map: ProvenanceMap.authored() }),
      ).data;
    };
    const resolve = async (
      expr: ExpressionLocation,
      ctx: ExpressionContext,
      location: string = expr.path,
    ): Promise<unknown> => {
      const record = records.get(expr.raw);
      if (record) {
        if (resolvedReferences.has(expr.raw)) {
          return resolvedReferences.get(expr.raw);
        }
        if (resolving.has(expr.raw)) {
          throw new Error("Cyclic deferred expression scope");
        }
        resolving.add(expr.raw);
        const bindings = await resolveBindings(
          record.bindings,
          extractCelExpression(record.expression) ?? "",
          deferredBindingsProvenance(record),
          location,
        ) as typeof record.bindings;
        // The parent's bindings carry the parent's provenance, never the
        // child's: a reference left in data there stays unresolved.
        const recordProvenance = deferredBindingsProvenance(record);
        const value = await resolve(
          extractExpressions(record.expression)[0],
          attachBindingProvenance({
            ...context,
            // Omitted parent bindings stay absent; never borrow the child's scope.
            inputs: bindings.inputs,
            self: bindings.self,
            run: bindings.run,
            workflowRunId: bindings.workflowRunId,
            // a typed capture carries each step's output sources as plain data;
            // they come back under the symbol key, and the plain key never
            // reaches CEL
            steps: fromPersistedStepContexts(bindings.steps),
          }, {
            inputs: recordProvenance.subtree("inputs"),
            self: recordProvenance.subtree("self"),
            run: recordProvenance.subtree("run"),
          }),
          location,
        );
        resolving.delete(expr.raw);
        resolvedReferences.set(expr.raw, value);
        return value;
      }
      if (isDeferredExpression(expr.celExpression)) return expr.raw;
      const celContext = records.size
        ? await withBindings(ctx, expr.celExpression, location)
        : ctx;
      const evaluator = this.celEvaluator;
      {
        // a typed run evaluates vault.get as the CEL function, which refuses an
        // alias and issues the sentinel into the step's bag; the screen only
        // records an alias so the typed evaluator refuses it
        try {
          analyzeVaultCalls(expr.celExpression);
        } catch (error) {
          if (pass.unevaluated) throw error;
          if (containsVaultExpression(expr.celExpression)) {
            getLogger(["swamp", "expressions"])
              .warn`Skipped vault expression at ${expr.path} because its CEL is syntactically invalid: ${
              error instanceof Error ? error.message : String(error)
            }. Raw: ${expr.raw}`;
          }
          return expr.raw;
        }
        return await evaluator.evaluateAsync(
          expr.celExpression,
          celContext,
          this.scopeFor(secretBag, location, redactor),
        );
      }
    };

    const values = new Map<string, unknown>();
    const origins = new Map<string, SpliceOrigin>();
    for (const expr of expressions) {
      try {
        const value = await resolve(expr, context);
        values.set(expr.raw, value);
        // A deferred reference left unresolved is the authored text itself.
        if (value !== expr.raw) {
          origins.set(
            expr.raw,
            spliceOrigin(expr.celExpression, context, value),
          );
        }
      } catch (error) {
        const { unevaluated } = pass;
        if (!unevaluated?.keep(error, expr)) throw error;
        // Not in `values`, so the splice below leaves it as authored. Each
        // expression is decided on its own: the ones after it still resolve.
        unevaluated.into.set(
          expr.raw,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    // only this final splice is sanitized; an occurrence in data or a skipped
    // subtree is never substituted, even if an authored one shares its raw
    // text; each splice carries its origin
    return replaceExpressionsTracked(
      data,
      values,
      provenance,
      (raw) => origins.get(raw) ?? AUTHORED_ORIGIN,
      pass.skipPath,
      sanitizer,
    );
  }
}
