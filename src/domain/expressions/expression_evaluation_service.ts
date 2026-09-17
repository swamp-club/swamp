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
import type { Definition } from "../definitions/definition.ts";
import { Definition as DefinitionClass } from "../definitions/definition.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import {
  containsExpression,
  extractExpressions,
  replaceExpressions,
} from "./expression_parser.ts";
import { getLogger } from "@logtape/logtape";
import { type ASTNode, parse as parseCel } from "cel-js";
import type { ExpressionLocation } from "./expression.ts";
import {
  extractDependencies,
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
import type { SecretRedactor } from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
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
 * Pattern to detect vault.get() references inside a CEL expression.
 */
const VAULT_GET_PATTERN = /vault\.get\s*\(/;

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
 * CEL macros whose first argument binds a local variable for the remaining
 * arguments. A variable bound this way shadows the root `env` identifier.
 */
const BINDING_MACROS = new Set([
  "map",
  "filter",
  "all",
  "exists",
  "exists_one",
]);

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
 * Pattern matching every CEL string literal form: single- or double-quoted,
 * triple-quoted, with an optional bytes (`b`) and/or raw (`r`) prefix. Raw
 * strings have no escapes; the others honour backslash escapes. Triple-quoted
 * alternatives come first so `"""` is never read as an empty string followed
 * by an open quote. Stripping literals before classification keeps text such
 * as `self.tags["env"]` from being mistaken for an identifier reference.
 */
const STRING_LITERAL_PATTERN =
  /[bB]?(?:[rR](?:"""[\s\S]*?"""|'''[\s\S]*?'''|"[^"\n]*"|'[^'\n]*')|"""(?:[^\\]|\\[\s\S])*?"""|'''(?:[^\\]|\\[\s\S])*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;

/**
 * Pattern matching a member-access operator (`.` or optional `.?`) together
 * with any surrounding whitespace, so `self.tags . env` and `self.tags.?env`
 * normalise to `self.tags.env` and the member name is never taken for the
 * root `env` identifier.
 */
const MEMBER_ACCESS_PATTERN = /\s*\.\s*(?:\?\s*)?/g;

function stripStringLiterals(celExpression: string): string {
  return celExpression.replace(STRING_LITERAL_PATTERN, '""').replace(
    MEMBER_ACCESS_PATTERN,
    ".",
  );
}

/**
 * Checks whether a CEL expression references vault.get().
 * Expressions containing vault references must NOT be evaluated during
 * the persist phase — they are resolved at runtime only.
 */
export function containsVaultExpression(celExpression: string): boolean {
  return VAULT_GET_PATTERN.test(stripStringLiterals(celExpression));
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

/**
 * Splits expressions into those the author wrote and those CEL substitution
 * introduced, logging a warning for each rejection so an injection attempt is
 * visible in the run log.
 *
 * The raw expression text is logged because it is the reference, never a
 * resolved value — nothing has been evaluated at this point, and that is the
 * whole point of the rejection.
 */
export function partitionAuthored(
  expressions: ExpressionLocation[],
  authored: AuthoredExpressions,
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
    getLogger(["swamp", "expressions"]).warn(
      `Refusing to evaluate expression at ${expr.path}: it was not written in the definition or workflow source, so it arrived as data content. Left as literal text. Raw: ${expr.raw}`,
    );
  }
  return allowed;
}

/**
 * Result of resolving runtime expressions in a definition.
 * Includes the resolved definition and a VaultSecretBag containing
 * sentinel-to-value mappings for any vault secrets encountered.
 */
export interface RuntimeResolutionResult {
  definition: Definition;
  secretBag: VaultSecretBag;
}

/**
 * Result of evaluating a single definition.
 */
export interface EvaluatedDefinition {
  definition: Definition;
  type: ModelType;
  /** Whether any expressions were evaluated */
  hadExpressions: boolean;
}

/**
 * Domain service for evaluating CEL expressions in model definitions.
 */
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
    const expressions = partitionAuthored(extractExpressions(data), authored);
    if (expressions.length === 0) {
      return data;
    }

    // Evaluate CEL-only expressions; skip runtime expressions (vault, env)
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsRuntimeExpression(expr.celExpression)) {
        continue;
      }

      // Skip syntactically-invalid CEL: the ${{ ... }} sequence appears
      // inside a prose string (e.g. a plan body that documents expression
      // syntax). Leaving the raw text in place preserves prose round-trip.
      if (!this.celEvaluator.validate(expr.celExpression).valid) {
        continue;
      }

      const value = await this.celEvaluator.evaluateAsync(
        expr.celExpression,
        context,
      );
      evaluatedValues.set(expr.raw, value);
    }

    return replaceExpressions(data, evaluatedValues);
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
    inputs?: Record<string, unknown>,
    deferredExpressions: readonly DeferredExpression[] = [],
  ): Promise<ExpressionContext> {
    const ctx =
      requiresModelNamespace([definition.toData(), deferredExpressions])
        ? await this.modelResolver.buildContext()
        : this.modelResolver.buildLightContext();
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
   * @param inputValues - Optional input values to use in expression evaluation
   * @param context - Optional pre-built context (for batch evaluation)
   * @returns The evaluated definition
   */
  async evaluateDefinition(
    definition: Definition,
    type: ModelType,
    inputValues?: Record<string, unknown>,
    context?: ExpressionContext,
  ): Promise<EvaluatedDefinition> {
    const definitionData = definition.toData();

    // Build context if not provided.
    const ctx = context ??
      await this.buildRuntimeContext(definition, inputValues);

    // Add inputs to context if provided
    if (inputValues) {
      ctx.inputs = inputValues;
    }

    // Add self reference for the definition
    ctx.self = {
      id: definition.id,
      name: definition.name,
      version: definition.version,
      tags: definition.tags,
      globalArguments: definition.globalArguments,
    };

    // Extract expressions from definition data
    const expressions = extractExpressions(definitionData);

    if (expressions.length === 0) {
      return { definition, type, hadExpressions: false };
    }

    // Evaluate CEL-only expressions; skip runtime expressions (vault, env)
    // Runtime expressions are resolved at runtime only, never persisted
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsRuntimeExpression(expr.celExpression)) {
        // Leave runtime expressions (vault, env, and mixed) as raw
        continue;
      }

      // Skip expressions referencing model resource/file data that isn't
      // available in context (e.g., referenced model was never executed).
      // Unlike inputs, model data is never conditionally accessed in CEL —
      // member access on a missing model ref is always an error.
      let hasMissingModelDep = false;
      const deps = extractDependencies(expr.celExpression);
      for (const dep of deps) {
        if (dep.type === "resource" || dep.type === "file") {
          const modelData = ctx.model[dep.modelRef];
          if (
            !modelData ||
            (dep.type === "resource" && !modelData.resource) ||
            (dep.type === "file" && !modelData.file)
          ) {
            hasMissingModelDep = true;
            break;
          }
        }
      }

      if (hasMissingModelDep) {
        continue;
      }

      try {
        const value = await this.celEvaluator.evaluateAsync(
          expr.celExpression,
          ctx,
        );
        evaluatedValues.set(expr.raw, value);
      } catch {
        // Leave unresolved — CEL threw because an input referenced directly
        // (not inside a conditional branch) is absent from context.
        // The Proxy on globalArgs will surface a clear error if the method
        // actually needs the unresolved value.
      }
    }

    // Replace only the CEL-only expressions with evaluated values
    const evaluatedData = replaceExpressions(definitionData, evaluatedValues);

    // Create new Definition from evaluated data
    const evaluatedDefinition = DefinitionClass.fromData(
      evaluatedData as ReturnType<typeof definition.toData>,
    );

    return { definition: evaluatedDefinition, type, hadExpressions: true };
  }

  /** Replace parent-authored runtime input expressions with scoped references. */
  deferChildInputs(
    data: unknown,
    context: ExpressionContext,
    authored: AuthoredExpressions,
  ) {
    const deferredExpressions = [...(context.deferredExpressions ?? [])];
    const values = new Map<string, unknown>();
    let bindings: DeferredExpression["bindings"] | undefined;
    for (const expr of partitionAuthored(extractExpressions(data), authored)) {
      if (
        !containsRuntimeExpression(expr.celExpression) ||
        isDeferredExpression(expr.celExpression) || values.has(expr.raw)
      ) continue;
      const id = crypto.randomUUID();
      bindings ??= captureDeferredBindings(context);
      deferredExpressions.push({ id, expression: expr.raw, bindings });
      values.set(expr.raw, deferredExpressionReference(id));
    }
    return { data: replaceExpressions(data, values), deferredExpressions };
  }

  /**
   * Evaluates all definitions in dependency order.
   * Definitions are evaluated in topological order based on their expression dependencies.
   *
   * @returns Array of evaluated definitions
   * @throws CyclicDependencyError if circular dependencies are detected
   */
  async evaluateAllDefinitions(): Promise<EvaluatedDefinition[]> {
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
   * Vault secrets are replaced with sentinel tokens. The returned VaultSecretBag
   * maps sentinels to raw values, allowing the caller to resolve them appropriately:
   * - Non-shell contexts: VaultSecretBag.resolveDeep() for raw values
   * - Shell commands: VaultSecretBag.resolveForShell() for env var injection
   *
   * @param definition - The definition (may contain remaining ${{ vault.get(...) }} or ${{ env.* }} expressions)
   * @param redactor - Optional SecretRedactor to register resolved secret values for redaction
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
  ): Promise<RuntimeResolutionResult> {
    const logger = getLogger(["swamp", "expressions"]);
    const secretBag = new VaultSecretBag();
    const definitionData = definition.toData();
    const expressions = extractExpressions(definitionData);

    // Filter to only runtime expressions (vault or env), then to those the
    // author actually wrote — see AuthoredExpressions.
    const runtimeExpressions = partitionAuthored(
      expressions.filter((expr) =>
        containsRuntimeExpression(expr.celExpression)
      ),
      authored,
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

    const resolvedDefinition = await this.resolveRuntimeInExpressions(
      definitionData,
      runtimeExpressions,
      redactor,
      secretBag,
      expressionContext,
    );

    return { definition: resolvedDefinition, secretBag };
  }

  /**
   * Resolves remaining runtime expressions (vault and env) in arbitrary data.
   * This is the runtime phase — vault secrets and env variables are resolved here and never persisted.
   *
   * When vault secrets are present, sentinels are resolved to raw values inline
   * (no VaultSecretBag is returned). This is appropriate for non-shell data contexts.
   *
   * @param data - The data (may contain remaining runtime expressions)
   * @param redactor - Optional SecretRedactor to register resolved secret values for redaction
   * @param expressionContext - Optional context for CEL-evaluating dynamic vault.get() arguments
   * @param authored - Expressions the author wrote. See
   *   {@link resolveRuntimeExpressionsInDefinition}.
   * @returns The data with all runtime expressions resolved (sentinels replaced with raw values)
   */
  async resolveRuntimeExpressionsInData(
    data: unknown,
    redactor: SecretRedactor | undefined,
    expressionContext: ExpressionContext | undefined,
    authored: AuthoredExpressions,
  ): Promise<unknown> {
    const expressions = extractExpressions(data);
    const runtimeExpressions = partitionAuthored(
      expressions.filter((expr) =>
        containsRuntimeExpression(expr.celExpression)
      ),
      authored,
    );

    if (runtimeExpressions.length === 0) {
      return data;
    }

    const celContext: ExpressionContext = {
      model: {},
      ...expressionContext,
      env: buildEnvContext(),
    };
    const secretBag = new VaultSecretBag();
    const resolved = await this.resolveRuntimeData(
      data,
      runtimeExpressions,
      celContext,
      redactor,
      secretBag,
    );

    // For the data path, resolve sentinels to raw values immediately
    // since there's no shell context to worry about.
    if (!secretBag.isEmpty) {
      return secretBag.resolveDeep(resolved);
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
   *   2. {@link resolveRuntimeExpressionsInData} — env and vault. Vault
   *      values are resolved to raw strings and registered with the
   *      optional redactor for log scrubbing. The expression context is
   *      forwarded so dynamic vault.get() arguments can be CEL-evaluated.
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
  ): Promise<unknown> {
    const afterCel = await this.evaluateData(data, context, authored);
    return await this.resolveRuntimeExpressionsInData(
      afterCel,
      redactor,
      context,
      authored,
    );
  }

  /**
   * @deprecated Use resolveRuntimeExpressionsInDefinition instead.
   */
  async resolveVaultExpressionsInDefinition(
    definition: Definition,
  ): Promise<Definition> {
    // Legacy seam: callers hand in a definition they own, with no CEL
    // substitution applied, so every expression in it is author-written.
    const result = await this.resolveRuntimeExpressionsInDefinition(
      definition,
      undefined,
      undefined,
      "unrestricted",
    );
    // Legacy callers expect raw values, so resolve sentinels immediately
    if (!result.secretBag.isEmpty) {
      const data = result.definition.toData();
      const resolved = result.secretBag.resolveDeep(data);
      return DefinitionClass.fromData(
        resolved as ReturnType<Definition["toData"]>,
      );
    }
    return result.definition;
  }

  /**
   * @deprecated Use resolveRuntimeExpressionsInData instead.
   */
  resolveVaultExpressionsInData(data: unknown): Promise<unknown> {
    // Legacy seam: see resolveVaultExpressionsInDefinition.
    return this.resolveRuntimeExpressionsInData(
      data,
      undefined,
      undefined,
      "unrestricted",
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
  ): Promise<Definition> {
    const celContext: ExpressionContext = {
      model: {},
      ...expressionContext,
      self: {
        id: definitionData.id,
        name: definitionData.name,
        version: definitionData.version,
        tags: definitionData.tags,
        globalArguments: definitionData.globalArguments ?? {},
        ...expressionContext?.self,
      },
      env: buildEnvContext(),
    };
    const resolvedData = await this.resolveRuntimeData(
      definitionData,
      runtimeExpressions,
      celContext,
      redactor,
      secretBag ?? new VaultSecretBag(),
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
  ): Promise<unknown> {
    const records = new Map(
      (context.deferredExpressions ?? []).map((
        record,
      ) => [deferredExpressionReference(record.id), record]),
    );
    const resolvedReferences = new Map<string, unknown>();
    const resolving = new Set<string>();
    // The top-level context is identical for every non-deferred expression,
    // so its deferred bindings are substituted once per call. A record's
    // own expression evaluates against the parent's bindings instead and is
    // substituted per call.
    let substituted: Promise<ExpressionContext> | undefined;
    const withBindings = async (
      ctx: ExpressionContext,
    ): Promise<ExpressionContext> => {
      const { inputs, self, run, steps } = ctx;
      return {
        ...ctx,
        ...await resolveBindings({ inputs, self, run, steps }) as object,
      };
    };

    const resolveBindings = async (bindings: unknown): Promise<unknown> => {
      const values = new Map<string, unknown>();
      for (const expr of extractExpressions(bindings)) {
        if (records.has(expr.raw)) {
          values.set(expr.raw, await resolve(expr, context));
        }
      }
      return replaceExpressions(bindings, values);
    };
    const resolve = async (
      expr: ExpressionLocation,
      ctx: ExpressionContext,
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
        ) as typeof record.bindings;
        const value = await resolve(extractExpressions(record.expression)[0], {
          ...context,
          // Omitted parent bindings stay absent; never borrow the child's scope.
          inputs: bindings.inputs,
          self: bindings.self,
          run: bindings.run,
          workflowRunId: bindings.workflowRunId,
          steps: bindings.steps,
        });
        resolving.delete(expr.raw);
        resolvedReferences.set(expr.raw, value);
        return value;
      }
      if (isDeferredExpression(expr.celExpression)) return expr.raw;
      const celContext = !records.size
        ? ctx
        : ctx === context
        ? await (substituted ??= withBindings(ctx))
        : await withBindings(ctx);
      let cel = expr.celExpression;
      if (containsVaultExpression(cel)) {
        cel = await this.modelResolver.resolveVaultExpressions(
          cel,
          redactor,
          secretBag,
          { celEvaluator: this.celEvaluator, context: celContext },
        );
      }
      const validation = this.celEvaluator.validate(cel);
      if (!validation.valid) {
        if (containsVaultExpression(expr.celExpression)) {
          getLogger(["swamp", "expressions"]).warn(
            `Skipped vault expression at ${expr.path} because its CEL is syntactically invalid after vault resolution: ${validation.error}. Raw: ${expr.raw}`,
          );
        }
        return expr.raw;
      }
      return await this.celEvaluator.evaluateAsync(cel, celContext);
    };

    const values = new Map<string, unknown>();
    for (const expr of expressions) {
      values.set(expr.raw, await resolve(expr, context));
    }
    return replaceExpressions(data, values);
  }
}
