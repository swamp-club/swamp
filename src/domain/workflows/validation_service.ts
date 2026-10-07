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

import type { Workflow } from "./workflow.ts";
import { workflowDeclaresInputs, WorkflowSchema } from "./workflow.ts";
import { WorkflowSchemaError } from "./workflow_schema_error.ts";
import type { WorkflowRepository } from "./repositories.ts";
import { mergePlacementFields, resolvePlacement } from "./placement.ts";
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
import type { DataOutputOverride } from "../models/data_output_override.ts";

/**
 * Value object representing the result of a single validation.
 */
export class WorkflowValidationResult {
  private constructor(
    readonly name: string,
    readonly passed: boolean,
    readonly warning: boolean,
    readonly error?: string,
  ) {}

  static pass(name: string): WorkflowValidationResult {
    return new WorkflowValidationResult(name, true, false);
  }

  static warning(name: string, message: string): WorkflowValidationResult {
    return new WorkflowValidationResult(name, true, true, message);
  }

  static fail(name: string, error: string): WorkflowValidationResult {
    return new WorkflowValidationResult(name, false, false, error);
  }

  equals(other: WorkflowValidationResult): boolean {
    return (
      this.name === other.name &&
      this.passed === other.passed &&
      this.warning === other.warning &&
      this.error === other.error
    );
  }
}

/**
 * Result of resolving a method's required arguments.
 *
 * `definitionProvidedArgs` carries the keys of arguments already populated
 * on the resolved definition — both `methods.<methodName>.arguments` and
 * `globalArguments`. The runtime merges these as fallbacks under step-level
 * inputs (see DefaultMethodExecutionService.execute), so the validator must
 * treat them as satisfied when checking required arguments.
 */
export type MethodResolution =
  | {
    status: "resolved";
    requiredArgs: string[];
    definitionProvidedArgs?: string[];
    definitionProvidedArgValues?: Record<string, unknown>;
  }
  | { status: "model_not_found" }
  | { status: "method_not_found"; modelType: string }
  | { status: "type_unresolvable"; modelType: string };

/**
 * Port interface for resolving method argument schemas.
 *
 * Abstracts model type resolution so the validation service can look up
 * method argument schemas without depending on infrastructure.
 */
export interface ModelMethodResolver {
  resolve(
    modelIdOrName: string,
    methodName: string,
    modelType?: string,
  ): Promise<MethodResolution>;
}

/**
 * Port for predicting the vaults a model-method step's sensitive outputs land
 * in, with the resolver the data writer stores with
 * (`sensitive_output_vault.ts`). Returns `undefined` when the step cannot be
 * resolved statically or its method stores no sensitive output.
 */
export interface SensitiveOutputVaultResolver {
  targetVaults(step: {
    modelIdOrName: string;
    methodName: string;
    modelType?: string;
    dataOutputOverrides: ReadonlyArray<DataOutputOverride>;
  }): Promise<string[] | undefined>;
}

/**
 * Domain service for workflow validation.
 *
 * Validates:
 * 1. Schema compliance (Zod validation)
 * 2. Unique job names within workflow
 * 3. Unique step names within each job
 * 4. Valid job dependency references
 * 5. Valid step dependency references
 * 6. No cyclic dependencies between jobs
 * 7. No cyclic dependencies between steps within jobs
 * 8. Step inputs match method/workflow required arguments
 * 9. GlobalArgument expressions reference inputs supplied by the step
 */
export interface WorkflowValidationService {
  /**
   * Validates a workflow.
   *
   * @param workflow The workflow to validate
   * @returns Array of validation results
   */
  validate(workflow: Workflow): Promise<WorkflowValidationResult[]>;
}

/**
 * Default implementation of workflow validation service.
 */
export class DefaultWorkflowValidationService
  implements WorkflowValidationService {
  private readonly sortService = new TopologicalSortService();

  constructor(
    private readonly methodResolver?: ModelMethodResolver,
    private readonly workflowRepo?: WorkflowRepository,
    private readonly sensitiveOutputVaults?: SensitiveOutputVaultResolver,
  ) {}

  async validate(workflow: Workflow): Promise<WorkflowValidationResult[]> {
    const results: WorkflowValidationResult[] = [];

    // 1. Schema validation
    results.push(this.validateSchema(workflow));

    // 2. Unique job names
    results.push(this.validateUniqueJobNames(workflow));

    // 3. Unique step names within jobs
    results.push(...this.validateUniqueStepNames(workflow));

    // 4. Valid job dependency references
    results.push(this.validateJobDependencyRefs(workflow));

    // 5. Valid step dependency references
    results.push(...this.validateStepDependencyRefs(workflow));

    // 6. No cyclic job dependencies
    results.push(this.validateNoJobCycles(workflow));

    // 7. No cyclic step dependencies within jobs
    results.push(...this.validateNoStepCycles(workflow));

    // 8. Step inputs match required arguments
    if (this.methodResolver || this.workflowRepo) {
      results.push(...await this.validateStepInputs(workflow));
    }

    // 9. GlobalArgument expressions reference inputs supplied by the step
    if (this.methodResolver) {
      results.push(
        ...await this.validateGlobalArgInputRefs(workflow),
      );
    }

    // 10. queueTimeout without placement is a no-op
    results.push(...this.validateQueueTimeoutPlacement(workflow));

    // 11. Assert expr must not be wrapped in ${{ }}
    results.push(...this.validateAssertExprNotInterpolated(workflow));
    for (const result of this.validateWaitSchemaExpressions(workflow)) {
      results.push(result);
    }
    for (const result of this.validateWaitAutoResumeDeclared(workflow)) {
      results.push(result);
    }

    // 12. affinity without placement is a no-op
    results.push(...this.validateAffinityPlacement(workflow));

    // 13. Guard expression type matches input type
    results.push(...this.validateGuardExpressionTypes(workflow));

    // 14. writes without placement is a no-op
    results.push(...this.validateWritesPlacement(workflow));

    // 15. Vaults the workflow reads are in its vaults list
    for (const result of await this.validateVaultsList(workflow)) {
      results.push(result);
    }

    return results;
  }

  /**
   * With a `vaults:` list, reports each vault the workflow statically uses
   * but does not list: a quoted `vault.get` in its own steps or inputs, and
   * each sensitive-output target vault of a mutating model-method step. The
   * run-time check is the guarantee for dynamic names and for `vault.get`
   * inside model definitions.
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

    if (workflow.affinity) {
      const hasAnyPlacement = workflow.jobs.some((job) => {
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
            `Workflow has 'affinity: true' but no steps resolve to remote placement — ` +
              `affinity only applies to remote-execution steps with placement requirements`,
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

    return results;
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
   * A wait_for_signal schema is captured as data when the step starts
   * waiting. Workflow evaluation resolves `inputs.*` in it, but not `self`,
   * `steps` or `data`, which would stay in the schema as literal text and
   * match no payload.
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
        const offending = schemaExpressions(taskData.schema).find((expr) =>
          unresolvedRoot.test(expr)
        );
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
   * `swamp serve` continues a run once its waits are settled, when the
   * workflow's auto-resume policy allows (swamp-club#3108). The server
   * default never applies to a workflow that declares inputs, so one that
   * waits for a signal and leaves `autoResume` unset would stay suspended
   * after its signal with nothing saying why. It has to choose.
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
        `the workflow waits for a signal and declares inputs, so it must set ` +
          `autoResume. Set autoResume: true for swamp serve to continue a run ` +
          `once its waits are settled, with the inputs the run started with; ` +
          `set autoResume: false to continue it with swamp workflow resume, ` +
          `which can supply inputs`,
      ),
    ];
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
  ): Promise<WorkflowValidationResult[]> {
    const checkName =
      `Step inputs for '${stepName}' in job '${jobName}' (${modelIdOrName}.${methodName})`;

    // Skip dynamic CEL references — cannot resolve statically.
    // For factory-pattern steps (modelType is set), only the modelType
    // matters for type/method resolution — a CEL modelName does not
    // prevent resolving the extension type.
    if (modelType) {
      if (modelType.includes("${{")) {
        return [WorkflowValidationResult.pass(checkName)];
      }
    } else if (modelIdOrName.includes("${{")) {
      return [WorkflowValidationResult.pass(checkName)];
    }

    const resolution = await this.methodResolver!.resolve(
      modelIdOrName,
      methodName,
      modelType,
    );

    switch (resolution.status) {
      case "model_not_found":
        // A step may reference a model created at run time (by an upstream
        // direct-execution step or out-of-band), so a missing model instance
        // is a warning rather than a failure. This differs from an
        // unresolvable model *type* below, which is always a real authoring
        // error.
        return [
          WorkflowValidationResult.warning(
            checkName +
              " (model not found)",
            "Model instance not found — may be created at runtime, " +
              "or could be a typo",
          ),
        ];
      case "type_unresolvable":
        return [
          WorkflowValidationResult.fail(
            checkName,
            `Model type '${resolution.modelType}' could not be resolved — ` +
              `ensure the extension is available so its step ` +
              `inputs can be validated`,
          ),
        ];
      case "method_not_found":
        return [
          WorkflowValidationResult.fail(
            checkName,
            `Method '${methodName}' not found on model type '${resolution.modelType}'`,
          ),
        ];
      case "resolved": {
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
            WorkflowValidationResult.fail(
              checkName,
              `Missing required inputs: ${missing.join(", ")}`,
            ),
          ];
        }
        return [WorkflowValidationResult.pass(checkName)];
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

    // Skip dynamic CEL references
    if (workflowIdOrName.includes("${{")) {
      return [WorkflowValidationResult.pass(checkName)];
    }

    // Try to find the nested workflow
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

        // Dynamic step inputs cannot be statically analysed
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
              `Model definition references input(s) not supplied by step: ${
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
}
