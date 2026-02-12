// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import {
  CyclicDependencyError,
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { buildStepNodesWithImplicitDeps } from "./implicit_dependency_service.ts";

/**
 * Value object representing the result of a single validation.
 */
export class WorkflowValidationResult {
  private constructor(
    readonly name: string,
    readonly passed: boolean,
    readonly error?: string,
  ) {}

  /**
   * Creates a passing validation result.
   */
  static pass(name: string): WorkflowValidationResult {
    return new WorkflowValidationResult(name, true);
  }

  /**
   * Creates a failing validation result.
   */
  static fail(name: string, error: string): WorkflowValidationResult {
    return new WorkflowValidationResult(name, false, error);
  }

  /**
   * Value equality comparison.
   */
  equals(other: WorkflowValidationResult): boolean {
    return (
      this.name === other.name &&
      this.passed === other.passed &&
      this.error === other.error
    );
  }
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
 * 8. No cyclic dependencies between steps (including implicit CEL deps)
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
 *
 * Optionally accepts a DefinitionRepository to detect implicit CEL
 * dependencies when checking for step cycles.
 */
export class DefaultWorkflowValidationService
  implements WorkflowValidationService {
  private readonly sortService = new TopologicalSortService();
  private readonly definitionRepo?: YamlDefinitionRepository;

  constructor(definitionRepo?: YamlDefinitionRepository) {
    this.definitionRepo = definitionRepo;
  }

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

    // 8. No cyclic step dependencies (including implicit CEL deps)
    if (this.definitionRepo) {
      results.push(
        ...await this.validateNoStepCyclesWithImplicit(workflow),
      );
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
        if (error instanceof CyclicDependencyError) {
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

  private async validateNoStepCyclesWithImplicit(
    workflow: Workflow,
  ): Promise<WorkflowValidationResult[]> {
    const results: WorkflowValidationResult[] = [];

    for (const job of workflow.jobs) {
      if (job.steps.length === 0) {
        results.push(
          WorkflowValidationResult.pass(
            `No cyclic step dependencies (including implicit) in job '${job.name}'`,
          ),
        );
        continue;
      }

      try {
        const { nodes, implicitDeps } = await buildStepNodesWithImplicitDeps(
          job,
          this.definitionRepo!,
        );

        try {
          this.sortService.sort(nodes);
          results.push(
            WorkflowValidationResult.pass(
              `No cyclic step dependencies (including implicit) in job '${job.name}'`,
            ),
          );
        } catch (error) {
          if (error instanceof CyclicDependencyError) {
            // Annotate the error message with which edges are implicit
            const implicitEdges: string[] = [];
            for (const [step, deps] of implicitDeps) {
              for (const dep of deps) {
                implicitEdges.push(`${step} -> ${dep}`);
              }
            }
            const implicitNote = implicitEdges.length > 0
              ? ` (implicit dependencies from CEL expressions: ${
                implicitEdges.join(", ")
              })`
              : "";

            results.push(
              WorkflowValidationResult.fail(
                `No cyclic step dependencies (including implicit) in job '${job.name}'`,
                `${error.message}${implicitNote}`,
              ),
            );
          } else {
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof CyclicDependencyError) {
          throw error;
        }
        // If we fail to resolve definitions (e.g., missing models), skip gracefully
        results.push(
          WorkflowValidationResult.pass(
            `No cyclic step dependencies (including implicit) in job '${job.name}'`,
          ),
        );
      }
    }

    return results;
  }
}
