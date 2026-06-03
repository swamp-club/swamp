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
import { WorkflowSchema } from "./workflow.ts";
import type { WorkflowRepository } from "./repositories.ts";
import { createWorkflowId } from "./workflow_id.ts";
import {
  CyclicDependencyError,
  DuplicateNodeNameError,
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";

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

    return results;
  }

  private validateSchema(workflow: Workflow): WorkflowValidationResult {
    try {
      WorkflowSchema.parse(workflow.toData());
      return WorkflowValidationResult.pass("Schema validation");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return WorkflowValidationResult.fail("Schema validation", message);
    }
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
                taskData.inputs,
                taskData.modelType,
              ),
            );
          }
        } else if (taskData.type === "workflow" && this.workflowRepo) {
          results.push(
            ...await this.validateWorkflowTaskInputs(
              job.name,
              step.name,
              taskData.workflowIdOrName,
              taskData.inputs,
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
  ): Promise<WorkflowValidationResult[]> {
    const checkName =
      `Step inputs for '${stepName}' in job '${jobName}' (${modelIdOrName}.${methodName})`;

    // Skip dynamic CEL references — cannot resolve statically
    if (modelIdOrName.includes("${{")) {
      return [WorkflowValidationResult.pass(checkName)];
    }
    if (modelType?.includes("${{")) {
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
              `ensure the extension is pulled and available so its step ` +
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
}
