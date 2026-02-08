import { Workflow, type WorkflowData } from "./workflow.ts";
import type { Job } from "./job.ts";
import type { Step } from "./step.ts";
// deno-lint-ignore verbatim-module-syntax
import { JobRun, WorkflowRun } from "./workflow_run.ts";
import {
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";
import { createWorkflowId, type WorkflowId } from "./workflow_id.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "./repositories.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { modelRegistry } from "../models/model.ts";
import { DefaultMethodExecutionService } from "../models/method_execution_service.ts";
import { DefaultModelValidationService } from "../models/validation_service.ts";
import type { Definition } from "../definitions/definition.ts";
import { findDefinitionByIdOrName } from "../models/model_lookup.ts";
import { ModelOutput } from "../models/model_output.ts";
import {
  extractExpressions,
  replaceExpressions,
} from "../expressions/expression_parser.ts";
import { extractResourceDependencies } from "../expressions/dependency_extractor.ts";
import {
  type DataRecord,
  type ExpressionContext,
  ModelResolver,
} from "../expressions/model_resolver.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import {
  DataOutputValidationService,
} from "../models/data_output_validation_service.ts";

/**
 * Context for step execution.
 */
export interface StepExecutionContext {
  workflowId: WorkflowId;
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  stepName: string;
  repoDir: string;
  /** Expression context for evaluating ${{ }} expressions */
  expressionContext?: ExpressionContext;
  /** Progress callback for streaming output */
  progress?: ExecutionProgressCallback;
  /** Current workflow run for progress callbacks */
  workflowRun?: WorkflowRun;
  /** The step being executed (for accessing data output overrides) */
  step?: Step;
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
  private readonly validationService = new DefaultModelValidationService();

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
      env?: Record<string, string>;
    },
    ctx: StepExecutionContext,
  ): Promise<unknown> {
    const cwd = task.workingDir ?? ctx.repoDir;

    const commandOptions: Deno.CommandOptions = {
      args: task.args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    };

    if (task.env) {
      commandOptions.env = task.env;
    }

    const command = new Deno.Command(task.command, commandOptions);

    // Use streaming if progress callbacks are provided
    if (ctx.progress?.onStepStdout || ctx.progress?.onStepStderr) {
      return await this.executeShellStreaming(command, ctx);
    }

    // Buffered execution (original behavior)
    const result = await command.output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Shell command failed: ${stderr}`);
    }

    const stdout = new TextDecoder().decode(result.stdout);
    return { stdout: stdout.trim(), exitCode: result.code };
  }

  private async executeShellStreaming(
    command: Deno.Command,
    ctx: StepExecutionContext,
  ): Promise<unknown> {
    const process = command.spawn();

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    // Stream stdout and stderr concurrently
    const stdoutPromise = this.streamOutput(
      process.stdout,
      (line) => {
        stdoutLines.push(line);
        if (ctx.progress?.onStepStdout && ctx.workflowRun) {
          ctx.progress.onStepStdout(
            ctx.workflowRun,
            ctx.jobName,
            ctx.stepName,
            line,
          );
        }
      },
    );

    const stderrPromise = this.streamOutput(
      process.stderr,
      (line) => {
        stderrLines.push(line);
        if (ctx.progress?.onStepStderr && ctx.workflowRun) {
          ctx.progress.onStepStderr(
            ctx.workflowRun,
            ctx.jobName,
            ctx.stepName,
            line,
          );
        }
      },
    );

    // Wait for streams to complete and process to exit
    const [, , status] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      process.status,
    ]);

    if (!status.success) {
      throw new Error(`Shell command failed: ${stderrLines.join("\n")}`);
    }

    return { stdout: stdoutLines.join("\n").trim(), exitCode: status.code };
  }

  private async streamOutput(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        // Process all complete lines
        for (let i = 0; i < lines.length - 1; i++) {
          onLine(lines[i]);
        }

        // Keep the incomplete line in the buffer
        buffer = lines[lines.length - 1];
      }

      // Process any remaining content
      if (buffer) {
        onLine(buffer);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async executeModelMethod(
    task: { modelIdOrName: string; methodName: string },
    ctx: StepExecutionContext,
  ): Promise<unknown> {
    const definitionRepo = new YamlDefinitionRepository(ctx.repoDir);
    const unifiedDataRepo = new FileSystemUnifiedDataRepository(ctx.repoDir);
    const outputRepo = new YamlOutputRepository(ctx.repoDir);
    const executionService = new DefaultMethodExecutionService();

    // Look up the model definition by ID or name
    const lookupResult = await findDefinitionByIdOrName(
      definitionRepo,
      task.modelIdOrName,
    );
    if (!lookupResult) {
      throw new Error(`Model not found: ${task.modelIdOrName}`);
    }

    // Keep original definition (with expressions)
    const { definition: originalDefinition, type: modelType } = lookupResult;

    // Get the model definition from registry
    const modelDef = modelRegistry.get(modelType);
    if (!modelDef) {
      throw new Error(`Unknown model type: ${modelType.normalized}`);
    }

    // Validate the model definition (including expression paths) BEFORE evaluation
    const validationResults = await this.validationService.validateModel(
      originalDefinition,
      modelDef,
      definitionRepo,
    );

    // Fail fast if validation fails
    const failures = validationResults.filter((r) => !r.passed);
    if (failures.length > 0) {
      const errors = failures.map((f) => `  ${f.name}: ${f.error}`).join("\n");
      throw new Error(
        `Model validation failed for "${originalDefinition.name}":\n${errors}`,
      );
    }

    // Evaluate expressions for execution (after validation passes)
    let evaluatedDefinition = originalDefinition;
    if (ctx.expressionContext) {
      // Set self context for this specific model before evaluating
      ctx.expressionContext.self = {
        id: originalDefinition.id,
        name: originalDefinition.name,
        version: originalDefinition.version,
        tags: originalDefinition.tags,
        attributes: originalDefinition.attributes,
      };

      evaluatedDefinition = await this.evaluateDefinitionExpressions(
        originalDefinition,
        ctx.expressionContext,
        ctx.repoDir,
      );
    }

    // Validate method exists on the model
    const method = modelDef.methods[task.methodName];
    if (!method) {
      const availableMethods = Object.keys(modelDef.methods).join(", ");
      throw new Error(
        `Unknown method '${task.methodName}' for type '${modelType.normalized}'. Available methods: ${
          availableMethods || "none"
        }`,
      );
    }

    // Create ModelOutput for tracking
    const definitionHash = await evaluatedDefinition.computeHash();
    const output = ModelOutput.create({
      definitionId: originalDefinition.id,
      methodName: task.methodName,
      provenance: {
        definitionHash,
        modelVersion: originalDefinition.version,
        triggeredBy: "workflow",
        workflowId: ctx.workflowId,
        workflowRunId: ctx.workflowRunId,
        stepName: ctx.stepName,
      },
    });

    // Mark as running and save
    output.markRunning();
    await outputRepo.save(modelType, task.methodName, output);

    // Track data outputs for context refresh
    let dataAttributes: Record<string, unknown> = {};
    let dataId: string | undefined;
    let dataName: string | undefined;

    try {
      // Build streaming callbacks if progress callbacks are available
      const streaming =
        (ctx.progress?.onStepStdout || ctx.progress?.onStepStderr)
          ? {
            onStdout: ctx.progress?.onStepStdout && ctx.workflowRun
              ? (line: string) =>
                ctx.progress!.onStepStdout!(
                  ctx.workflowRun!,
                  ctx.jobName,
                  ctx.stepName,
                  line,
                )
              : undefined,
            onStderr: ctx.progress?.onStepStderr && ctx.workflowRun
              ? (line: string) =>
                ctx.progress!.onStepStderr!(
                  ctx.workflowRun!,
                  ctx.jobName,
                  ctx.stepName,
                  line,
                )
              : undefined,
          }
          : undefined;

      // Execute the method with EVALUATED definition
      const result = await executionService.executeWorkflow(
        evaluatedDefinition,
        modelDef,
        task.methodName,
        {
          repoDir: ctx.repoDir,
          modelType,
          modelId: evaluatedDefinition.id,
          dataRepository: unifiedDataRepo,
          definitionRepository: definitionRepo,
          streaming,
          modelDefinition: modelDef,
        },
      );

      // Apply workflow step overrides (on top of definition overrides)
      if (ctx.step?.dataOutputOverrides && result.dataOutputs) {
        const validationService = new DataOutputValidationService();
        result.dataOutputs = result.dataOutputs.map((output) => {
          const spec = modelDef.dataOutputSpecs[output.specType.value];
          return validationService.applyDefaultsAndOverrides(
            output,
            spec,
            Array.from(ctx.step!.dataOutputOverrides),
          );
        });
      }

      // Handle data output persistence
      const savedArtifacts: Array<{
        dataId: string;
        name: string;
        version: number;
        tags: Record<string, string>;
      }> = [];
      if (result.dataOutputs && result.dataOutputs.length > 0) {
        for (const dataOutput of result.dataOutputs) {
          // Create Data entity from DataOutput with workflow-specific tags
          const { Data } = await import("../data/mod.ts");

          // Merge workflow-specific tags with model output tags
          const workflowTags: Record<string, string> = {
            ...dataOutput.metadata.tags,
            type: "step-output",
            workflow: ctx.workflowName,
            step: ctx.stepName,
          };

          const data = Data.create({
            name: dataOutput.name,
            contentType: dataOutput.metadata.contentType,
            lifetime: dataOutput.metadata.lifetime,
            garbageCollection: dataOutput.metadata.garbageCollection,
            streaming: dataOutput.metadata.streaming,
            tags: workflowTags,
            ownerDefinition: dataOutput.metadata.ownerDefinition,
          });

          // Save the data
          const saveResult = await unifiedDataRepo.save(
            modelType,
            evaluatedDefinition.id,
            data,
            dataOutput.content,
          );

          // Track artifact in output and for returning to step run
          const artifactRef = {
            dataId: data.id,
            name: dataOutput.name,
            version: saveResult.version,
            tags: workflowTags,
          };
          output.addDataArtifact(artifactRef);
          savedArtifacts.push(artifactRef);

          // Use first JSON data output for context refresh
          if (
            !dataId && dataOutput.metadata.contentType === "application/json"
          ) {
            dataId = data.id;
            dataName = dataOutput.name;
            try {
              const text = new TextDecoder().decode(dataOutput.content);
              dataAttributes = JSON.parse(text) as Record<string, unknown>;
            } catch {
              // Not valid JSON, skip attributes
            }
          }
        }
      }

      // Mark output as succeeded and save
      output.markSucceeded();
      await outputRepo.save(modelType, task.methodName, output);

      return {
        type: "model_method",
        model: task.modelIdOrName,
        method: task.methodName,
        resourceId: "", // Legacy field, now empty
        resourcePath: "", // Legacy field, now empty
        resourceAttributes: dataAttributes, // Use dataAttributes for backward compat
        dataId: dataId ?? "",
        dataName: dataName ?? "output",
        dataAttributes,
        dataArtifacts: savedArtifacts,
      };
    } catch (error) {
      // Mark output as failed and save
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      output.markFailed({ message: errorMessage, stack: errorStack });
      await outputRepo.save(modelType, task.methodName, output);
      throw error;
    }
  }

  /**
   * Evaluates expressions in a definition.
   */
  private async evaluateDefinitionExpressions(
    definition: Definition,
    context: ExpressionContext,
    repoDir: string,
  ): Promise<Definition> {
    const celEvaluator = new CelEvaluator();
    const definitionData = definition.toData();
    const expressions = extractExpressions(definitionData);

    if (expressions.length === 0) {
      return definition;
    }

    // Create ModelResolver for vault expression handling
    const definitionRepoForResolver = new YamlDefinitionRepository(repoDir);
    const modelResolver = new ModelResolver(definitionRepoForResolver, {
      repoDir,
    });

    // Evaluate each expression
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      // First resolve any vault expressions in the CEL expression
      const resolvedCelExpr = await modelResolver.resolveVaultExpressions(
        expr.celExpression,
      );

      // Then evaluate the CEL expression
      const value = celEvaluator.evaluate(resolvedCelExpr, context);
      evaluatedValues.set(expr.raw, value);
    }

    // Replace expressions with evaluated values
    const evaluatedData = replaceExpressions(definitionData, evaluatedValues);

    // Create new Definition from evaluated data
    const { Definition: DefClass } = await import(
      "../definitions/definition.ts"
    );
    return DefClass.fromData(
      evaluatedData as ReturnType<typeof definition.toData>,
    );
  }
}

/**
 * Implicit dependency mapping: jobName -> stepName -> implicitDeps[]
 */
export type ImplicitDependencyMap = Map<string, Map<string, string[]>>;

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
  /** Called once at start with implicit dependency mappings */
  onImplicitDependencies?(implicitDeps: ImplicitDependencyMap): void;
  /** Called for each line of stdout from shell commands */
  onStepStdout?(
    run: WorkflowRun,
    jobName: string,
    stepName: string,
    line: string,
  ): void;
  /** Called for each line of stderr from shell commands */
  onStepStderr?(
    run: WorkflowRun,
    jobName: string,
    stepName: string,
    line: string,
  ): void;
}

/**
 * Domain service for workflow execution.
 */
export class WorkflowExecutionService {
  private readonly sortService = new TopologicalSortService();
  private readonly executor: StepExecutor;
  private readonly definitionRepo: YamlDefinitionRepository;
  private readonly modelResolver: ModelResolver;
  private readonly dataRepo: FileSystemUnifiedDataRepository;

  constructor(
    private readonly workflowRepo: WorkflowRepository,
    private readonly runRepo: WorkflowRunRepository,
    private readonly repoDir: string,
    executor?: StepExecutor,
  ) {
    this.executor = executor ?? new DefaultStepExecutor();
    this.definitionRepo = new YamlDefinitionRepository(repoDir);
    this.dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    this.modelResolver = new ModelResolver(this.definitionRepo, {
      repoDir,
      dataRepo: this.dataRepo,
    });
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

    // Build expression context for the workflow
    const expressionContext = await this.modelResolver.buildContext();

    // Evaluate workflow and save to workflows-evaluated/
    const evaluatedWorkflow = await this.evaluateWorkflow(
      workflow,
      expressionContext,
    );
    const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
      this.repoDir,
    );
    await evaluatedWorkflowRepo.save(evaluatedWorkflow);

    // Create workflow run
    const run = WorkflowRun.create(workflow);

    // Build implicit dependencies for all jobs upfront
    const allImplicitDeps: ImplicitDependencyMap = new Map();
    for (const job of workflow.jobs) {
      const { implicitDeps } = await this.buildStepNodesWithImplicitDeps(
        job,
        workflow,
      );
      if (implicitDeps.size > 0) {
        allImplicitDeps.set(job.name, implicitDeps);
      }
    }

    // Report implicit dependencies before execution starts
    if (allImplicitDeps.size > 0) {
      progress?.onImplicitDependencies?.(allImplicitDeps);
    }

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
          this.executeJob(workflow, run, jobName, expressionContext, progress)
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
    expressionContext: ExpressionContext,
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

    // Create throttled save for incremental log persistence
    const [throttledSave, cleanupThrottledSave] = this.createThrottledSave(
      workflow.id,
      run,
    );

    // Wrap progress callbacks to persist logs incrementally
    const streamingCallbacks: ExecutionProgressCallback = {
      ...progress,
      onStepStdout: (run, jobName, stepName, line) => {
        // Call original callback if provided
        progress?.onStepStdout?.(run, jobName, stepName, line);
        // Append log line to step run and trigger save
        const stepRun = run.getJob(jobName)?.getStep(stepName);
        stepRun?.appendStdout(line);
        throttledSave();
      },
      onStepStderr: (run, jobName, stepName, line) => {
        // Call original callback if provided
        progress?.onStepStderr?.(run, jobName, stepName, line);
        // Append log line to step run and trigger save
        const stepRun = run.getJob(jobName)?.getStep(stepName);
        stepRun?.appendStderr(line);
        throttledSave();
      },
    };

    try {
      // Build step nodes with implicit dependencies from expressions
      const { nodes: stepNodes } = await this.buildStepNodesWithImplicitDeps(
        job,
        workflow,
      );

      const sortedSteps = this.sortService.sort(stepNodes);

      // Execute steps level by level
      let jobFailed = false;
      for (const level of sortedSteps.levels) {
        if (jobFailed) break;

        // Execute steps in parallel within each level
        const stepResults = await Promise.allSettled(
          level.map((stepName) =>
            this.executeStep(
              workflow,
              run,
              job,
              jobRun,
              stepName,
              expressionContext,
              streamingCallbacks,
            )
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
    } finally {
      // Clean up any pending timers
      cleanupThrottledSave();
    }
  }

  /**
   * Builds step graph nodes including implicit dependencies from expressions.
   * If a step's model input has ${{ model.X.resource.attributes.Y }}, then
   * that step implicitly depends on the step that creates model X's resource.
   *
   * Returns both the nodes and a mapping of step names to their implicit dependencies.
   */
  private async buildStepNodesWithImplicitDeps(
    job: Job,
    _workflow: Workflow,
  ): Promise<{ nodes: GraphNode[]; implicitDeps: Map<string, string[]> }> {
    // Build a map from model name/id to step name
    const modelToStep = new Map<string, string>();
    for (const step of job.steps) {
      if (step.task.isModelMethod()) {
        const task = step.task.data as { modelIdOrName: string };
        modelToStep.set(task.modelIdOrName, step.name);
      }
    }

    const nodes: GraphNode[] = [];
    const implicitDepsMap = new Map<string, string[]>();

    for (const step of job.steps) {
      const explicitDeps = step.getDependencyNames();
      const implicitDeps: string[] = [];

      // Check for implicit dependencies from expressions
      if (step.task.isModelMethod()) {
        const task = step.task.data as { modelIdOrName: string };

        // Look up the model definition to check for expressions
        const lookupResult = await findDefinitionByIdOrName(
          this.definitionRepo,
          task.modelIdOrName,
        );
        if (lookupResult) {
          const definitionData = lookupResult.definition.toData();
          const expressions = extractExpressions(definitionData);

          // Extract resource dependencies from expressions
          for (const expr of expressions) {
            const resourceRefs = extractResourceDependencies(
              expr.celExpression,
            );
            for (const modelRef of resourceRefs) {
              const dependsOnStep = modelToStep.get(modelRef);
              if (dependsOnStep && dependsOnStep !== step.name) {
                if (
                  !explicitDeps.includes(dependsOnStep) &&
                  !implicitDeps.includes(dependsOnStep)
                ) {
                  implicitDeps.push(dependsOnStep);
                }
              }
            }
          }
        }
      }

      // Store implicit deps for this step
      if (implicitDeps.length > 0) {
        implicitDepsMap.set(step.name, implicitDeps);
      }

      nodes.push({
        name: step.name,
        weight: step.weight,
        dependencies: [...explicitDeps, ...implicitDeps],
      });
    }

    return { nodes, implicitDeps: implicitDepsMap };
  }

  private async executeStep(
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    jobRun: JobRun,
    stepName: string,
    expressionContext: ExpressionContext,
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
        workflowRunId: run.id,
        workflowName: workflow.name,
        jobName: job.name,
        stepName,
        repoDir: this.repoDir,
        expressionContext,
        progress,
        workflowRun: run,
        step, // Include step for accessing data output overrides
      };

      const output = await this.executor.execute(step, ctx);

      // Update expression context with new resource and data if this was a model method
      if (step.task.isModelMethod() && output && typeof output === "object") {
        const taskOutput = output as {
          model?: string;
          resourceId?: string;
          resourceAttributes?: Record<string, unknown>;
          dataId?: string;
          dataName?: string;
          dataAttributes?: Record<string, unknown>;
          dataArtifacts?: Array<{
            dataId: string;
            name: string;
            version: number;
            tags: Record<string, string>;
          }>;
        };

        // Track data artifacts in step run
        if (taskOutput.dataArtifacts) {
          for (const artifact of taskOutput.dataArtifacts) {
            stepRun.addDataArtifact(artifact);
          }
        }
        if (taskOutput.model) {
          // Create model entry if it doesn't exist
          if (!expressionContext.model[taskOutput.model]) {
            expressionContext.model[taskOutput.model] = {
              input: {
                id: "",
                name: taskOutput.model,
                version: 1,
                tags: {},
                attributes: {},
              },
            };
          }
          const modelData = expressionContext.model[taskOutput.model];

          // Update resource context if available
          if (taskOutput.resourceId && taskOutput.resourceAttributes) {
            modelData.resource = {
              id: taskOutput.resourceId,
              version: 1,
              createdAt: new Date().toISOString(),
              attributes: taskOutput.resourceAttributes,
            };
          }
          // Update data context if available
          if (taskOutput.dataId && taskOutput.dataAttributes) {
            const dataName = taskOutput.dataName ?? "output";
            const record: DataRecord = {
              id: taskOutput.dataId,
              name: dataName,
              version: 1,
              createdAt: new Date().toISOString(),
              attributes: taskOutput.dataAttributes,
              tags: {},
            };

            // Rebuild map from existing data (may be unwrapped or map)
            let dataMap: Record<string, DataRecord> = {};
            if (modelData.data) {
              if (
                "id" in modelData.data &&
                typeof modelData.data.id === "string"
              ) {
                // Already unwrapped — re-wrap
                const existing = modelData.data as DataRecord;
                dataMap[existing.name] = existing;
              } else {
                dataMap = modelData.data as Record<string, DataRecord>;
              }
            }
            dataMap[dataName] = record;

            // Unwrap single artifact
            const entries = Object.values(dataMap);
            modelData.data = entries.length === 1 ? entries[0] : dataMap;
          }
        }
      }

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
    const id = createWorkflowId(idOrName);
    return await this.workflowRepo.findById(id);
  }

  private async saveRun(
    workflowId: WorkflowId,
    run: WorkflowRun,
  ): Promise<void> {
    await this.runRepo.save(workflowId, run);
  }

  /**
   * Creates a throttled save function that batches saves to avoid excessive I/O.
   * Saves at most once every 100ms.
   * Returns a tuple of [saveFunction, cleanupFunction].
   */
  private createThrottledSave(
    workflowId: WorkflowId,
    run: WorkflowRun,
  ): [() => void, () => void] {
    let timer: number | null = null;
    let pendingSave = false;

    const save = () => {
      pendingSave = true;
      if (timer !== null) return;

      timer = setTimeout(() => {
        if (pendingSave) {
          // Fire and forget - don't await to avoid blocking
          this.saveRun(workflowId, run).catch((error) => {
            console.error(
              "Failed to save workflow run during streaming:",
              error,
            );
          });
          pendingSave = false;
        }
        timer = null;
      }, 100);
    };

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    return [save, cleanup];
  }

  /**
   * Evaluates expressions in a workflow.
   */
  private async evaluateWorkflow(
    workflow: Workflow,
    context: ExpressionContext,
  ): Promise<Workflow> {
    const celEvaluator = new CelEvaluator();
    const workflowData = workflow.toData();
    const expressions = extractExpressions(workflowData);

    if (expressions.length === 0) {
      return workflow;
    }

    // Evaluate each expression
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      // First resolve any vault expressions in the CEL expression
      const resolvedCelExpr = await this.modelResolver.resolveVaultExpressions(
        expr.celExpression,
      );

      // Then evaluate the CEL expression
      const value = celEvaluator.evaluate(resolvedCelExpr, context);
      evaluatedValues.set(expr.raw, value);
    }

    // Replace expressions with evaluated values
    const evaluatedData = replaceExpressions(workflowData, evaluatedValues);

    // Create new Workflow from evaluated data
    return Workflow.fromData(evaluatedData as WorkflowData);
  }
}
