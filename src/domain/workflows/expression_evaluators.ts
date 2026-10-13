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
  isTaskInputsPath,
  isTaskTargetPath,
  isTriggerInputsPath,
  replaceExpressionsTracked,
  type SpliceOrigin,
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
import {
  isDefinitionArgumentPath,
  sensitiveSpliceSanitizer,
} from "../expressions/splice_pair.ts";
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
} from "../expressions/swamp_namespaces.ts";

/** Collect template expressions and bare assertion predicates from source. */
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
 * Builds the rule deciding which task-target expressions in `workflow` defer
 * past run-start evaluation. Shared by the run path and `workflow evaluate`,
 * whose cache `--last-evaluated` replays, so both leave the same targets raw.
 *
 * A step's task target — what it executes — defers for either of two
 * reasons, each sufficient on its own:
 *
 *   - it reads step output, so the data it names does not exist yet;
 *   - its step carries a guard, so the step may not run at all, and a
 *     target evaluated for a step that will skip is exactly the defect in
 *     swamp-club#2304: an empty result failed StepTask validation and killed
 *     the whole run before any step executed.
 *
 * An unguarded target with no step-output dependency still resolves at run
 * start, so a mistyped name fails where the error is cheapest — deferral buys
 * nothing for a step that is going to run.
 *
 * @param workflow - The unexpanded workflow whose expressions are evaluated
 * @returns True for an expression location that is a deferred task target
 */
export function createTaskTargetDeferral(
  workflow: Workflow,
): (expr: ExpressionLocation) => boolean {
  // Path prefixes of steps carrying a guard. Prefix matching is sound because
  // expression paths are positional — `jobs[i].steps[j].task.modelIdOrName` —
  // and derived from the same unexpanded definition walked here. forEach
  // changes nothing: expansion rewrites the job *run* at job start, long
  // after this.
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

/**
 * Result of evaluating a workflow's CEL expressions.
 * `expressionsEvaluated` is exposed for callers that record it as a
 * tracing-span attribute.
 */
export interface WorkflowEvaluationResult {
  workflow: Workflow;
  expressionsEvaluated: number;
  /**
   * Per step of `workflow`, its task inputs and global arguments with
   * sensitive data values replaced by sentinels, where evaluation spliced
   * any. Held in memory only; see {@link SanitizedTaskOverlay}.
   */
  sanitizedTasks?: SanitizedTaskOverlay;
  /** Where data sits in each evaluated step, keyed by Step instance. */
  stepProvenance: StepProvenanceOverlay;
  /** Where data sits in the evaluated workflow's data. */
  provenance: ProvenanceMap;
  /**
   * Another templating system's `${{ ... }}` text still in step arguments
   * after evaluation, for the caller to report: text that failed to evaluate
   * and was left raw, and text deferred to step time, where it is left raw
   * the same way if it fails there.
   */
  foreignTaskArguments: ForeignTaskArgument[];
}

/**
 * One `${{ ... }}` expression in a step's task that is another templating
 * system's (see {@link isForeignExpression}).
 */
export interface ForeignTaskArgument {
  jobName: string;
  stepName: string;
  /** Path within the task, such as `globalArgs.env.SHA`. */
  path: string;
  /** The text as written, such as `${{ github.sha }}`. */
  text: string;
  /**
   * Set when run-start evaluation deferred the expression (it also reads
   * `self.*`, `steps.*` or step output), so it has not been tried yet.
   */
  deferred?: true;
  /**
   * Set when a root nearly spells a swamp namespace (`input` for `inputs`),
   * so the text is more likely a typo than another system's.
   */
  misspelt?: MisspeltNamespace;
}

/** Where data sits in one evaluated step, relative to the step's data. */
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

  /** No data in any step. */
  static authored(): StepProvenanceOverlay {
    return new StepProvenanceOverlay(new Map());
  }

  /**
   * Builds the overlay from the evaluated workflow's maps, taking each step's
   * subtree at `jobs[i].steps[j]`.
   */
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

  /** The step's maps; authored when nothing in it is data. */
  forStep(step: Step | undefined): StepProvenance {
    const entry = step ? this.entries.get(step) : undefined;
    return entry ??
      { raw: ProvenanceMap.authored(), sanitized: ProvenanceMap.authored() };
  }
}

/** A step's task inputs and global arguments as the step should execute them. */
export interface SanitizedTaskFields {
  inputs?: unknown;
  globalArgs?: unknown;
}

/**
 * Sanitized task fields for the steps of one evaluated workflow, keyed by
 * the Step instance (forEach expansion keeps it, so every iteration shares
 * the entry). Its sentinels come from a workflow-level bag and are re-issued
 * from each step's own bag when the step reads them.
 */
export class SanitizedTaskOverlay {
  private constructor(
    /** The workflow-level bag the sanitized data's sentinels come from. */
    readonly bag: VaultSecretBag,
    private readonly entries: Map<Step, SanitizedTaskFields>,
    /** The whole evaluated workflow data with those sentinels in place. */
    readonly sanitizedData: WorkflowInput,
  ) {}

  /**
   * Builds the overlay from sanitized workflow data, keying each step's
   * fields by the Step instance at the same position of `evaluated`.
   */
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

  /**
   * The step's sanitized fields as evaluation spliced them, with the
   * workflow-level bag's sentinels, the coordinates its provenance map uses.
   */
  entryFor(step: Step): SanitizedTaskFields | undefined {
    return this.entries.get(step);
  }

  /** The step's sanitized fields, with sentinels issued from `stepBag`. */
  forStep(
    step: Step,
    stepBag: VaultSecretBag,
  ): SanitizedTaskFields | undefined {
    const entry = this.entries.get(step);
    if (!entry) return undefined;
    return {
      inputs: this.bag.rehomeDataSentinels(entry.inputs, stepBag),
      globalArgs: this.bag.rehomeDataSentinels(entry.globalArgs, stepBag),
    };
  }
}

const TASK_ARGUMENT_PATH =
  /^jobs\[\d+\]\.steps\[\d+\]\.task\.(?:inputs|globalArgs)(?:$|[.[])/;

/** A field of a step's task, with its job and step positions. */
const TASK_FIELD_PATH = /^jobs\[(\d+)\]\.steps\[(\d+)\]\.task\.(.+)$/;

/** A value inside a task's inputs or global arguments record. */
const NESTED_TASK_ARGUMENT = /^(?:inputs|globalArgs)[.[]/;

/**
 * Task fields that name what a step runs, or hold its arguments as one
 * whole-field record expression. Swamp must resolve these to run the step.
 */
const TASK_TARGET_OR_RECORD =
  /^(?:modelIdOrName|modelName|modelType|methodName|workflowIdOrName|inputs|globalArgs)$/;

/** Another templating system's `${{ ... }}` text in the tasks of a workflow. */
export interface ForeignTaskText {
  /** In step arguments: left raw, and reaches the method as literal text. */
  arguments: ForeignTaskArgument[];
  /**
   * In what the step runs, or as a whole-field record expression: swamp must
   * resolve it, so a run fails on it.
   */
  unresolvable: ForeignTaskArgument[];
}

/** Finds the foreign `${{ ... }}` text in the tasks of `workflow`, as authored. */
export function findForeignTaskText(workflow: Workflow): ForeignTaskText {
  const found: ForeignTaskText = { arguments: [], unresolvable: [] };
  for (const expr of extractExpressions(workflow.toData())) {
    const foreign = foreignTaskText(workflow, expr);
    if (!foreign) continue;
    if (NESTED_TASK_ARGUMENT.test(foreign.path)) {
      found.arguments.push(foreign);
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
  const misspelt = misspeltSwampNamespace(expr.celExpression);
  return {
    jobName: job.name,
    stepName: step.name,
    path: match[3],
    text: expr.raw,
    ...(misspelt ? { misspelt } : {}),
  };
}

/**
 * Evaluates CEL expressions in a workflow definition, leaving vault
 * expressions, runtime-only expressions, self.* references, run.* and
 * steps.* references, bare workflowRunId, forEach.in expressions,
 * task.inputs with step-output dependencies, and deferred task targets
 * raw. Those are resolved at runtime when their inputs become available.
 *
 * **Strict** about per-expression evaluation errors: any throw during
 * `evaluateAsync` propagates out, surfacing the error to the caller.
 * This pairs intentionally with DefinitionExpressionEvaluator's lenient
 * behaviour — workflows declare their evaluation order explicitly, so
 * a thrown CEL error is a real bug.
 *
 * The one exception is another templating system's text nested in a step's
 * task inputs or global arguments, such as GitHub Actions
 * `${{ github.sha }}` (swamp-club#2528). It is classified only after it
 * fails on its foreign root (any other error still propagates), left raw so
 * it reaches the method as literal text, and
 * returned in `foreignTaskArguments`, along with such text deferred to step
 * time.
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

    if (expressions.length === 0) {
      return {
        workflow,
        expressionsEvaluated: 0,
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

    // Deferral is decided per path, but substitution below is keyed on the raw
    // expression text and rewrites every occurrence of it. Two steps can carry
    // the identical expression — `${{ inputs.name }}` on a guarded step and on
    // a plain one — and without this the plain step's evaluated value would be
    // written into the guarded step's deferred target, silently undoing the
    // deferral. Recording which paths deferred lets them be skipped by path.
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
      // forEach.in expressions must remain as strings for expansion.
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
      // A step's task target defers when it reads step output or its step
      // carries a guard — see createTaskTargetDeferral.
      if (isDeferredTaskTarget(expr)) {
        deferredTargetPaths.add(expr.path);
        continue;
      }

      // Strict: per-expression eval errors propagate, except for another
      // templating system's text in a step argument, which stays raw.
      let value: unknown;
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
        failedForeignPaths.add(expr.path);
        continue;
      }
      evaluatedValues.set(expr.raw, value);
      origins.set(expr.raw, spliceOrigin(expr.celExpression, context, value));
    }

    // Foreign text no value will be spliced over: it failed above, or one of
    // the rules above deferred it to step time.
    const foreignTaskArguments: ForeignTaskArgument[] = [];
    for (const expr of expressions) {
      if (evaluatedValues.has(expr.raw)) continue;
      const foreign = foreignTaskText(workflow, expr);
      if (!foreign || !NESTED_TASK_ARGUMENT.test(foreign.path)) continue;
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
    const tracked = replaceExpressionsTracked(
      workflowData,
      evaluatedValues,
      sourceProvenance,
      originOf,
      skipPath,
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
 * Splices the same evaluated values into the step task inputs and global
 * arguments again, replacing recorded sensitive values with sentinels, and
 * keys the result by the evaluated workflow's Step instances. Returns
 * undefined when the run has recorded no sensitive value.
 */
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
  const bag = new VaultSecretBag();
  const sanitized = replaceExpressionsTracked(
    workflowData,
    values,
    provenance,
    originOf,
    skipPath,
    sensitiveSpliceSanitizer(
      sensitiveValues,
      bag,
      (path) => TASK_ARGUMENT_PATH.test(path),
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
 * Evaluates CEL expressions in a definition, leaving vault expressions
 * and runtime-only expressions raw.
 *
 * **Lenient** about per-expression evaluation errors: catches them and
 * leaves the expression unresolved. This pairs intentionally with
 * WorkflowExpressionEvaluator's strict behaviour — definitions are
 * built up over time and may legitimately reference inputs that are
 * absent when CEL eval first runs, for a method other than the one
 * being run. Each failure is returned with its reason, so the caller can
 * fail the step if the method it runs uses the value
 * (assertMethodArgumentsEvaluated); the Proxy on globalArgs covers
 * global arguments the method reads directly.
 *
 * See {@link evaluateDefinitionExpressions} for evaluation order and the
 * handling of model data that is not yet available.
 */
export class DefinitionExpressionEvaluator {
  constructor(
    private readonly celEvaluator:
      & CelExpressionEvaluator
      & CelExpressionValidator,
  ) {}

  /**
   * @param authored - Expressions the author wrote, collected from the
   *   workflow and model source before any substitution. A direct-execution
   *   definition is synthesised from step inputs that already had data
   *   substituted into them, so anything not in the set is data content and
   *   is left as literal text. `"unrestricted"` only for unsubstituted source.
   */
  async evaluate(
    definition: Definition,
    context: ExpressionContext,
    authored: AuthoredExpressions,
    secretBag?: VaultSecretBag,
    /** The executed copy's base when it already differs; see evaluateDefinitionExpressions. */
    sanitizedBase: Definition = definition,
    /** Where data already sits in `definition` and `sanitizedBase`. */
    provenance: DefinitionPassProvenance = AUTHORED_DEFINITION,
  ): Promise<{
    definition: Definition;
    /**
     * The definition to execute, with sensitive data values in its
     * arguments replaced by sentinels from `secretBag`. Equal to
     * `definition` when no bag was given or nothing sensitive was spliced.
     */
    sanitizedDefinition: Definition;
    failedExpressions: FailedExpressions;
    /** Where data sits in `definition`'s and `sanitizedDefinition`'s data. */
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
          sensitiveValues,
          secretBag,
          isDefinitionArgumentPath,
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
