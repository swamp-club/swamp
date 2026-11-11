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

import type { Job } from "./job.ts";
import type { Workflow } from "./workflow.ts";
import { workflowDeclaresInputs, WorkflowSchema } from "./workflow.ts";
import { WorkflowSchemaError } from "./workflow_schema_error.ts";
import type { WorkflowRepository } from "./repositories.ts";
import { mergePlacementFields, resolvePlacement } from "./placement.ts";
import { describePlacement } from "../remote/scheduler.ts";
import { createWorkflowId } from "./workflow_id.ts";
import { schemaExpressions } from "./signal_wait.ts";
import {
  CyclicDependencyError,
  DuplicateNodeNameError,
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";
import {
  extractInputReferences,
  extractWholeFieldInputRef,
} from "../expressions/expression_parser.ts";
import { extractVaultReferences } from "../expressions/vault_reference_extractor.ts";
import { inputDescriptionPaths } from "../expressions/description_paths.ts";
import type { DataOutputOverride } from "../models/data_output_override.ts";
import { FOREIGN_TEMPLATE_WARNING_NAME } from "../models/validation_service.ts";
import { literalSensitiveGlobalArgsMessage } from "../models/sensitive_field_extractor.ts";
import { findForeignTaskText } from "./expression_evaluators.ts";
import {
  atSteps,
  type ReservedTagLookups,
  reservedWorkflowTags,
} from "./reserved_workflow_tags.ts";

import {
  containsExpression,
  extractExpressions,
  isAssertExprPath,
} from "../expressions/expression_parser.ts";
import type { SecretMisuseFinding } from "../models/validation_service.ts";
import { freeRoots, literalCallTexts } from "../expressions/cel_grammar.ts";
import {
  isForeignExpression,
  refusedOccurrenceLine,
  storedTextRefusal,
} from "../expressions/swamp_namespaces.ts";

const STORED_DATA_ROOTS = ["data", "model", "file"];

export class WorkflowValidationResult {
  private constructor(
    readonly name: string,
    readonly passed: boolean,
    readonly warning: boolean,
    readonly error?: string,
    readonly code?: string,
    readonly location?: string,
  ) {}

  static pass(name: string): WorkflowValidationResult {
    return new WorkflowValidationResult(name, true, false);
  }

  static warning(name: string, message: string): WorkflowValidationResult {
    return new WorkflowValidationResult(name, true, true, message);
  }

  static fail(
    name: string,
    error: string,
    diagnostic?: { code: string; location: string },
  ): WorkflowValidationResult {
    return new WorkflowValidationResult(
      name,
      false,
      false,
      error,
      diagnostic?.code,
      diagnostic?.location,
    );
  }

  equals(other: WorkflowValidationResult): boolean {
    return (
      this.name === other.name &&
      this.passed === other.passed &&
      this.warning === other.warning &&
      this.error === other.error &&
      this.code === other.code && this.location === other.location
    );
  }
}

/**
 * definitionProvidedArgs are merged at runtime as fallbacks under step inputs,
 * so the validator treats them as satisfying required arguments
 */
export type MethodResolution =
  | {
    status: "resolved";
    requiredArgs: string[];
    definitionProvidedArgs?: string[];
    definitionProvidedArgValues?: Record<string, unknown>;
    literalSensitiveGlobals?: string[];
    /**
     * the definition's own tags are checked with the workflow's through
     * findDefinition; this covers the type's spec defaults, which the step
     * refuses when it runs
     */
    reservedTagRefusal?: string;
  }
  | { status: "model_not_found" }
  | { status: "method_not_found"; modelType: string }
  | { status: "type_unresolvable"; modelType: string };

export interface ModelMethodResolver {
  resolve(
    modelIdOrName: string,
    methodName: string,
    modelType?: string,
  ): Promise<MethodResolution>;
}

export interface SensitiveOutputVaultResolver {
  targetVaults(step: {
    modelIdOrName: string;
    methodName: string;
    modelType?: string;
    dataOutputOverrides: ReadonlyArray<DataOutputOverride>;
  }): Promise<string[] | undefined>;
}

export interface WorkflowValidationService {
  validate(workflow: Workflow): Promise<WorkflowValidationResult[]>;
}

/**
 * input-schema annotations are collected from schema nodes separately, so
 * argument data named description is not skipped
 */
const PROSE_DESCRIPTION_PATH =
  /^(?:jobs\[\d+\](?:\.steps\[\d+\])?\.)?description$/;

/** guards and assert exprs written without ${{ }} are CEL all the same */
function bareStepExpressions(
  workflow: Workflow,
): { celExpression: string; path: string }[] {
  const expressions: { celExpression: string; path: string }[] = [];
  for (const [jobIndex, job] of workflow.jobs.entries()) {
    for (const [stepIndex, step] of job.steps.entries()) {
      const path = `jobs[${jobIndex}].steps[${stepIndex}]`;
      if (step.guard && !containsExpression(step.guard)) {
        expressions.push({
          celExpression: step.guard,
          path: `${path}.guard`,
        });
      }
      const task = step.task.toData();
      if (task.type === "assert" && !containsExpression(task.expr)) {
        expressions.push({
          celExpression: task.expr,
          path: `${path}.task.expr`,
        });
      }
    }
  }
  return expressions;
}

function overloadHint(reason: string, path: string): string {
  if (!reason.startsWith("found no matching overload")) return "";
  return path === "forEach.in"
    ? ". swamp's CEL has no function or overload that takes these arguments; " +
      "build the list from a literal, an input or data"
    : ". swamp's CEL has no function or overload that takes these arguments";
}

function expressionLocation(
  workflow: Workflow,
  path: string,
): { name: string; path: string } {
  const match = /^jobs\[(\d+)\](?:\.steps\[(\d+)\])?\.?/.exec(path);
  const job = match ? workflow.jobs[Number(match[1])] : undefined;
  if (!match || !job) return { name: "Task expressions", path };
  // task arguments are named as the foreign-text check names them
  const relative = path.slice(match[0].length).replace(
    /^task\.(?=(?:inputs|globalArgs)[.[])/,
    "",
  );
  const step = match[2] === undefined ? undefined : job.steps[Number(match[2])];
  return step
    ? {
      name: `Task expressions in job '${job.name}' step '${step.name}'`,
      path: relative,
    }
    : { name: `Expressions in job '${job.name}'`, path: relative };
}

export class DefaultWorkflowValidationService
  implements WorkflowValidationService {
  private readonly sortService = new TopologicalSortService();

  constructor(
    private readonly methodResolver?: ModelMethodResolver,
    private readonly workflowRepo?: WorkflowRepository,
    private readonly sensitiveOutputVaults?: SensitiveOutputVaultResolver,
    private readonly findDefinition?: ReservedTagLookups["findDefinition"],
    private readonly diagnoseSecrets?: (
      expression: string,
      location: string,
      workflow: Workflow,
      embedded?: boolean,
    ) => readonly SecretMisuseFinding[],
    private readonly checkExpressionTypes?: (
      expression: string,
    ) => string | undefined,
  ) {}

  async validate(workflow: Workflow): Promise<WorkflowValidationResult[]> {
    const results: WorkflowValidationResult[] = [];

    results.push(this.validateSchema(workflow));

    results.push(this.validateUniqueJobNames(workflow));

    results.push(...this.validateUniqueStepNames(workflow));

    results.push(this.validateJobDependencyRefs(workflow));

    results.push(...this.validateStepDependencyRefs(workflow));

    results.push(this.validateNoJobCycles(workflow));

    results.push(...this.validateNoStepCycles(workflow));

    if (this.methodResolver || this.workflowRepo) {
      results.push(...await this.validateStepInputs(workflow));
    }

    if (this.methodResolver) {
      results.push(
        ...await this.validateGlobalArgInputRefs(workflow),
      );
    }

    results.push(...this.validateQueueTimeoutPlacement(workflow));

    results.push(...this.validateAssertExprNotInterpolated(workflow));
    for (const result of this.validateWaitSchemaExpressions(workflow)) {
      results.push(result);
    }
    for (const result of this.validateWaitAutoResumeDeclared(workflow)) {
      results.push(result);
    }
    for (const result of this.validateWaitKeys(workflow)) {
      results.push(result);
    }

    results.push(...this.validateAffinityPlacement(workflow));

    results.push(...this.validateGuardExpressionTypes(workflow));

    for (const result of this.validateForEachSameJobDataReads(workflow)) {
      results.push(result);
    }

    results.push(...this.validateWritesPlacement(workflow));

    for (const result of await this.validateVaultsList(workflow)) {
      results.push(result);
    }

    for (const result of this.validateForeignTaskText(workflow)) {
      results.push(result);
    }

    for (const result of this.validateSecretUsage(workflow)) {
      results.push(result);
    }

    for (const result of this.validateExpressionTypes(workflow)) {
      results.push(result);
    }

    for (const result of await this.validateReservedTags(workflow)) {
      results.push(result);
    }

    for (const result of this.validateDirectGlobalArgLiterals(workflow)) {
      results.push(result);
    }

    return results;
  }

  /**
   * a run stores another system's text from literal() as text and refuses
   * swamp's own; this fails what a run refuses, wherever literal() sits.
   * Sensitive-field expression text needs the type's schema, not checked here
   */
  private validateDirectGlobalArgLiterals(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        const taskData = step.task?.data;
        if (
          taskData?.type !== "model_method" || !taskData.modelType ||
          typeof taskData.globalArgs !== "object"
        ) continue;
        for (const authored of extractExpressions(taskData.globalArgs)) {
          if (!authored.celExpression.includes("literal")) continue;
          const produced = literalCallTexts(authored.celExpression) ?? [];
          for (const expr of produced.flatMap((t) => extractExpressions(t))) {
            const reason = storedTextRefusal(expr.celExpression);
            if (reason === undefined) continue;
            results.push(WorkflowValidationResult.fail(
              `Task expressions in job '${job.name}' step '${step.name}'`,
              `globalArgs.${authored.path} holds literal() output that a run refuses to save in the step's definition:\n${
                refusedOccurrenceLine(
                  `globalArgs.${authored.path}`,
                  expr.raw,
                  reason,
                )
              }\nA global argument stores another system's expression text as text, and refuses swamp's own expressions. Pass the value as a step input for a method argument instead`,
            ));
          }
        }
      }
    }
    return results;
  }

  private validateSecretUsage(workflow: Workflow): WorkflowValidationResult[] {
    if (!this.diagnoseSecrets) return [];
    // prose and input-schema descriptions may document expression syntax;
    // actual values, including schema defaults, are still diagnosed even when a
    // value has a property named description
    const inputDescriptions = inputDescriptionPaths(workflow.inputs);
    const expressions: {
      celExpression: string;
      path: string;
      embedded?: boolean;
    }[] = extractExpressions(
      workflow.toData(),
      "",
      (path) =>
        PROSE_DESCRIPTION_PATH.test(path) || inputDescriptions.has(path),
    );
    for (const expression of bareStepExpressions(workflow)) {
      expressions.push(expression);
    }
    return expressions.flatMap(({ celExpression, path, embedded }) =>
      this.diagnoseSecrets!(celExpression, path, workflow, embedded).map((
        finding,
      ) =>
        WorkflowValidationResult.fail(
          "Secret usage",
          `${finding.code} at "${finding.location}": ${finding.reason}`,
          finding,
        )
      )
    );
  }

  /**
   * only jobs are read: workflow input values and schema defaults are inert,
   * and trigger.inputs are evaluated only when a webhook route fires the run
   */
  private validateExpressionTypes(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    if (!this.checkExpressionTypes) return [];
    const expressions: { celExpression: string; path: string; raw?: string }[] =
      [];
    for (const [jobIndex, job] of workflow.toData().jobs.entries()) {
      const found = extractExpressions(
        job,
        `jobs[${jobIndex}]`,
        // an assert expr inside ${{ }} is already refused on its own
        (path) => PROSE_DESCRIPTION_PATH.test(path) || isAssertExprPath(path),
      );
      for (const expression of found) expressions.push(expression);
    }
    for (const expression of bareStepExpressions(workflow)) {
      expressions.push(expression);
    }
    const results: WorkflowValidationResult[] = [];
    for (const { celExpression, path, raw } of expressions) {
      if (isForeignExpression(celExpression)) continue;
      const reason = this.checkExpressionTypes(celExpression);
      if (reason === undefined) continue;
      const location = expressionLocation(workflow, path);
      results.push(
        WorkflowValidationResult.fail(
          location.name,
          `${location.path} holds ${
            raw ?? celExpression
          }, which a run refuses: ${reason}` +
            overloadHint(reason, location.path),
        ),
      );
    }
    return results;
  }

  private async validateReservedTags(
    workflow: Workflow,
  ): Promise<WorkflowValidationResult[]> {
    const repo = this.workflowRepo;
    const found = await reservedWorkflowTags(workflow, {
      findDefinition: this.findDefinition,
      findWorkflow: repo
        ? async (idOrName) =>
          await repo.findByName(idOrName) ??
            await repo.findById(createWorkflowId(idOrName))
        : undefined,
    });
    if (found.length === 0) return [WorkflowValidationResult.pass("Tags")];
    return found.map(({ steps: [first, ...rest], refusal }) =>
      WorkflowValidationResult.fail(
        first
          ? `Tags for '${first.stepName}' in job '${first.jobName}'${
            first.workflow ? ` (workflow '${first.workflow}')` : ""
          }`
          : "Tags",
        atSteps({ steps: rest, refusal }).text,
      )
    );
  }

  /**
   * foreign text in task inputs or global arguments reaches the method as
   * literal text, so it only warns; an unknown root fails here as a run fails
   * with Unknown variable, even in a branch a run would never evaluate
   */
  private validateForeignTaskText(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const { arguments: passed, unlisted, unresolvable } = findForeignTaskText(
      workflow,
    );
    return [
      ...passed.map(({ jobName, stepName, path, text }) =>
        WorkflowValidationResult.warning(
          `${FOREIGN_TEMPLATE_WARNING_NAME} in job '${jobName}' step '${stepName}'`,
          `${path} holds ${text}, which is not a swamp expression and is passed to the method unchanged. ` +
            `If you meant a swamp expression, reference one of swamp's namespaces (model, self, inputs, env, vault, data)`,
        )
      ),
      ...unlisted.map(({ jobName, stepName, path, text, roots, misspelt }) =>
        WorkflowValidationResult.fail(
          `Task expressions in job '${jobName}' step '${stepName}'`,
          `${path} holds ${text}: ${
            roots.map((root) => `'${root}'`).join(", ")
          } ${
            roots.length === 1
              ? "is not a swamp namespace or a known templating root"
              : "are not swamp namespaces or known templating roots"
          }, so a run fails with "Unknown variable". ` +
            (misspelt ? `Did you mean '${misspelt.namespace}'? ` : "") +
            `If it is another templating system's text, write it with literal()`,
        )
      ),
      ...unresolvable.map(({ jobName, stepName, path, text }) =>
        WorkflowValidationResult.fail(
          `Task expressions in job '${jobName}' step '${stepName}'`,
          `${path} holds ${text}, which is not a swamp expression. ` +
            `Another templating system's text is only passed through inside a step's inputs or globalArgs`,
        )
      ),
    ];
  }

  /**
   * the run-time check is the guarantee for dynamic vault names and for
   * vault.get inside model definitions
   */
  private async validateVaultsList(
    workflow: Workflow,
  ): Promise<WorkflowValidationResult[]> {
    if (workflow.vaults === undefined) return [];
    const listed = new Set(workflow.vaults);
    const results: WorkflowValidationResult[] = [];
    const data = workflow.toData();
    const { staticRefs } = extractVaultReferences(
      data.jobs,
      data.inputs,
      data.trigger,
    );
    const unlisted = [
      ...new Set(
        staticRefs.map((ref) => ref.vaultName).filter((name) =>
          !listed.has(name)
        ),
      ),
    ];
    const checkName = "Vaults the workflow reads are in its vaults list";
    if (unlisted.length > 0) {
      results.push(WorkflowValidationResult.fail(
        checkName,
        `vault.get reads ${
          unlisted.map((n) => `'${n}'`).join(", ")
        }, not in the workflow's vaults list: add ${
          unlisted.length === 1 ? "it" : "them"
        } to vaults or read a listed vault`,
      ));
    } else {
      results.push(WorkflowValidationResult.pass(checkName));
    }

    if (!this.sensitiveOutputVaults) return results;
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        const taskData = step.task?.data;
        if (taskData?.type !== "model_method") continue;
        const modelRef = taskData.modelIdOrName ?? taskData.modelName;
        if (!modelRef) continue;
        if (
          (taskData.modelType ?? modelRef).includes("${{") ||
          taskData.methodName.includes("${{")
        ) continue;
        // an evaluated vaultName is known only at run time, where the pre-run
        // vault check decides on the evaluated name
        if (
          step.dataOutputOverrides.some((o) => o.vaultName?.includes("${{"))
        ) continue;
        const targets = await this.sensitiveOutputVaults.targetVaults({
          modelIdOrName: modelRef,
          methodName: taskData.methodName,
          modelType: taskData.modelType,
          dataOutputOverrides: step.dataOutputOverrides,
        });
        if (!targets) continue;
        const missing = targets.filter((name) => !listed.has(name));
        if (missing.length === 0) continue;
        results.push(WorkflowValidationResult.fail(
          `Sensitive outputs of step '${step.name}' in job '${job.name}' land in its vaults list`,
          `${modelRef}.${taskData.methodName} stores sensitive output in ${
            missing.map((n) => `'${n}'`).join(", ")
          }, not in the workflow's vaults list: add ${
            missing.length === 1 ? "it" : "them"
          } to vaults or point the output at a listed vault`,
        ));
      }
    }
    return results;
  }

  private validateQueueTimeoutPlacement(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        const effectiveFields = mergePlacementFields(
          mergePlacementFields(
            workflow.placementFields,
            job.placementFields,
          ),
          step.placementFields,
        );
        const effectiveQueueTimeout = step.queueTimeout ??
          job.queueTimeout ?? workflow.queueTimeout;
        if (
          effectiveQueueTimeout !== undefined &&
          resolvePlacement(effectiveFields) === undefined
        ) {
          results.push(
            WorkflowValidationResult.warning(
              `queueTimeout without placement in job '${job.name}' step '${step.name}'`,
              `Step '${step.name}' has queueTimeout (directly or inherited) but no effective target, labels, or platform — ` +
                `queueTimeout only applies to remote-execution steps with placement requirements`,
            ),
          );
        }
      }
    }
    return results;
  }

  private validateAffinityPlacement(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];

    // A job with affinity: false opts out, so workflow affinity never pins
    // its steps.
    const pinnedJobs = workflow.jobs.filter((job) => job.affinity !== false);
    if (workflow.affinity) {
      const hasAnyPlacement = pinnedJobs.some((job) => {
        const wfFields = mergePlacementFields(
          workflow.placementFields,
          job.placementFields,
        );
        return job.steps.some((step) => {
          const effective = mergePlacementFields(
            wfFields,
            step.placementFields,
          );
          return resolvePlacement(effective) !== undefined;
        });
      });
      if (!hasAnyPlacement) {
        results.push(
          WorkflowValidationResult.warning(
            `affinity without placement at workflow level`,
            `Workflow has 'affinity: true' but none of the steps it pins resolve to remote placement — ` +
              `jobs that set 'affinity: false' are not pinned, and affinity only applies to remote-execution steps with placement requirements`,
          ),
        );
      }
    }

    for (const job of workflow.jobs) {
      if (job.affinity) {
        const wfFields = mergePlacementFields(
          workflow.placementFields,
          job.placementFields,
        );
        const hasAnyPlacement = job.steps.some((step) => {
          const effective = mergePlacementFields(
            wfFields,
            step.placementFields,
          );
          return resolvePlacement(effective) !== undefined;
        });
        if (!hasAnyPlacement) {
          results.push(
            WorkflowValidationResult.warning(
              `affinity without placement in job '${job.name}'`,
              `Job '${job.name}' has 'affinity: true' but no steps resolve to remote placement — ` +
                `affinity only applies to remote-execution steps with placement requirements`,
            ),
          );
        }
      }
    }

    // the runtime keys workflow affinity on the whole run, so job affinity
    // forms its own group only when the workflow sets none; a job with affinity
    // false is in no group
    const scopes = workflow.affinity
      ? [{ where: "at workflow level", jobs: pinnedJobs }]
      : workflow.jobs.filter((job) => job.affinity).map((job) => ({
        where: `in job '${job.name}'`,
        jobs: [job],
      }));
    for (const scope of scopes) {
      const mixed = this.mixedAffinityPlacement(
        workflow,
        scope.jobs,
        scope.jobs.length > 1,
      );
      if (mixed !== null) {
        results.push(
          WorkflowValidationResult.warning(
            `affinity with mixed placement ${scope.where}`,
            `Steps in this affinity group declare different placement: ` +
              `${mixed}. The first step to dispatch picks the worker for ` +
              `the whole group, and a later step whose placement that ` +
              `worker does not meet fails — give every step in the group ` +
              `placement one worker can meet, usually by setting it at the ` +
              `workflow or job level`,
          ),
        );
      }
    }

    return results;
  }

  /**
   * a target stands in for labels and platform, as in scheduling; a group whose
   * placement holds an expression is not compared, since its value is known
   * only at run time
   */
  private mixedAffinityPlacement(
    workflow: Workflow,
    jobs: readonly Job[],
    qualifyStepNames: boolean,
  ): string | null {
    const groups = new Map<string, { description: string; names: string[] }>();
    for (const job of jobs) {
      const jobFields = mergePlacementFields(
        workflow.placementFields,
        job.placementFields,
      );
      for (const step of job.steps) {
        const placement = resolvePlacement(
          mergePlacementFields(jobFields, step.placementFields),
        );
        if (placement === undefined) continue;
        const effective = placement.target !== undefined
          ? { target: placement.target }
          : {
            labels: Object.fromEntries(
              Object.entries(placement.labels ?? {}).sort(([a], [b]) =>
                a.localeCompare(b)
              ),
            ),
            platform: placement.platform,
          };
        const values = [
          effective.target,
          effective.platform,
          ...Object.entries(effective.labels ?? {}).flat(),
        ].filter((value) => value !== undefined);
        if (values.some((value) => containsExpression(value))) return null;
        const key = JSON.stringify([
          effective.target,
          effective.platform,
          effective.labels,
        ]);
        const group = groups.get(key) ??
          { description: describePlacement(effective), names: [] };
        group.names.push(
          qualifyStepNames ? `'${job.name}/${step.name}'` : `'${step.name}'`,
        );
        groups.set(key, group);
      }
    }
    if (groups.size <= 1) return null;
    return [...groups.values()].map(({ description, names }) =>
      `${names.join(", ")} (${description})`
    ).join("; ");
  }

  private validateWritesPlacement(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];

    const effectiveWrites = (
      step: (typeof workflow.jobs)[number]["steps"][number],
      job: (typeof workflow.jobs)[number],
    ): boolean | undefined => step.writes ?? job.writes ?? workflow.writes;

    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (effectiveWrites(step, job)) {
          const wfFields = mergePlacementFields(
            workflow.placementFields,
            job.placementFields,
          );
          const effective = mergePlacementFields(
            wfFields,
            step.placementFields,
          );
          if (resolvePlacement(effective) === undefined) {
            const source = step.writes !== undefined
              ? `step '${step.name}'`
              : job.writes !== undefined
              ? `job '${job.name}'`
              : "workflow";
            results.push(
              WorkflowValidationResult.warning(
                `writes without placement on ${source}`,
                `Step '${step.name}' in job '${job.name}' has effective 'writes: true' (from ${source}) ` +
                  `but no remote placement — writes only affects failure semantics for remote-execution steps`,
              ),
            );
          }
        }
      }
    }

    return results;
  }

  private validateAssertExprNotInterpolated(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];
    const exprPattern = /^\$\{\{.*\}\}\s*$/s;
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (!step.task) continue;
        const taskData = step.task.data;
        if (taskData.type !== "assert") continue;
        if (exprPattern.test(taskData.expr)) {
          results.push(
            WorkflowValidationResult.fail(
              `Assert expr in job '${job.name}' step '${step.name}'`,
              `assert expr must be a raw CEL expression — remove the ` +
                `\${{ }} wrapper. Interpolation converts the expression ` +
                `before runtime evaluation, which causes a type error`,
            ),
          );
        }
      }
    }
    return results;
  }

  /**
   * evaluation resolves inputs.* in a captured wait schema but not self, steps
   * or data, which would stay as literal text and match no payload
   */
  private validateWaitSchemaExpressions(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];
    // A root, not a field: `inputs.env.region` reads inputs only.
    const unresolvedRoot =
      /(?<![\w.])(self|steps|data|env|vault|model)\s*[.[(]/;
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (!step.task) continue;
        const taskData = step.task.data;
        if (taskData.type !== "wait_for_signal") continue;
        const expressions = schemaExpressions(taskData.schema);
        // an early payload is checked against the schema as the definition has
        // it, before any run exists to resolve an expression
        if (taskData.acceptEarly !== undefined && expressions.length > 0) {
          results.push(
            WorkflowValidationResult.fail(
              `Wait schema in job '${job.name}' step '${step.name}'`,
              `a wait_for_signal step that sets acceptEarly may hold no ` +
                `expression in its schema, but contains ${expressions[0]}. A ` +
                `signal that arrives before the wait opens is checked against ` +
                `the schema in the definition, where inputs.* is not resolved`,
            ),
          );
          continue;
        }
        const offending = expressions.find((expr) => unresolvedRoot.test(expr));
        if (offending) {
          results.push(
            WorkflowValidationResult.fail(
              `Wait schema in job '${job.name}' step '${step.name}'`,
              `a wait_for_signal schema may read inputs.* only, but contains ` +
                `${offending}. The schema is captured when the step starts ` +
                `waiting, and self, steps and data are not resolved in it`,
            ),
          );
        }
      }
    }
    return results;
  }

  /**
   * the server default never applies to a workflow that declares inputs, so a
   * signal-waiting workflow with autoResume unset would stay suspended with
   * nothing saying why; it has to choose
   */
  private validateWaitAutoResumeDeclared(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    if (workflow.autoResume !== undefined) return [];
    if (!workflowDeclaresInputs(workflow.inputs)) return [];
    const waits = workflow.jobs.some((job) =>
      job.steps.some((step) => step.task?.data.type === "wait_for_signal")
    );
    if (!waits) return [];
    return [
      WorkflowValidationResult.fail(
        "Auto-resume for signal waits",
        `The workflow waits for a signal and declares inputs, so it must set ` +
          `autoResume. Set autoResume: true for swamp serve to continue a run ` +
          `once its waits are settled, with the inputs the run started with; ` +
          `set autoResume: false to continue it with swamp workflow resume, ` +
          `which can supply inputs`,
      ),
    ];
  }

  /**
   * a key is held by one open wait at a time, so no two steps declare the same
   * one and a step under forEach, whose iterations would share it, declares
   * none
   */
  private validateWaitKeys(workflow: Workflow): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];
    const declaredBy = new Map<string, string[]>();
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        const taskData = step.task?.data;
        if (taskData?.type !== "wait_for_signal") continue;
        if (taskData.key === undefined) continue;
        const place = `job '${job.name}' step '${step.name}'`;
        declaredBy.set(taskData.key, [
          ...(declaredBy.get(taskData.key) ?? []),
          place,
        ]);
        if (step.forEach) {
          results.push(
            WorkflowValidationResult.fail(
              `Wait key in ${place}`,
              `a wait_for_signal step under forEach cannot declare a key: ` +
                `every iteration would claim '${taskData.key}', and one ` +
                `open wait holds a key at a time. Remove the key, or wait ` +
                `in a step outside the forEach`,
            ),
          );
        }
      }
    }
    for (const [key, places] of declaredBy) {
      if (places.length < 2) continue;
      results.push(
        WorkflowValidationResult.fail(
          `Unique wait key '${key}'`,
          `The key is declared by ${places.join(" and ")}. One open wait ` +
            `holds a key at a time, so each wait_for_signal step of a ` +
            `workflow needs its own key`,
        ),
      );
    }
    return results;
  }

  private validateSchema(workflow: Workflow): WorkflowValidationResult {
    const result = WorkflowSchema.safeParse(workflow.toData());
    return result.success
      ? WorkflowValidationResult.pass("Schema validation")
      : WorkflowValidationResult.fail(
        "Schema validation",
        WorkflowSchemaError.fromZodError(result.error).message,
      );
  }

  private validateUniqueJobNames(workflow: Workflow): WorkflowValidationResult {
    const names = new Set<string>();
    const duplicates: string[] = [];

    for (const job of workflow.jobs) {
      if (names.has(job.name)) {
        duplicates.push(job.name);
      }
      names.add(job.name);
    }

    if (duplicates.length > 0) {
      return WorkflowValidationResult.fail(
        "Unique job names",
        `Duplicate job names: ${duplicates.join(", ")}`,
      );
    }

    return WorkflowValidationResult.pass("Unique job names");
  }

  private validateUniqueStepNames(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];

    for (const job of workflow.jobs) {
      const names = new Set<string>();
      const duplicates: string[] = [];

      for (const step of job.steps) {
        if (names.has(step.name)) {
          duplicates.push(step.name);
        }
        names.add(step.name);
      }

      if (duplicates.length > 0) {
        results.push(
          WorkflowValidationResult.fail(
            `Unique step names in job '${job.name}'`,
            `Duplicate step names: ${duplicates.join(", ")}`,
          ),
        );
      } else {
        results.push(
          WorkflowValidationResult.pass(
            `Unique step names in job '${job.name}'`,
          ),
        );
      }
    }

    return results;
  }

  private validateJobDependencyRefs(
    workflow: Workflow,
  ): WorkflowValidationResult {
    const jobNames = new Set(workflow.jobs.map((j) => j.name));
    const invalid: string[] = [];

    for (const job of workflow.jobs) {
      for (const dep of job.dependsOn) {
        if (!jobNames.has(dep.job)) {
          invalid.push(`${job.name} -> ${dep.job}`);
        }
      }
    }

    if (invalid.length > 0) {
      return WorkflowValidationResult.fail(
        "Valid job dependency references",
        `Invalid job references: ${invalid.join(", ")}`,
      );
    }

    return WorkflowValidationResult.pass("Valid job dependency references");
  }

  private validateStepDependencyRefs(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];

    for (const job of workflow.jobs) {
      const stepNames = new Set(job.steps.map((s) => s.name));
      const invalid: string[] = [];

      for (const step of job.steps) {
        for (const dep of step.dependsOn) {
          if (!stepNames.has(dep.step)) {
            invalid.push(`${step.name} -> ${dep.step}`);
          }
        }
      }

      if (invalid.length > 0) {
        results.push(
          WorkflowValidationResult.fail(
            `Valid step dependency references in job '${job.name}'`,
            `Invalid step references: ${invalid.join(", ")}`,
          ),
        );
      } else {
        results.push(
          WorkflowValidationResult.pass(
            `Valid step dependency references in job '${job.name}'`,
          ),
        );
      }
    }

    return results;
  }

  private validateNoJobCycles(workflow: Workflow): WorkflowValidationResult {
    if (workflow.jobs.length === 0) {
      return WorkflowValidationResult.pass("No cyclic job dependencies");
    }

    const nodes: GraphNode[] = workflow.jobs.map((job) => ({
      name: job.name,
      weight: job.weight,
      dependencies: job.getDependencyNames(),
    }));

    try {
      this.sortService.sort(nodes);
      return WorkflowValidationResult.pass("No cyclic job dependencies");
    } catch (error) {
      if (error instanceof CyclicDependencyError) {
        return WorkflowValidationResult.fail(
          "No cyclic job dependencies",
          error.message,
        );
      }
      if (error instanceof DuplicateNodeNameError) {
        return WorkflowValidationResult.fail(
          "No cyclic job dependencies",
          error.message,
        );
      }
      throw error;
    }
  }

  private validateNoStepCycles(workflow: Workflow): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];

    for (const job of workflow.jobs) {
      if (job.steps.length === 0) {
        results.push(
          WorkflowValidationResult.pass(
            `No cyclic step dependencies in job '${job.name}'`,
          ),
        );
        continue;
      }

      const nodes: GraphNode[] = job.steps.map((step) => ({
        name: step.name,
        weight: step.weight,
        dependencies: step.getDependencyNames(),
      }));

      try {
        this.sortService.sort(nodes);
        results.push(
          WorkflowValidationResult.pass(
            `No cyclic step dependencies in job '${job.name}'`,
          ),
        );
      } catch (error) {
        if (
          error instanceof CyclicDependencyError ||
          error instanceof DuplicateNodeNameError
        ) {
          results.push(
            WorkflowValidationResult.fail(
              `No cyclic step dependencies in job '${job.name}'`,
              error.message,
            ),
          );
        } else {
          throw error;
        }
      }
    }

    return results;
  }

  private async validateStepInputs(
    workflow: Workflow,
  ): Promise<WorkflowValidationResult[]> {
    const results: WorkflowValidationResult[] = [];

    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        const task = step.task;
        if (!task) continue;

        const taskData = task.data;
        if (taskData.type === "model_method" && this.methodResolver) {
          const modelRef = taskData.modelIdOrName ?? taskData.modelName;
          if (modelRef) {
            results.push(
              ...await this.validateModelMethodInputs(
                job.name,
                step.name,
                modelRef,
                taskData.methodName,
                typeof taskData.inputs === "string"
                  ? undefined
                  : taskData.inputs,
                taskData.modelType,
                typeof taskData.globalArgs === "string"
                  ? undefined
                  : taskData.globalArgs,
                workflow.inputs?.properties,
              ),
            );
          }
        } else if (taskData.type === "workflow" && this.workflowRepo) {
          results.push(
            ...await this.validateWorkflowTaskInputs(
              job.name,
              step.name,
              taskData.workflowIdOrName,
              typeof taskData.inputs === "string" ? undefined : taskData.inputs,
            ),
          );
        }
      }
    }

    return results;
  }

  private async validateModelMethodInputs(
    jobName: string,
    stepName: string,
    modelIdOrName: string,
    methodName: string,
    inputs: Record<string, unknown> | undefined,
    modelType?: string,
    globalArgs?: Record<string, unknown>,
    inputProperties?: Record<string, { default?: unknown }>,
  ): Promise<WorkflowValidationResult[]> {
    const checkName =
      `Step inputs for '${stepName}' in job '${jobName}' (${modelIdOrName}.${methodName})`;
    const notChecked = [
      WorkflowValidationResult.pass(
        checkName + " (target resolved at run time, not checked)",
      ),
    ];

    // dynamic CEL references cannot be resolved statically; for modelType steps
    // only the type matters, and a single input target with a literal default
    // is checked at that default
    let target = modelIdOrName;
    let atDefault = "";
    if (modelType) {
      if (modelType.includes("${{")) return notChecked;
    } else if (modelIdOrName.includes("${{")) {
      const inputName = extractWholeFieldInputRef(modelIdOrName);
      const fallback = inputName === null
        ? undefined
        : inputProperties?.[inputName]?.default;
      if (
        typeof fallback !== "string" || fallback === "" ||
        fallback.includes("${{")
      ) {
        return notChecked;
      }
      target = fallback;
      atDefault = `With input '${inputName}' at its default '${fallback}': `;
    }

    const resolution = await this.methodResolver!.resolve(
      target,
      methodName,
      modelType,
    );

    switch (resolution.status) {
      case "model_not_found":
        // a step may reference a model created at run time, so a missing
        // instance is a warning; an unresolvable model type is always a real
        // authoring error
        return [
          WorkflowValidationResult.warning(
            checkName +
              " (behavior not found)",
            atDefault +
              "Behavior instance not found — may be created at runtime, " +
              "or could be a typo",
          ),
        ];
      case "type_unresolvable":
        return [
          WorkflowValidationResult.fail(
            checkName,
            atDefault +
              `Behavior type '${resolution.modelType}' could not be resolved — ` +
              `ensure the extension is available so its step ` +
              `inputs can be validated`,
          ),
        ];
      case "method_not_found":
        if (methodName.includes("${{")) {
          return [WorkflowValidationResult.pass(checkName)];
        }
        return [
          WorkflowValidationResult.fail(
            checkName,
            atDefault +
              `Method '${methodName}' not found on behavior type '${resolution.modelType}'`,
          ),
        ];
      case "resolved": {
        // the definition's own problem, reported beside the step's inputs
        // rather than in place of them
        const literalGlobals = resolution.literalSensitiveGlobals?.length
          ? [
            WorkflowValidationResult.fail(
              `Global arguments for '${stepName}' in job '${jobName}' (${modelIdOrName})`,
              atDefault +
                literalSensitiveGlobalArgsMessage(
                  resolution.literalSensitiveGlobals,
                ),
            ),
          ]
          : [];
        const reservedTags = resolution.reservedTagRefusal
          ? [
            WorkflowValidationResult.fail(
              `Tags for '${stepName}' in job '${jobName}' (${modelIdOrName})`,
              atDefault + resolution.reservedTagRefusal,
            ),
          ]
          : [];
        const definitionProblems = [...literalGlobals, ...reservedTags];
        const provided = new Set<string>([
          ...Object.keys(inputs ?? {}),
          ...Object.keys(globalArgs ?? {}),
          ...(resolution.definitionProvidedArgs ?? []),
        ]);
        const missing = resolution.requiredArgs.filter((arg) =>
          !provided.has(arg)
        );
        if (missing.length > 0) {
          return [
            ...definitionProblems,
            WorkflowValidationResult.fail(
              checkName,
              atDefault + `Missing required inputs: ${missing.join(", ")}`,
            ),
          ];
        }
        return [
          ...definitionProblems,
          WorkflowValidationResult.pass(checkName),
        ];
      }
    }
  }

  private async validateWorkflowTaskInputs(
    jobName: string,
    stepName: string,
    workflowIdOrName: string,
    inputs: Record<string, unknown> | undefined,
  ): Promise<WorkflowValidationResult[]> {
    const checkName =
      `Step inputs for '${stepName}' in job '${jobName}' (workflow: ${workflowIdOrName})`;

    if (workflowIdOrName.includes("${{")) {
      return [WorkflowValidationResult.pass(checkName)];
    }

    let nested: Workflow | null = null;
    try {
      nested = await this.workflowRepo!.findByName(workflowIdOrName) ??
        await this.workflowRepo!.findById(
          createWorkflowId(workflowIdOrName),
        );
    } catch {
      // ID may not be a valid UUID — that's fine, just not found
    }

    if (!nested) {
      return [
        WorkflowValidationResult.pass(
          checkName +
            " (workflow not found, skipped)",
        ),
      ];
    }

    const requiredInputs = nested.inputs?.required ?? [];
    if (requiredInputs.length === 0) {
      return [WorkflowValidationResult.pass(checkName)];
    }

    const inputKeys = new Set(Object.keys(inputs ?? {}));
    const missing = requiredInputs.filter((arg) => !inputKeys.has(arg));
    if (missing.length > 0) {
      return [
        WorkflowValidationResult.fail(
          checkName,
          `Missing required workflow inputs: ${missing.join(", ")}`,
        ),
      ];
    }

    return [WorkflowValidationResult.pass(checkName)];
  }

  private async validateGlobalArgInputRefs(
    workflow: Workflow,
  ): Promise<WorkflowValidationResult[]> {
    const results: WorkflowValidationResult[] = [];

    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        const task = step.task;
        if (!task) continue;

        const taskData = task.data;
        if (taskData.type !== "model_method") continue;

        const modelRef = taskData.modelIdOrName ?? taskData.modelName;
        if (!modelRef) continue;
        if (modelRef.includes("${{")) continue;
        if (taskData.modelType?.includes("${{")) continue;

        if (typeof taskData.inputs === "string") continue;

        const checkName =
          `GlobalArgument input references for '${step.name}' in job '${job.name}' (${modelRef}.${taskData.methodName})`;

        const resolution = await this.methodResolver!.resolve(
          modelRef,
          taskData.methodName,
          taskData.modelType,
        );

        if (
          resolution.status !== "resolved" ||
          !resolution.definitionProvidedArgValues
        ) {
          continue;
        }

        const referencedInputs = extractInputReferences(
          resolution.definitionProvidedArgValues,
        );

        if (referencedInputs.size === 0) {
          results.push(WorkflowValidationResult.pass(checkName));
          continue;
        }

        const stepInputs = new Set(
          Object.keys(taskData.inputs ?? {}),
        );
        const missing = [...referencedInputs].filter(
          (name) => !stepInputs.has(name),
        );

        if (missing.length > 0) {
          results.push(
            WorkflowValidationResult.fail(
              checkName,
              `Behavior definition references input(s) not supplied by step: ${
                missing.join(", ")
              }`,
            ),
          );
        } else {
          results.push(WorkflowValidationResult.pass(checkName));
        }
      }
    }

    return results;
  }

  private validateGuardExpressionTypes(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];
    const inputProperties = workflow.inputs?.properties;

    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (!step.guard) continue;

        const inputName = extractWholeFieldInputRef(step.guard);
        if (!inputName) continue;

        if (!inputProperties) continue;
        const inputDef = inputProperties[inputName];
        if (!inputDef?.type) continue;

        if (inputDef.type !== "string") {
          const inputRef = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inputName)
            ? `inputs.${inputName}`
            : `inputs["${inputName}"]`;
          results.push(
            WorkflowValidationResult.fail(
              `Guard type in job '${job.name}' step '${step.name}'`,
              `guard received a ${inputDef.type} via \${{ ${inputRef} }}; ` +
                `the guard field requires a string (CEL expression). ` +
                `Whole-field \${{ }} substitutions preserve the input's native type, ` +
                `so a ${inputDef.type} would replace the string at runtime. ` +
                `Use a CEL expression that evaluates the condition instead`,
            ),
          );
        }
      }
    }

    return results;
  }

  /**
   * forEach.in resolves at job start, so stored data a same-job upstream step
   * writes is not there yet; a dependsOn kept only for ordering is a false hit
   */
  private validateForEachSameJobDataReads(
    workflow: Workflow,
  ): WorkflowValidationResult[] {
    const results: WorkflowValidationResult[] = [];
    for (const job of workflow.jobs) {
      const byName = new Map(job.steps.map((s) => [s.name, s]));
      for (const step of job.steps) {
        if (!step.forEach) continue;
        const readsStoredData = extractExpressions(step.forEach.in).some(
          (expr) => {
            const roots = freeRoots(expr.celExpression);
            return roots !== undefined &&
              STORED_DATA_ROOTS.some((root) => roots.has(root));
          },
        );
        if (!readsStoredData) continue;

        const upstream: string[] = [];
        const seen = new Set<string>([step.name]);
        const pending = step.getDependencyNames();
        for (let i = 0; i < pending.length; i++) {
          const name = pending[i];
          if (seen.has(name)) continue;
          seen.add(name);
          const dependency = byName.get(name);
          if (!dependency) continue;
          upstream.push(name);
          for (const next of dependency.getDependencyNames()) {
            pending.push(next);
          }
        }
        if (upstream.length === 0) continue;

        const named = upstream.length === 1
          ? `step '${upstream[0]}' runs`
          : `steps ${upstream.map((name) => `'${name}'`).join(", ")} run`;
        results.push(
          WorkflowValidationResult.warning(
            `forEach.in in job '${job.name}' step '${step.name}'`,
            `forEach.in reads stored data but resolves when job '${job.name}' ` +
              `starts, before ${named}, so it cannot see data written ` +
              `there in this run and may expand to no items. Move step ` +
              `'${step.name}' to a job that depends on job '${job.name}', or ` +
              `iterate a fixed collection and skip unwanted iterations with ` +
              `a guard (a truthy guard skips the iteration)`,
          ),
        );
      }
    }
    return results;
  }
}
