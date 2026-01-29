import type { Workflow } from "./workflow.ts";
import type { Job } from "./job.ts";
import type { Step } from "./step.ts";
// deno-lint-ignore verbatim-module-syntax
import { JobRun, WorkflowRun } from "./workflow_run.ts";
import {
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";
import type { WorkflowId } from "./workflow_id.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "./repositories.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { modelRegistry } from "../models/model.ts";
import { DefaultMethodExecutionService } from "../models/method_execution_service.ts";
import { createModelInputId, type ModelInput } from "../models/model_input.ts";
import type { ModelType } from "../models/model_type.ts";

/**
 * Context for step execution.
 */
export interface StepExecutionContext {
  workflowId: WorkflowId;
  workflowName: string;
  jobName: string;
  stepName: string;
  repoDir: string;
}

/**
 * Executor interface for running step tasks.
 */
export interface StepExecutor {
  /**
   * Executes a step task.
   *
   * @param step - The step to execute
   * @param ctx - Execution context
   * @returns The step output
   */
  execute(step: Step, ctx: StepExecutionContext): Promise<unknown>;
}

/**
 * Default step executor that handles model methods and shell commands.
 */
export class DefaultStepExecutor implements StepExecutor {
  async execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
    const task = step.task.data;

    if (task.type === "shell") {
      return await this.executeShell(task, ctx);
    } else if (task.type === "model_method") {
      return await this.executeModelMethod(task, ctx);
    }

    throw new Error(`Unknown task type: ${(task as { type: string }).type}`);
  }

  private async executeShell(
    task: {
      command: string;
      args: string[];
      workingDir?: string;
      timeout?: number;
    },
    ctx: StepExecutionContext,
  ): Promise<unknown> {
    const cwd = task.workingDir ?? ctx.repoDir;

    const command = new Deno.Command(task.command, {
      args: task.args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    });

    const result = await command.output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Shell command failed: ${stderr}`);
    }

    const stdout = new TextDecoder().decode(result.stdout);
    return { stdout: stdout.trim(), exitCode: result.code };
  }

  private async executeModelMethod(
    task: { modelIdOrName: string; methodName: string },
    ctx: StepExecutionContext,
  ): Promise<unknown> {
    const inputRepo = new YamlInputRepository(ctx.repoDir);
    const resourceRepo = new YamlResourceRepository(ctx.repoDir);
    const executionService = new DefaultMethodExecutionService();

    // Look up the model input by ID or name
    const lookupResult = await this.lookupModelInput(
      inputRepo,
      task.modelIdOrName,
    );
    if (!lookupResult) {
      throw new Error(`Model not found: ${task.modelIdOrName}`);
    }

    const { input, modelType } = lookupResult;

    // Get the model definition
    const definition = modelRegistry.get(modelType);
    if (!definition) {
      throw new Error(`Unknown model type: ${modelType.normalized}`);
    }

    // Validate method exists on the model
    const method = definition.methods[task.methodName];
    if (!method) {
      const availableMethods = Object.keys(definition.methods).join(", ");
      throw new Error(
        `Unknown method '${task.methodName}' for type '${modelType.normalized}'. Available methods: ${
          availableMethods || "none"
        }`,
      );
    }

    // Execute the method
    const result = await executionService.executeWorkflow(
      input,
      definition,
      task.methodName,
      { repoDir: ctx.repoDir, resourceRepository: resourceRepo },
    );

    // Handle resource persistence based on operation type
    let resourcePath: string;
    if (result.deleteResource) {
      // Delete the resource file
      await resourceRepo.delete(modelType, result.resource.id);
      resourcePath = "";
    } else {
      // Save the resource
      await resourceRepo.save(modelType, result.resource);
      resourcePath = resourceRepo.getPath(modelType, result.resource.id);
    }

    // Update input's resourceId based on operation type
    if (result.deleteResource) {
      if (input.resourceId) {
        input.setResourceId(undefined);
        await inputRepo.save(modelType, input);
      }
    } else {
      if (!input.resourceId) {
        input.setResourceId(result.resource.id);
        await inputRepo.save(modelType, input);
      }
    }

    return {
      type: "model_method",
      model: task.modelIdOrName,
      method: task.methodName,
      resourceId: result.resource.id,
      resourcePath,
      resourceAttributes: result.resource.attributes,
    };
  }

  /**
   * UUID v4 regex pattern for detecting if an argument is a UUID.
   */
  private static readonly UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  /**
   * Looks up a model input by ID or name.
   */
  private async lookupModelInput(
    inputRepo: YamlInputRepository,
    idOrName: string,
  ): Promise<{ input: ModelInput; modelType: ModelType } | null> {
    if (DefaultStepExecutor.UUID_PATTERN.test(idOrName)) {
      // Look up by ID across all model types
      const inputId = createModelInputId(idOrName);
      for (const type of modelRegistry.types()) {
        const input = await inputRepo.findById(type, inputId);
        if (input) {
          return { input, modelType: type };
        }
      }
      return null;
    } else {
      // Look up by name
      const result = await inputRepo.findByNameGlobal(idOrName);
      if (result) {
        return { input: result.input, modelType: result.type };
      }
      return null;
    }
  }
}

/**
 * Progress callback for workflow execution.
 */
export interface ExecutionProgressCallback {
  onWorkflowStart?(run: WorkflowRun): void;
  onJobStart?(run: WorkflowRun, jobName: string): void;
  onJobComplete?(run: WorkflowRun, jobName: string): void;
  onJobSkip?(run: WorkflowRun, jobName: string): void;
  onStepStart?(run: WorkflowRun, jobName: string, stepName: string): void;
  onStepComplete?(run: WorkflowRun, jobName: string, stepName: string): void;
  onStepSkip?(run: WorkflowRun, jobName: string, stepName: string): void;
  onStepFail?(
    run: WorkflowRun,
    jobName: string,
    stepName: string,
    error: string,
  ): void;
  onWorkflowComplete?(run: WorkflowRun): void;
}

/**
 * Domain service for workflow execution.
 */
export class WorkflowExecutionService {
  private readonly sortService = new TopologicalSortService();
  private readonly executor: StepExecutor;

  constructor(
    private readonly workflowRepo: WorkflowRepository,
    private readonly runRepo: WorkflowRunRepository,
    private readonly repoDir: string,
    executor?: StepExecutor,
  ) {
    this.executor = executor ?? new DefaultStepExecutor();
  }

  /**
   * Executes a workflow by ID or name.
   *
   * @param idOrName - Workflow ID or name
   * @param progress - Optional progress callback
   * @returns The workflow run
   */
  async execute(
    idOrName: string,
    progress?: ExecutionProgressCallback,
  ): Promise<WorkflowRun> {
    // Look up workflow
    const workflow = await this.lookupWorkflow(idOrName);
    if (!workflow) {
      throw new Error(`Workflow not found: ${idOrName}`);
    }

    // Create workflow run
    const run = WorkflowRun.create(workflow);

    // Start execution
    run.start();
    progress?.onWorkflowStart?.(run);
    await this.saveRun(workflow.id, run);

    // Sort jobs topologically
    const jobNodes: GraphNode[] = workflow.jobs.map((job) => ({
      name: job.name,
      weight: job.weight,
      dependencies: job.getDependencyNames(),
    }));

    const sortedJobs = this.sortService.sort(jobNodes);

    // Execute jobs level by level
    for (const level of sortedJobs.levels) {
      // Execute jobs in parallel within each level
      await Promise.all(
        level.map((jobName) =>
          this.executeJob(workflow, run, jobName, progress)
        ),
      );
      await this.saveRun(workflow.id, run);
    }

    // Complete workflow
    run.complete();
    progress?.onWorkflowComplete?.(run);
    await this.saveRun(workflow.id, run);

    return run;
  }

  private async executeJob(
    workflow: Workflow,
    run: WorkflowRun,
    jobName: string,
    progress?: ExecutionProgressCallback,
  ): Promise<void> {
    const job = workflow.getJob(jobName);
    if (!job) {
      throw new Error(`Job not found: ${jobName}`);
    }

    const jobRun = run.getJob(jobName);
    if (!jobRun) {
      throw new Error(`Job run not found: ${jobName}`);
    }

    // Check if job's trigger condition is met
    const shouldRun = this.shouldJobRun(job, run);
    if (!shouldRun) {
      jobRun.skip();
      progress?.onJobSkip?.(run, jobName);
      return;
    }

    // Start job
    jobRun.start();
    progress?.onJobStart?.(run, jobName);

    // Sort steps topologically
    const stepNodes: GraphNode[] = job.steps.map((step) => ({
      name: step.name,
      weight: step.weight,
      dependencies: step.getDependencyNames(),
    }));

    const sortedSteps = this.sortService.sort(stepNodes);

    // Execute steps level by level
    let jobFailed = false;
    for (const level of sortedSteps.levels) {
      if (jobFailed) break;

      // Execute steps in parallel within each level
      const stepResults = await Promise.allSettled(
        level.map((stepName) =>
          this.executeStep(workflow, run, job, jobRun, stepName, progress)
        ),
      );

      // Check for failures
      for (const result of stepResults) {
        if (result.status === "rejected") {
          jobFailed = true;
        }
      }
    }

    // Complete job
    if (jobFailed) {
      jobRun.fail();
    } else {
      jobRun.succeed();
    }
    progress?.onJobComplete?.(run, jobName);
  }

  private async executeStep(
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    jobRun: JobRun,
    stepName: string,
    progress?: ExecutionProgressCallback,
  ): Promise<void> {
    const step = job.getStep(stepName);
    if (!step) {
      throw new Error(`Step not found: ${stepName}`);
    }

    const stepRun = jobRun.getStep(stepName);
    if (!stepRun) {
      throw new Error(`Step run not found: ${stepName}`);
    }

    // Check if step's trigger condition is met
    const shouldRun = this.shouldStepRun(step, jobRun);
    if (!shouldRun) {
      stepRun.skip();
      progress?.onStepSkip?.(run, job.name, stepName);
      return;
    }

    // Start step
    stepRun.start();
    progress?.onStepStart?.(run, job.name, stepName);

    try {
      const ctx: StepExecutionContext = {
        workflowId: workflow.id,
        workflowName: workflow.name,
        jobName: job.name,
        stepName,
        repoDir: this.repoDir,
      };

      const output = await this.executor.execute(step, ctx);
      stepRun.succeed(output);
      progress?.onStepComplete?.(run, job.name, stepName);
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      stepRun.fail(errorMessage);
      progress?.onStepFail?.(run, job.name, stepName, errorMessage);
      throw error;
    }
  }

  private shouldJobRun(job: Job, run: WorkflowRun): boolean {
    // If no dependencies, always run
    if (job.dependsOn.length === 0) {
      return true;
    }

    // Check all dependency conditions
    for (const dep of job.dependsOn) {
      if (!dep.condition.evaluate(run)) {
        return false;
      }
    }

    return true;
  }

  private shouldStepRun(step: Step, jobRun: JobRun): boolean {
    // If no dependencies, always run
    if (step.dependsOn.length === 0) {
      return true;
    }

    // Check all dependency conditions
    for (const dep of step.dependsOn) {
      if (!dep.condition.evaluate(jobRun)) {
        return false;
      }
    }

    return true;
  }

  private async lookupWorkflow(idOrName: string): Promise<Workflow | null> {
    // Try by name first
    const byName = await this.workflowRepo.findByName(idOrName);
    if (byName) return byName;

    // Try by ID
    const { createWorkflowId } = await import("./workflow_id.ts");
    const id = createWorkflowId(idOrName);
    return await this.workflowRepo.findById(id);
  }

  private async saveRun(
    workflowId: WorkflowId,
    run: WorkflowRun,
  ): Promise<void> {
    await this.runRepo.save(workflowId, run);
  }
}
