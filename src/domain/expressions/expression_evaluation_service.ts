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

/**
 * Textual fallback for detecting references to the `vault` namespace, used
 * only when the expression does not parse (see
 * {@link containsVaultExpression}). Like {@link ENV_PATTERN}, it matches any
 * bare `vault` identifier but not member access such as `self.vault`.
 */
const VAULT_PATTERN = /(?<![.\w])vault\b/;

/**
 * Textual fallback for detecting references to the `env` map, used only when
 * cel-js cannot parse the expression (see {@link containsEnvExpression}).
 *
 * Matches any bare `env` identifier — dotted access, bracket-index access,
 * and `env` passed around as a value — but not member access such as
 * `inputs.env` or identifiers that merely contain the word. Every form must
 * be classified as runtime, or it would be evaluated in the persist phase,
 * where the context also carries the process environment.
 */
const ENV_PATTERN = /(?<![.\w])env\b/;

/**
 * A bag for a caller that passed none: a view of the run's registry when the
 * context carries the run's sensitive values, otherwise a registry of its
 * own for the paths with no run, such as the validate pre-flight checks.
 */
function bagFor(context: ExpressionContext | undefined): VaultSecretBag {
  return new VaultSecretBag(
    sensitiveValuesOf(context)?.sentinels ?? new SecretBagRegistry(),
  );
}

/**
 * A routing destination sees references only (typed-secrets 4.5). Check even
 * literal text: an earlier pass may already have issued its sentinel. Keys
 * are checked before entering them, so no sentinel becomes an error path.
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
 * Checks whether a CEL expression references the `vault` namespace, as
 * `vault.get(...)` does. Expressions containing vault references must NOT be
 * evaluated during the persist phase — they are resolved at runtime only.
 *
 * Decided on the parsed tree, the way evaluation reads it, so text inside a
 * string literal never counts and a call reached through `cel.bind` or a
 * parenthesised receiver does. When the text does not parse, a textual scan
 * over it with string literals removed stands in; it is conservative, so an
 * error can only defer to runtime.
 */
export function containsVaultExpression(celExpression: string): boolean {
  const roots = freeRoots(celExpression);
  if (roots !== undefined) return roots.has("vault");
  return VAULT_PATTERN.test(stripStringLiterals(celExpression));
}

/**
 * Checks whether a CEL expression references the env map in any form.
 * Expressions containing env references must NOT be evaluated during
 * the persist phase — they are resolved at runtime only.
 */
export function containsEnvExpression(celExpression: string): boolean {
  try {
    return astReferencesEnv(parseCel(celExpression).ast, new Set());
  } catch {
    // cel-js rejects some syntax the evaluator accepts (optional `.?` access);
    // the textual scan is conservative, so an error can only defer to runtime.
    return ENV_PATTERN.test(stripStringLiterals(celExpression));
  }
}

/**
 * Checks whether a CEL expression contains any runtime-only references
 * (vault or env). Expressions matching this check are deferred to runtime
 * and skipped during the persist phase.
 */
export function containsRuntimeExpression(celExpression: string): boolean {
  return isDeferredExpression(celExpression) ||
    containsVaultExpression(celExpression) ||
    containsEnvExpression(celExpression);
}

/**
 * The set of expressions an author actually wrote, keyed by raw `${{ ... }}`
 * text (and bare assertion predicates), or `"unrestricted"` to opt out.
 *
 * CEL evaluation splices data content into the tree as raw text
 * ({@link replaceExpressions}), and every later pass — the runtime pass and
 * any second CEL pass over step inputs — re-parses that tree. Without
 * provenance the two are indistinguishable, so a plain string field holding
 * expression text would be evaluated as if the author had written it: a
 * `vault.get(...)` or `env` reference resolves a secret directly, and any other
 * CEL (a `data.latest()` call on another model's sensitive field, say) reads
 * one through the evaluation context. Callers that evaluate a post-CEL tree
 * must therefore pass the set collected from their pre-CEL source.
 *
 * `"unrestricted"` is for callers whose input is author-written source that has
 * had no substitution applied — it must be spelled out rather than defaulted, so
 * that every call site states which case it is in.
 */
export type AuthoredExpressions =
  | ReadonlySet<string>
  | "unrestricted";

/**
 * Collects the raw text of every expression in `data`.
 *
 * Call this on author-written source — a definition or workflow as loaded from
 * disk — *before* any CEL evaluation, and pass the result to every later pass.
 * Keyed on raw expression text rather than path because CEL substitution can
 * replace a whole subtree at a path, and workflow paths do not map onto
 * definition paths.
 *
 * @param data - Author-written source data, pre-CEL
 * @param into - Optional set to accumulate into, for unioning several sources
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

/** Binding paths (`inputs.home`, `self`, `steps.a.outputs`) a CEL expression reads. */
function referencedBindingPaths(cel: string): string[] {
  // A literal() argument is text, so it reads no binding.
  return [
    ...maskLiteralCalls(cel).matchAll(
      /\b(inputs|self|run|steps)((?:\.[A-Za-z0-9_]+|\[\d+\])*)/g,
    ),
  ]
    .map((m) => m[1] + m[2]);
}

/** True when one path is the other or an ancestor of it. */
function overlaps(a: string, b: string): boolean {
  const under = (path: string, root: string) =>
    path === root || path.startsWith(root + ".") ||
    path.startsWith(root + "[");
  return under(a, b) || under(b, a);
}

/** Evaluates authored constants for {@link constantOutputRaws}. */
let constantEvaluator: CelEvaluator | undefined;

/** An authored set's constant outputs, computed on first use. */
interface ConstantOutputs {
  /** Each authored constant that produces expression text, with that text. */
  byConstant: Map<string, Set<string>>;
  /** Every expression text any of them produces. */
  all: Set<string>;
}

const constantOutputCache = new WeakMap<
  ReadonlySet<string>,
  ConstantOutputs
>();

/**
 * The raw text of every expression that an authored constant evaluates to,
 * such as the `inputs.version` expression text that
 * `literal('${{ inputs.version }}')` produces. A constant reads no binding
 * (no free roots), so its output is text the author wrote on purpose, and a
 * later pass that refuses it has nothing to report (swamp-club#3402).
 *
 * Derived only from `authored`, which data cannot extend. Constants that fail
 * to evaluate are skipped, as are bare assertion predicates.
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
 * The authored constants (see {@link constantOutputs}) whose output includes
 * one of `raws`. A nested workflow inherits these from its parent, so the
 * child, too, recognises `literal()` output it receives as the parent
 * author's text. Evaluating a constant reads no binding, so inheriting one
 * grants the child no access.
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
 * Whether a refusal of `expr` is worth a warning: not when the text is
 * another templating system's (see {@link isForeignExpression}), which no
 * swamp evaluation could own, nor when an authored constant produced it, and
 * only the first time the step's rejection report sees it.
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
 * Splits expressions into those the author wrote and those CEL substitution
 * introduced, logging a warning for each rejection so an injection attempt is
 * visible in the run log. Text an authored constant produced, such as
 * `literal()` output, and another templating system's text are refused
 * without a warning, and a step logs each refused raw text once.
 *
 * The raw expression text is logged because it is the reference, never a
 * resolved value — nothing has been evaluated at this point, and that is the
 * whole point of the rejection.
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
 * Warns that a refused expression is the stored reference of a sensitive
 * field whose vault read failed in this run, naming the vault, key and
 * provider error, in place of the data-content warning: swamp wrote that
 * reference, and the unreadable vault is why it is still text
 * (swamp-club#3806). The text is refused either way. False when `expr` is
 * not such a reference.
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
 * {@link partitionAuthored}, then drops every occurrence that overlaps data in
 * `provenance`: expression text that arrived as data never evaluates, even
 * when its raw text matches an expression the author wrote. Strictly narrower
 * than the raw-text rule alone.
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

/**
 * Where data sits in the `{ inputs, self, run, steps }` bindings a deferred
 * reference resolves against: each namespace's binding provenance, with step
 * outputs always data.
 */
function bindingTreeProvenance(context: ExpressionContext): ProvenanceMap {
  const bindings = bindingProvenanceOf(context);
  return ProvenanceMap.authored()
    .graft("inputs", bindings.inputs ?? ProvenanceMap.authored())
    .graft("self", bindings.self ?? ProvenanceMap.authored())
    .graft("run", bindings.run ?? ProvenanceMap.authored())
    .withWholeData("steps");
}

/**
 * Where data sits in a deferred record's captured bindings, as recorded when
 * it was captured. Records written before provenance existed carry none and
 * keep the behaviour they had then.
 */
function deferredBindingsProvenance(record: DeferredExpression): ProvenanceMap {
  return record.provenance === undefined
    ? ProvenanceMap.authored()
    : ProvenanceMap.fromData(record.provenance);
}

/**
 * Result of resolving runtime expressions in a definition.
 * Includes the resolved definition and a VaultSecretBag containing
 * sentinel-to-value mappings for any vault secrets encountered.
 */
export interface RuntimeResolutionResult {
  definition: Definition;
  secretBag: VaultSecretBag;
  /**
   * The expressions `keepUnevaluated` left as their authored text, keyed
   * on raw text with the error each failed with. Absent when none did.
   */
  failedExpressions?: FailedExpressions;
}

/** How a runtime pass treats an expression that fails to evaluate. */
interface UnevaluatedPolicy {
  /** True keeps the expression as its authored text; false fails the pass. */
  keep: (error: unknown, expression: ExpressionLocation) => boolean;
  /** Where each kept expression is recorded, keyed on its raw text. */
  into: Map<string, Error>;
}

/** What a delivery's runtime pass adds to the pass over a whole definition. */
interface RuntimePassOptions {
  /** A subtree the pass neither resolves nor substitutes into. */
  skipPath?: (path: string) => boolean;
  /** An expression that fails to evaluate; absent, it fails the pass. */
  unevaluated?: UnevaluatedPolicy;
}

/**
 * Result of evaluating a single definition.
 */
export interface EvaluatedDefinition {
  definition: Definition;
  type: ModelType;
  /** Expressions collected from source and inputs before substitution. */
  authoredExpressions: ReadonlySet<string>;
  /** Whether any expressions were evaluated */
  hadExpressions: boolean;
  /**
   * Expressions left unresolved because evaluation failed, with the reason.
   * Absent when nothing was evaluated (e.g. a definition loaded for
   * `--last-evaluated`).
   */
  failedExpressions?: FailedExpressions;
  /**
   * The definition to execute: `definition` with sensitive data values in
   * its arguments replaced by sentinels from the caller's bag. Present only
   * when a bag was given; `definition` keeps real values for caching,
   * reports and `self.globalArguments`.
   */
  sanitizedDefinition?: Definition;
  /**
   * Where data sits in `definition`'s data. Absent means nothing in it is
   * data, as for a definition evaluated straight from source.
   */
  provenance?: ProvenanceMap;
  /** Where data sits in `sanitizedDefinition`'s data, when present. */
  sanitizedProvenance?: ProvenanceMap;
  /**
   * The definition as it was before evaluation. Its expression paths are the
   * positions a persisted evaluation must treat as values.
   */
  sourceDefinition?: Definition;
}

/**
 * Domain service for evaluating CEL expressions in model definitions.
 */
/**
 * What a pass over data does with another templating system's `${{ ... }}`
 * text (see {@link isForeignExpression}) that fails to evaluate: `"fail"`
 * rethrows, as for any failed expression; `"passThrough"` leaves it raw when
 * it failed on its foreign root (see {@link failedOnForeignRoot}) and reads
 * no unlisted root (see {@link unlistedForeignRootError}).
 * Only a step's task inputs pass it through. Everything else a step-time
 * pass covers (placement, say) must be resolved by swamp.
 */
export type ForeignTextRule = "fail" | "passThrough";

/** What {@link ExpressionEvaluationService.passEvaluatorFor} binds a pass to. */
export interface PassEvaluatorOptions {
  /** The pass's issuing bag; a bag over the run's registry when absent. */
  readonly secretBag?: VaultSecretBag;
  /** The authored location a vault check names. */
  readonly location: string;
  /**
   * The predicate destination of a guard or assert: a result that holds a
   * secret is refused instead of leaving as a sentinel.
   */
  readonly secretResult?: "refuse";
  /** A routing destination: refuse issued references before returning a result. */
  readonly destination?: string;
}

/**
 * The evaluator a pass runs with: the shape the passes take, whether the
 * run is typed, and the pass's authorization step for the content it
 * evaluates synchronously (design/enablers/typed-secrets.md Section 3.4).
 */
export interface PassEvaluator
  extends CelExpressionEvaluator, CelExpressionValidator {
  /**
   * Prepares the context for every expression in `content` and, in a typed
   * run, authorizes the sensitive-field references a synchronous evaluation
   * of them can read. Call it before `evaluate`; `evaluateAsync` prepares
   * and authorizes for itself.
   */
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
   * The context a workflow-level evaluation (`swamp workflow evaluate`)
   * runs against, from this service's resolver, so the context and a typed
   * pass's vault check scope answer from one resolver. Loading every model
   * definition is only needed when the workflow reads the model or file
   * namespaces.
   */
  buildEvaluationContext(
    needsModelNamespace: boolean,
    sensitiveValues: RunSensitiveValues,
  ): Promise<ExpressionContext> {
    return needsModelNamespace
      ? this.modelResolver.buildContext(sensitiveValues)
      : Promise.resolve(this.modelResolver.buildLightContext(sensitiveValues));
  }

  /**
   * What a typed evaluation runs with: the issuing bag, and the vault check
   * scope the resolver's vault service answers, so vault.get checks and
   * sensitive-field authorization ask the service a load reads through.
   */
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
   * Binds the shared evaluator to this pass's issuing bag, lazy vault scope and
   * destination. Synchronous passes prepare authorization for their own reads;
   * authorization never carries from one pass to another.
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

  /**
   * {@link evaluateData} over a raw/sanitized pair: each expression is
   * evaluated once, from the raw copy, and spliced into both; the sanitized
   * copy replaces sensitive data values with sentinels from `secretBag`.
   */
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
   * Evaluates expressions in arbitrary data with the given context.
   * Used at step-execution seams over workflow-level data.
   *
   * @param data - The data containing expressions
   * @param context - The evaluation context
   * @param authored - Expressions the author wrote, collected from the
   *   pre-CEL source with {@link collectAuthoredExpressions}. This seam runs
   *   over data that has already had substitution applied, so anything not in
   *   the set arrived as data content and is left as literal text. Pass
   *   `"unrestricted"` only when `data` is unsubstituted source.
   * @returns The data with expressions replaced
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

  /**
   * {@link evaluateData} over data whose provenance is known: an occurrence
   * overlapping data is neither evaluated nor substituted, and the result's
   * map records where each spliced value's data now sits.
   */
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

    // Evaluate CEL-only expressions; skip runtime expressions (vault, env)
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsRuntimeExpression(expr.celExpression)) {
        continue;
      }

      // Skip syntactically-invalid CEL: the ${{ ... }} sequence appears
      // inside a prose string (e.g. a plan body that documents expression
      // syntax). Leaving the raw text in place preserves prose round-trip.
      // The syntax check decides: the
      // typed one would also refuse a vault alias, which is the typed
      // evaluation's own refusal, not prose.
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
        // In a step's task inputs, another templating system's text
        // (${{ github.sha }}) stays raw and reaches the method as literal
        // text (swamp-club#2528). Classified only after it fails, so a
        // mistake here can never stop an expression that evaluates.
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
   * Builds the context for a pass over a definition. Only definitions that
   * read the model or file namespaces need every model definition loaded;
   * everything else evaluates against the lightweight context. Runtime
   * expressions may read those namespaces too (`env.X + model.y`), so the
   * runtime pass over an evaluated definition makes the same choice from the
   * expressions that remain in it.
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

  /**
   * Evaluates expressions in a single definition.
   *
   * @param definition - The definition to evaluate
   * @param type - The model type
   * @param sensitiveValues - The run's record of resolved sensitive values
   * @param inputValues - Optional input values to use in expression evaluation
   * @param context - Optional pre-built context (for batch evaluation)
   * @returns The evaluated definition
   */
  async evaluateDefinition(
    definition: Definition,
    type: ModelType,
    sensitiveValues: RunSensitiveValues,
    inputValues?: Record<string, unknown>,
    context?: ExpressionContext,
    secretBag?: VaultSecretBag,
    options: {
      /** Where data already sits in the definition's data. */
      definition?: DefinitionPassProvenance;
      /** Where data sits in `inputValues`. */
      inputs?: ProvenanceMap;
      /** On replay, only expressions vouched for by source/cache may run. */
      authoredExpressions?: ReadonlySet<string>;
      /** On replay, evaluate only globals and the selected method. */
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

    // Build context if not provided.
    const ctx = context ??
      await this.buildRuntimeContext(definition, sensitiveValues, inputValues);

    // Add inputs to context if provided
    if (inputValues) {
      ctx.inputs = inputValues;
      attachBindingProvenance(ctx, {
        inputs: options.inputs ?? ProvenanceMap.authored(),
      });
    }

    // Add self reference for the definition
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

    // In a typed run the pass issues into a bag of the run's registry, so a
    // Secret a data read returned leaves CEL as a sentinel; a caller that
    // passed no bag gets one over the run's registry. vault.get stays a
    // runtime root here, so the scope's vault service answers only the
    // authorization of sensitive-field references
    // (design/enablers/typed-secrets.md Section 5).
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

    // Create new Definition from evaluated data
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

  /** Replace parent-authored runtime input expressions with scoped references. */
  deferChildInputs(
    data: unknown,
    context: ExpressionContext,
    authored: AuthoredExpressions,
    omitBindings: readonly string[] = [],
    /** Where data sits in `data`; occurrences in data are never deferred. */
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
   * A child cannot capture resume inputs, but a vault selector using one
   * must keep the reference the parent selected. Bind just that selector
   * before its scope is omitted. No vault value is checked or loaded here;
   * the child still resolves the reference under its own vault access.
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
        // A vault selector is a routing value: in a typed run a Secret in
        // it is refused rather than written into the child's expression as
        // sentinel text (typed-secrets 4.1).
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

  /**
   * Evaluates all definitions in dependency order.
   * Definitions are evaluated in topological order based on their expression dependencies.
   *
   * @returns Array of evaluated definitions
   * @throws CyclicDependencyError if circular dependencies are detected
   */
  async evaluateAllDefinitions(
    sensitiveValues: RunSensitiveValues,
  ): Promise<EvaluatedDefinition[]> {
    // Load all definitions
    const allDefinitions = await this.definitionRepo.findAllGlobal();

    // Build dependency graph
    const nodes = this.buildDefinitionDependencyGraph(allDefinitions);

    // Sort topologically
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

    // Map of definition name to definition data
    const definitionMap = new Map<
      string,
      { definition: Definition; type: ModelType }
    >();
    for (const { definition, type } of allDefinitions) {
      definitionMap.set(definition.name, { definition, type });
    }

    // Evaluate in order
    const results: EvaluatedDefinition[] = [];
    for (const name of sortedNames) {
      const entry = definitionMap.get(name);
      if (!entry) continue;

      // Add self to context for this evaluation
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

      // Update context with evaluated definition data for subsequent evaluations
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
        // Also update by UUID
        context.model[result.definition.id] = modelData;
      }
    }

    return results;
  }

  /**
   * Builds a dependency graph from definitions based on their expressions.
   */
  private buildDefinitionDependencyGraph(
    definitions: { definition: Definition; type: ModelType }[],
  ): GraphNode[] {
    const nodes: GraphNode[] = [];
    const nameSet = new Set(definitions.map((d) => d.definition.name));

    for (const { definition } of definitions) {
      const definitionData = definition.toData();
      const expressions = extractExpressions(definitionData);

      // Collect all model references from expressions
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
        weight: 0, // All definitions have equal weight
        dependencies,
      });
    }

    return nodes;
  }

  /**
   * Checks if any string value in the definition contains expressions.
   */
  hasDefinitionExpressions(definition: Definition): boolean {
    const data = definition.toData();
    return this.checkForExpressions(data);
  }

  /**
   * Resolves remaining runtime expressions (vault and env) in an already-evaluated definition.
   * This is the runtime phase — vault secrets and env variables are resolved here and never persisted.
   *
   * Vault secrets are replaced with sentinel tokens that stand for their
   * references; no value is read. The caller's delivery loads the returned
   * VaultSecretBag ({@link secretLoader}) and resolves through the loaded view:
   * - Non-shell contexts: VaultSecretBag.resolveDeep() for raw values
   * - Shell commands: VaultSecretBag.resolveForShell() for env var injection
   *
   * @param definition - The definition (may contain remaining ${{ vault.get(...) }} or ${{ env.* }} expressions)
   * @param redactor - Optional SecretRedactor for the value an existence probe reads
   * @param expressionContext - Optional context for CEL-evaluating dynamic vault.get() arguments
   * @param authored - Expressions the author wrote, collected from the pre-CEL
   *   source with {@link collectAuthoredExpressions}. Anything else in the
   *   definition arrived via data substitution and is left as literal text.
   *   Required so every caller states whether its input is author-written;
   *   pass `"unrestricted"` only when no substitution has run.
   * @returns The definition with sentinels and the VaultSecretBag for resolving them
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
       * The method this delivery is for. Given, the pass covers the
       * runtime expressions of the global arguments and of this method's
       * subtree only ({@link isDeliveredWithMethod}); every other method's
       * are left as authored, neither checked, loaded nor failed on, as
       * the definition pass's failures in them are never asserted, and
       * nothing is substituted into them, not even the value of a raw text
       * they share with this method. Absent, the pass covers the whole
       * definition.
       */
      methodName?: string;
      /**
       * Decides an expression whose evaluation failed: true leaves it as
       * its authored text and records it in the result's
       * `failedExpressions`, and the pass goes on to the next expression;
       * false, and the default, fails the pass with the error.
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

    // Filter to only runtime expressions (vault or env), of the delivery's
    // method when one is named, then to those the author actually wrote at
    // an authored position — see AuthoredExpressions.
    const methodName = options.methodName;
    const runtimeExpressions = partitionAuthoredAt(
      expressions.filter((expr) =>
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
      return { definition, secretBag };
    }

    // A runtime expression can also read a sensitive data value
    // (`env.X + data.latest(...)`), so its result is sanitized as it is
    // spliced into an argument, like the definition pass does.
    const sanitizer = sensitiveSpliceSanitizer(secretBag);
    const failedExpressions = new Map<string, Error>();
    const resolvedDefinition = await this.resolveRuntimeInExpressions(
      definitionData,
      runtimeExpressions,
      redactor,
      secretBag,
      expressionContext,
      options.rawGlobalArguments,
      sanitizer,
      provenance,
      {
        skipPath: methodName === undefined
          ? undefined
          : (path) => isOutsideMethodDelivery(path, methodName),
        unevaluated: options.keepUnevaluated &&
          { keep: options.keepUnevaluated, into: failedExpressions },
      },
    );

    const result: RuntimeResolutionResult = {
      definition: resolvedDefinition,
      secretBag,
    };
    if (failedExpressions.size > 0) {
      result.failedExpressions = failedExpressions;
    }
    return result;
  }

  /**
   * A loader that reads vault.get() values at delivery through the vault
   * service this evaluator's existence checks ask. A method boundary loads
   * the step's bag with it (design/enablers/typed-secrets.md Section 3.3).
   */
  secretLoader(redactor: SecretRedactor | undefined): SecretLoader {
    return this.modelResolver.secretLoader(redactor);
  }

  /**
   * Resolves remaining runtime expressions (vault and env) in arbitrary data.
   * This is the runtime phase — vault secrets and env variables are resolved here and never persisted.
   *
   * Typed routing callers supply a destination: references in both the input
   * and result are refused without loading, even when no expression remains.
   * Legacy callers and trusted validation load inline (no bag is returned).
   * These callers are pinned by the Section 3.3 fitness rule.
   *
   * @param data - The data (may contain remaining runtime expressions)
   * @param redactor - Optional SecretRedactor to register resolved secret values for redaction
   * @param expressionContext - Optional context for CEL-evaluating dynamic vault.get() arguments
   * @param authored - Expressions the author wrote. See
   *   {@link resolveRuntimeExpressionsInDefinition}.
   * @returns Resolved data; typed routing refuses secrets before returning it.
   */
  async resolveRuntimeExpressionsInData(
    data: unknown,
    redactor: SecretRedactor | undefined,
    expressionContext: ExpressionContext | undefined,
    authored: AuthoredExpressions,
    /** Where data sits in `data`. */
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
    const resolved = await this.resolveRuntimeData(
      data,
      runtimeExpressions,
      celContext,
      redactor,
      secretBag,
      undefined,
      provenance,
    );

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
   * Resolves both CEL expressions (with the supplied context, including
   * self.* for forEach iteration) and runtime expressions (env, vault)
   * in arbitrary data in a single call. Two-pass composition:
   *
   *   1. {@link evaluateData} — CEL only, skips runtime. Resolves self.*,
   *      inputs.*, model.*, data.*, etc. against the supplied context.
   *   2. {@link resolveRuntimeExpressionsInData} — env and vault, with the
   *      caller's destination. Typed routing refuses references; legacy
   *      callers load and redact. The context carries dynamic vault selectors.
   *
   * Used at execution-time seams that consume workflow-level data where
   * CEL must materialize before runtime resolution walks the now-CEL-
   * resolved tree. Because the CEL pass splices data content into that tree,
   * the caller must supply provenance collected from authored source before
   * any substitution, and both passes apply it.
   */
  async resolveAllExpressionsInData(
    data: unknown,
    context: ExpressionContext,
    redactor: SecretRedactor | undefined,
    authored: AuthoredExpressions,
    /** Where data sits in `data`. */
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

  /**
   * Internal: resolves runtime expressions in definition data and returns a new Definition.
   * Vault secrets are replaced with sentinel tokens stored in the secretBag.
   */
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
  ): Promise<Definition> {
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
    const resolvedData = await this.resolveRuntimeData(
      definitionData,
      runtimeExpressions,
      celContext,
      redactor,
      secretBag ?? bagFor(expressionContext),
      sanitizer,
      provenance,
      pass,
    );
    return DefinitionClass.fromData(
      resolvedData as ReturnType<Definition["toData"]>,
    );
  }

  /** Resolve registered references with parent bindings and fresh runtime services. */
  private async resolveRuntimeData(
    data: unknown,
    expressions: ExpressionLocation[],
    context: ExpressionContext,
    redactor: SecretRedactor | undefined,
    secretBag: VaultSecretBag,
    sanitizer?: SpliceSanitizer,
    provenance: ProvenanceMap = ProvenanceMap.authored(),
    pass: RuntimePassOptions = {},
  ): Promise<unknown> {
    sanitizer ??= sensitiveSpliceSanitizer(secretBag);
    const records = new Map(
      (context.deferredExpressions ?? []).map((
        record,
      ) => [deferredExpressionReference(record.id), record]),
    );
    const resolvedReferences = new Map<string, unknown>();
    const resolving = new Set<string>();
    // Only the bindings an expression reads are resolved, so an unused
    // reference (a missing env var or vault key in another input) never
    // becomes a dependency of this expression. Resolved references are
    // memoized, so re-substituting per expression is cheap. `location` is
    // the authored expression being resolved, which a vault.get() in a
    // deferred binding is reported at.
    const withBindings = async (
      ctx: ExpressionContext,
      cel: string,
      location: string,
    ): Promise<ExpressionContext> => {
      const { inputs, self, run } = ctx;
      // The steps subtree is whole data (bindingTreeProvenance), so nothing
      // in it is ever spliced: the context's own steps stay, which keeps
      // the sources a step context carries under its symbol key
      // (typed-secrets 4.2); a rebuilt copy would drop them.
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
            // A typed capture carries each step's output sources as plain
            // data; they come back under the symbol key, and the plain key
            // never reaches CEL (typed-secrets 4.2).
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
        // A typed run evaluates vault.get as the CEL function: the evaluator
        // checks every direct call up front, refuses an alias, and issues
        // the sentinel on release into the step's bag
        // (design/enablers/typed-secrets.md Sections 3.4 and 4.4). Text that
        // is not CEL stays raw outside strict validation. The screen parses the
        // normalized source, with legacy bare-token arguments such as
        // vault.get(my-vault, a@b) already quoted as the evaluator parses
        // them; it records an alias rather than refusing it, so an alias
        // still reaches the typed evaluator and is refused there.
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
    for (const expr of expressions) {
      try {
        values.set(expr.raw, await resolve(expr, context));
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
    // Only this final splice is sanitized; the binding resolution above builds
    // context, which keeps raw values. An occurrence in data is never
    // substituted, even when an authored occurrence shares its raw text, and
    // neither is one in a subtree the pass skips.
    if (provenance.isAuthored) {
      return replaceExpressions(data, values, pass.skipPath, sanitizer);
    }
    return replaceExpressionsTracked(
      data,
      values,
      provenance,
      () => ({ map: ProvenanceMap.authored() }),
      pass.skipPath,
      sanitizer,
    ).data;
  }
}
