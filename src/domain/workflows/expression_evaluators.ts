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

import { Definition } from "../definitions/definition.ts";
import type { Workflow, WorkflowInput } from "./workflow.ts";
import { Workflow as WorkflowClass } from "./workflow.ts";
import {
  containsExpression,
  extractExpressions,
  isAssertExprPath,
  isAssertMessagePath,
  isGuardPath,
  isStepNamePath,
  isTaskInputsPath,
  isTaskTargetPath,
  isTriggerInputsPath,
  replaceExpressionsTracked,
  type SpliceOrigin,
  type SpliceSanitizer,
} from "../expressions/expression_parser.ts";
import { ProvenanceMap } from "../expressions/provenance_map.ts";
import { spliceOrigin } from "../expressions/splice_origin.ts";
import { maskLiteralCalls } from "../expressions/cel_string_lexer.ts";
import {
  type AuthoredExpressions,
  containsRuntimeExpression,
  partitionAuthoredAt,
} from "../expressions/expression_evaluation_service.ts";
import {
  hasStepOutputDependency,
  hasStepsNamespaceReference,
} from "../expressions/dependency_extractor.ts";
import type { ExpressionLocation } from "../expressions/expression.ts";
import type { ExpressionContext } from "../expressions/model_resolver.ts";
import { sensitiveValuesOf } from "../expressions/sensitive_context.ts";
import type { RunSensitiveValues } from "../secrets/run_sensitive_values.ts";
import { sensitiveSpliceSanitizer } from "../expressions/splice_pair.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import type { Step } from "./step.ts";
import type {
  CelExpressionEvaluator,
  CelExpressionValidator,
} from "../expressions/cel_runtime.ts";
import {
  AUTHORED_DEFINITION,
  type DefinitionPassProvenance,
  evaluateDefinitionExpressions,
} from "../expressions/definition_expression_pass.ts";
import type { FailedExpressions } from "../expressions/unresolved_expression_guard.ts";
import {
  failedOnForeignRoot,
  isForeignExpression,
  type MisspeltNamespace,
  misspeltSwampNamespace,
  unlistedForeignRootError,
  unlistedForeignRoots,
} from "../expressions/swamp_namespaces.ts";

export function collectWorkflowAuthoredExpressions(
  workflow: Workflow,
  into: Set<string> = new Set(),
): Set<string> {
  for (
    const expr of extractExpressions(workflow.toData(), "", isAssertExprPath)
  ) {
    into.add(expr.raw);
  }
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const task = step.task.data;
      if (task.type === "assert") into.add(task.expr);
    }
  }
  return into;
}

/**
 * task targets defer past run-start evaluation when they read step output or
 * their step has a guard (a skipped step's empty target would fail validation);
 * unguarded targets resolve at start so typos fail early
 */
export function createTaskTargetDeferral(
  workflow: Workflow,
): (expr: ExpressionLocation) => boolean {
  // prefix matching is sound as expression paths are positional and derived
  // from the same unexpanded definition; forEach expansion happens later and
  // changes nothing here
  const guardedStepPrefixes: string[] = [];
  for (const [jobIndex, job] of workflow.jobs.entries()) {
    for (const [stepIndex, step] of job.steps.entries()) {
      if (step.guard) {
        guardedStepPrefixes.push(`jobs[${jobIndex}].steps[${stepIndex}].`);
      }
    }
  }
  return (expr) =>
    isTaskTargetPath(expr.path) &&
    (hasStepOutputDependency(expr.celExpression) ||
      guardedStepPrefixes.some((prefix) => expr.path.startsWith(prefix)));
}

export interface WorkflowEvaluationResult {
  workflow: Workflow;
  /** Distinct successfully evaluated raw expressions (kept for compatibility). */
  expressionsEvaluated: number;
  diagnostics: WorkflowEvaluationDiagnostics;
  /**
   * Per step of `workflow`, its task inputs and global arguments with
   * sensitive data values replaced by sentinels, where evaluation spliced
   * any. Held in memory only; see {@link SanitizedTaskOverlay}.
   */
  sanitizedTasks?: SanitizedTaskOverlay;
  stepProvenance: StepProvenanceOverlay;
  provenance: ProvenanceMap;
  /**
   * foreign ${{ }} text still in step arguments, for the caller to report: text
   * that failed to evaluate, and text deferred to step time, left raw the same
   * way if it fails there
   */
  foreignTaskArguments: ForeignTaskArgument[];
}

export interface WorkflowEvaluationDiagnostics {
  expressionOccurrences: number;
  distinctExpressions: number;
  celEvaluations: number;
  modelKeys: number;
  celDurationMs: number;
  provenanceDurationMs: number;
}

export interface ForeignTaskArgument {
  jobName: string;
  stepName: string;
  path: string;
  text: string;
  /**
   * Set when run-start evaluation deferred the expression (it also reads
   * `self.*`, `steps.*` or step output), so it has not been tried yet.
   */
  deferred?: true;
}

export interface UnlistedTaskArgument {
  jobName: string;
  stepName: string;
  path: string;
  text: string;
  roots: string[];
  misspelt?: MisspeltNamespace;
}

export interface StepProvenance {
  /** For the raw copy: CEL contexts, guards, caches. */
  raw: ProvenanceMap;
  /** For the sanitized copy the step executes. */
  sanitized: ProvenanceMap;
}

/**
 * Per step of an evaluated workflow, where data sits in it, keyed by the
 * Step instance like {@link SanitizedTaskOverlay} (forEach expansion keeps
 * the instance, so every iteration shares the entry).
 */
export class StepProvenanceOverlay {
  private constructor(private readonly entries: Map<Step, StepProvenance>) {}

  static authored(): StepProvenanceOverlay {
    return new StepProvenanceOverlay(new Map());
  }

  static fromWorkflowMaps(
    evaluated: Workflow,
    raw: ProvenanceMap,
    sanitized: ProvenanceMap,
  ): StepProvenanceOverlay {
    const entries = new Map<Step, StepProvenance>();
    if (raw.isAuthored && sanitized.isAuthored) {
      return new StepProvenanceOverlay(entries);
    }
    for (const [jobIndex, job] of evaluated.jobs.entries()) {
      for (const [stepIndex, step] of job.steps.entries()) {
        const path = `jobs[${jobIndex}].steps[${stepIndex}]`;
        entries.set(step, {
          raw: raw.subtree(path),
          sanitized: sanitized.subtree(path),
        });
      }
    }
    return new StepProvenanceOverlay(entries);
  }

  forStep(step: Step | undefined): StepProvenance {
    const entry = step ? this.entries.get(step) : undefined;
    return entry ??
      { raw: ProvenanceMap.authored(), sanitized: ProvenanceMap.authored() };
  }
}

export interface SanitizedTaskFields {
  inputs?: unknown;
  globalArgs?: unknown;
}

/**
 * sanitized task fields per step; sentinels come from a workflow-level bag and
 * are re-issued from each step's own bag when read, so the step ships what it
 * delivers
 */
export class SanitizedTaskOverlay {
  private constructor(
    readonly bag: VaultSecretBag,
    private readonly entries: Map<Step, SanitizedTaskFields>,
    readonly sanitizedData: WorkflowInput,
  ) {}

  static fromSanitizedData(
    bag: VaultSecretBag,
    sanitizedData: WorkflowInput,
    evaluated: Workflow,
  ): SanitizedTaskOverlay {
    const sanitized = sanitizedData as {
      jobs?: {
        steps?: { task?: { inputs?: unknown; globalArgs?: unknown } }[];
      }[];
    };
    const entries = new Map<Step, SanitizedTaskFields>();
    for (const [jobIndex, job] of evaluated.jobs.entries()) {
      for (const [stepIndex, step] of job.steps.entries()) {
        const task = sanitized.jobs?.[jobIndex]?.steps?.[stepIndex]?.task;
        if (task) {
          entries.set(step, {
            inputs: task.inputs,
            globalArgs: task.globalArgs,
          });
        }
      }
    }
    return new SanitizedTaskOverlay(bag, entries, sanitizedData);
  }

  entryFor(step: Step): SanitizedTaskFields | undefined {
    return this.entries.get(step);
  }

  forStep(
    step: Step,
    stepBag: VaultSecretBag,
  ): SanitizedTaskFields | undefined {
    const entry = this.entries.get(step);
    if (!entry) return undefined;
    return {
      inputs: this.bag.rehomeSentinels(entry.inputs, stepBag),
      globalArgs: this.bag.rehomeSentinels(entry.globalArgs, stepBag),
    };
  }
}

const TASK_FIELD_PATH = /^jobs\[(\d+)\]\.steps\[(\d+)\]\.task\.(.+)$/;

const NESTED_TASK_ARGUMENT = /^(?:inputs|globalArgs)[.[]/;

/**
 * Task fields that name what a step runs, or hold its arguments as one
 * whole-field record expression. Swamp must resolve these to run the step.
 */
const TASK_TARGET_OR_RECORD =
  /^(?:modelIdOrName|modelName|modelType|methodName|workflowIdOrName|inputs|globalArgs)$/;

export interface ForeignTaskText {
  /**
   * In step arguments, with every foreign root a known one: left raw, and
   * reaches the method as literal text.
   */
  arguments: ForeignTaskArgument[];
  /** In step arguments, reading an unlisted root: a run fails on it. */
  unlisted: UnlistedTaskArgument[];
  /**
   * In what the step runs, or as a whole-field record expression: swamp must
   * resolve it, so a run fails on it.
   */
  unresolvable: ForeignTaskArgument[];
}

export function findForeignTaskText(workflow: Workflow): ForeignTaskText {
  const found: ForeignTaskText = {
    arguments: [],
    unlisted: [],
    unresolvable: [],
  };
  for (const expr of extractExpressions(workflow.toData())) {
    const foreign = foreignTaskText(workflow, expr);
    if (!foreign) continue;
    if (NESTED_TASK_ARGUMENT.test(foreign.path)) {
      const roots = unlistedForeignRoots(expr.celExpression);
      if (roots.length === 0) {
        found.arguments.push(foreign);
        continue;
      }
      const misspelt = misspeltSwampNamespace(expr.celExpression);
      found.unlisted.push({
        ...foreign,
        roots,
        ...(misspelt ? { misspelt } : {}),
      });
    } else if (TASK_TARGET_OR_RECORD.test(foreign.path)) {
      found.unresolvable.push(foreign);
    }
  }
  return found;
}

function foreignTaskText(
  workflow: Workflow,
  expr: ExpressionLocation,
): ForeignTaskArgument | undefined {
  const match = TASK_FIELD_PATH.exec(expr.path);
  if (!match || !isForeignExpression(expr.celExpression)) return undefined;
  const job = workflow.jobs[Number(match[1])];
  const step = job?.steps[Number(match[2])];
  if (!job || !step) return undefined;
  return {
    jobName: job.name,
    stepName: step.name,
    path: match[3],
    text: expr.raw,
  };
}

/**
 * strict: evaluation errors propagate; the exception is foreign text (e.g. ${{
 * github.sha }}) in task inputs or global args failing on a known foreign root,
 * left raw and returned; unlisted roots still fail
 */
export class WorkflowExpressionEvaluator {
  constructor(private readonly celEvaluator: CelExpressionEvaluator) {}

  async evaluate(
    workflow: Workflow,
    context: ExpressionContext,
    authored: AuthoredExpressions,
    /**
     * Where data already sits in the workflow's data: authored for a
     * workflow loaded from source, the cached map on replay.
     */
    sourceProvenance: ProvenanceMap = ProvenanceMap.authored(),
  ): Promise<WorkflowEvaluationResult> {
    const workflowData = workflow.toData();
    const expressions = partitionAuthoredAt(
      extractExpressions(workflowData, "", isAssertExprPath),
      authored,
      sourceProvenance,
    );
    const diagnostics: WorkflowEvaluationDiagnostics = {
      expressionOccurrences: expressions.length,
      distinctExpressions: new Set(expressions.map((expr) => expr.raw)).size,
      celEvaluations: 0,
      modelKeys: Object.keys(context.model).length,
      celDurationMs: 0,
      provenanceDurationMs: 0,
    };

    if (expressions.length === 0) {
      return {
        workflow,
        expressionsEvaluated: 0,
        diagnostics,
        stepProvenance: StepProvenanceOverlay.fromWorkflowMaps(
          workflow,
          sourceProvenance,
          sourceProvenance,
        ),
        provenance: sourceProvenance,
        foreignTaskArguments: [],
      };
    }

    // Collect forEach.in expressions to skip during evaluation. They
    // remain as strings so forEach expansion can iterate them at run
    // time.
    const forEachInExpressions = new Set<string>();
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (step.forEach && containsExpression(step.forEach.in)) {
          forEachInExpressions.add(step.forEach.in);
        }
      }
    }
    const isDeferredTaskTarget = createTaskTargetDeferral(workflow);

    // deferral is decided per path but substitution is keyed on raw text and
    // rewrites every occurrence, so a plain step's value would overwrite a
    // guarded step's deferred target; skip deferred paths by path
    const deferredTargetPaths = new Set<string>();

    const evaluatedValues = new Map<string, unknown>();
    const origins = new Map<string, SpliceOrigin>();
    const failedForeignPaths = new Set<string>();
    for (const expr of expressions) {
      if (containsRuntimeExpression(expr.celExpression)) {
        continue;
      }
      // A literal() argument is text, so it never reads a namespace.
      const code = maskLiteralCalls(expr.celExpression);
      // self.* references forEach variables resolved at runtime.
      if (code.match(/\bself\??\./)) {
        continue;
      }
      // run.* and workflowRunId are only available at step execution
      // time, after the WorkflowRun is created.
      if (
        code.match(/\brun\./) ||
        code.match(/\bworkflowRunId\b/)
      ) {
        continue;
      }
      // steps.* is populated alongside run.*, once the WorkflowRun exists —
      // evaluating it here fails the whole run with "Unknown variable: steps".
      if (hasStepsNamespaceReference(expr.celExpression)) {
        continue;
      }
      if (forEachInExpressions.has(expr.raw)) {
        continue;
      }
      // trigger.inputs are resolved at fire time (TriggerInputResolver for
      // webhook runs; static literals for scheduled runs), not during
      // workflow-body evaluation — leave them raw so a `webhook.*` reference
      // doesn't evaluate against a context that lacks the payload.
      if (isTriggerInputsPath(expr.path)) {
        continue;
      }
      // Guard expressions are evaluated at step execution time — they check
      // runtime state (data outputs, forEach variables) to decide idempotent
      // skips.
      if (isGuardPath(expr.path)) {
        continue;
      }
      // task.inputs and assert task.message that depend on step outputs
      // are evaluated at step execution time when upstream step outputs
      // are available.
      if (
        (isTaskInputsPath(expr.path) || isAssertMessagePath(expr.path)) &&
        hasStepOutputDependency(expr.celExpression)
      ) {
        continue;
      }
      if (isDeferredTaskTarget(expr)) {
        deferredTargetPaths.add(expr.path);
        continue;
      }

      // strict: errors propagate except foreign text in a step argument, which
      // stays raw; CEL stops at the first unknown name, so every root is
      // checked and the error names the unlisted one
      let value: unknown;
      diagnostics.celEvaluations++;
      const celStarted = performance.now();
      try {
        value = await this.celEvaluator.evaluateAsync(
          expr.celExpression,
          context,
        );
      } catch (error) {
        const foreign = foreignTaskText(workflow, expr);
        if (
          !foreign || !NESTED_TASK_ARGUMENT.test(foreign.path) ||
          !failedOnForeignRoot(error)
        ) throw error;
        const unlisted = unlistedForeignRootError(
          expr.celExpression,
          expr.path,
          error,
        );
        if (unlisted) throw unlisted;
        failedForeignPaths.add(expr.path);
        continue;
      } finally {
        diagnostics.celDurationMs += performance.now() - celStarted;
      }
      evaluatedValues.set(expr.raw, value);
      const provenanceStarted = performance.now();
      origins.set(expr.raw, spliceOrigin(expr.celExpression, context, value));
      diagnostics.provenanceDurationMs += performance.now() - provenanceStarted;
    }

    // Foreign text no value will be spliced over: it failed above, or one of
    // the rules above deferred it to step time.
    const foreignTaskArguments: ForeignTaskArgument[] = [];
    for (const expr of expressions) {
      if (evaluatedValues.has(expr.raw)) continue;
      const foreign = foreignTaskText(workflow, expr);
      if (!foreign || !NESTED_TASK_ARGUMENT.test(foreign.path)) continue;
      // Deferred text reading an unlisted root fails when its step runs.
      if (unlistedForeignRoots(expr.celExpression).length > 0) continue;
      foreignTaskArguments.push(
        failedForeignPaths.has(expr.path)
          ? foreign
          : { ...foreign, deferred: true },
      );
    }

    const skipPath = (path: string) =>
      isAssertExprPath(path) || deferredTargetPaths.has(path);
    const originOf = (raw: string) =>
      origins.get(raw) ?? { map: ProvenanceMap.data() };
    const sensitiveValues = sensitiveValuesOf(context);
    const tracked = replaceExpressionsTracked(
      workflowData,
      evaluatedValues,
      sourceProvenance,
      originOf,
      skipPath,
      sensitiveValues ? stepNameSanitizer(sensitiveValues) : undefined,
    );
    const evaluated = WorkflowClass.fromData(tracked.data as WorkflowInput);
    const sanitizedTasks = sanitizeTasks(
      workflowData,
      evaluatedValues,
      skipPath,
      context,
      evaluated,
      sourceProvenance,
      originOf,
    );
    return {
      workflow: evaluated,
      expressionsEvaluated: evaluatedValues.size,
      diagnostics,
      sanitizedTasks: sanitizedTasks?.overlay,
      stepProvenance: StepProvenanceOverlay.fromWorkflowMaps(
        evaluated,
        tracked.provenance,
        sanitizedTasks?.provenance ?? tracked.provenance,
      ),
      provenance: tracked.provenance,
      foreignTaskArguments,
    };
  }
}

/**
 * keeps a secret out of a step name: a recorded value (or a typed run's
 * sentinel) spliced into one becomes its stand-in, applied per path because
 * substitution is keyed on raw text
 */
function stepNameSanitizer(values: RunSensitiveValues): SpliceSanitizer {
  const sanitizer = sensitiveSpliceSanitizer(
    new VaultSecretBag(values.sentinels),
  );
  return {
    whole: (value, path) =>
      isStepNamePath(path) && typeof value === "string"
        ? values.withPlaceholders(value)
        : value,
    embedded: (text, path, value) => {
      const rendered = sanitizer.embedded(text, path, value);
      return isStepNamePath(path)
        ? values.withPlaceholders(rendered)
        : rendered;
    },
  };
}

function sanitizeTasks(
  workflowData: ReturnType<Workflow["toData"]>,
  values: Map<string, unknown>,
  skipPath: (path: string) => boolean,
  context: ExpressionContext,
  evaluated: Workflow,
  provenance: ProvenanceMap,
  originOf: (raw: string) => SpliceOrigin,
): { overlay: SanitizedTaskOverlay; provenance: ProvenanceMap } | undefined {
  const sensitiveValues = sensitiveValuesOf(context);
  if (!sensitiveValues || sensitiveValues.isEmpty) return undefined;
  const bag = new VaultSecretBag(sensitiveValues.sentinels);
  const sanitized = replaceExpressionsTracked(
    workflowData,
    values,
    provenance,
    originOf,
    skipPath,
    sensitiveSpliceSanitizer(
      bag,
    ),
  );
  if (bag.isEmpty) return undefined;
  return {
    overlay: SanitizedTaskOverlay.fromSanitizedData(
      bag,
      sanitized.data as WorkflowInput,
      evaluated,
    ),
    provenance: sanitized.provenance,
  };
}

/**
 * lenient: evaluation errors leave the expression unresolved, as definitions
 * may reference inputs absent for a method not being run; failures are returned
 * so the caller can fail the step if its method uses them
 */
export class DefinitionExpressionEvaluator {
  constructor(
    private readonly celEvaluator:
      & CelExpressionEvaluator
      & CelExpressionValidator,
  ) {}

  /**
   * authored: expressions the author wrote, collected before substitution; a
   * direct-execution definition is built from already-substituted inputs, so
   * anything not in the set is data, left literal
   */
  async evaluate(
    definition: Definition,
    context: ExpressionContext,
    authored: AuthoredExpressions,
    secretBag?: VaultSecretBag,
    sanitizedBase: Definition = definition,
    provenance: DefinitionPassProvenance = AUTHORED_DEFINITION,
  ): Promise<{
    definition: Definition;
    sanitizedDefinition: Definition;
    failedExpressions: FailedExpressions;
    provenance: DefinitionPassProvenance;
  }> {
    const definitionData = definition.toData();
    const expressions = partitionAuthoredAt(
      extractExpressions(definitionData),
      authored,
      provenance.raw,
    ).filter((expr) => !containsRuntimeExpression(expr.celExpression));

    if (expressions.length === 0) {
      return {
        definition,
        sanitizedDefinition: sanitizedBase,
        failedExpressions: new Map(),
        provenance,
      };
    }

    const sensitiveValues = sensitiveValuesOf(context);
    const {
      data,
      sanitizedData,
      failedExpressions,
      provenance: rawOut,
      sanitizedProvenance,
    } = await evaluateDefinitionExpressions(
      definitionData,
      expressions,
      context,
      this.celEvaluator,
      secretBag && sensitiveValues
        ? sensitiveSpliceSanitizer(
          secretBag,
        )
        : undefined,
      sanitizedBase.toData(),
      provenance,
    );
    const evaluated = Definition.fromData(data);
    return {
      definition: evaluated,
      sanitizedDefinition: sanitizedData
        ? Definition.fromData(sanitizedData)
        : evaluated,
      failedExpressions,
      provenance: {
        raw: rawOut,
        sanitized: sanitizedData ? sanitizedProvenance ?? rawOut : rawOut,
      },
    };
  }
}
