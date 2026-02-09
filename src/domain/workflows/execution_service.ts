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
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
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
import {
  containsVaultExpression,
  ExpressionEvaluationService,
} from "../expressions/expression_evaluation_service.ts";
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
import { UserError } from "../errors.ts";
import {
  getRunLogger,
  getWorkflowRunLogger,
} from "../../infrastructure/logging/logger.ts";

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
  /** Whether step executors should log execution details via LogTape */
  enableStepLogging?: boolean;
  /** When true, load previously-evaluated definitions instead of evaluating CEL */
  useLastEvaluated?: boolean;
  /** forEach iteration variable (e.g., { env: "dev" } for self.env) */
  forEachVariable?: { name: string; value: unknown };
}

/**
 * Represents an expanded step from a forEach iteration.
 */
interface ExpandedStep {
  step: Step;
  /** The expanded step name after evaluating expressions */
  expandedName: string;
  /** The forEach variable name and value */
  forEachVar: { name: string; value: unknown };
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

    // Use streaming if progress callbacks or step logging are enabled
    if (
      ctx.progress?.onStepStdout || ctx.progress?.onStepStderr ||
      ctx.enableStepLogging
    ) {
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
    const stepLogger = ctx.enableStepLogging
      ? getWorkflowRunLogger(ctx.workflowName, ctx.jobName, ctx.stepName)
      : undefined;

    const process = command.spawn();

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    // Stream stdout and stderr concurrently
    const stdoutPromise = this.streamOutput(
      process.stdout,
      (line) => {
        stdoutLines.push(line);
        stepLogger?.info(line);
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
        stepLogger?.warn(line);
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
    task: {
      modelIdOrName: string;
      methodName: string;
      inputs?: Record<string, unknown>;
    },
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

    // Log via model method run logger (same categories as standalone)
    const runLogger = ctx.enableStepLogging
      ? getRunLogger(originalDefinition.name, task.methodName)
      : undefined;

    runLogger?.info("Found model {name} ({type})", {
      name: originalDefinition.name,
      type: modelType.normalized,
    });

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

    // Evaluate CEL expressions (vault left raw for persistence)
    let evaluatedDefinition = originalDefinition;
    if (ctx.useLastEvaluated) {
      // Load previously-evaluated definition from cache
      runLogger?.info("Loading last evaluated definition");
      const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(
        ctx.repoDir,
      );
      const lastEvaluated = await evaluatedDefRepo.findByName(
        modelType,
        originalDefinition.name,
      );
      if (!lastEvaluated) {
        throw new Error(
          `No previously evaluated definition found for "${originalDefinition.name}". ` +
            `Run the workflow without --last-evaluated first.`,
        );
      }
      evaluatedDefinition = lastEvaluated;
    } else if (ctx.expressionContext) {
      runLogger?.info("Evaluating expressions");
      // Set self context for this specific model before evaluating
      ctx.expressionContext.self = {
        id: originalDefinition.id,
        name: originalDefinition.name,
        version: originalDefinition.version,
        tags: originalDefinition.tags,
        attributes: originalDefinition.attributes,
      };

      // Evaluate step task inputs and merge into context
      let stepInputs: Record<string, unknown> = {};
      if (task.inputs) {
        // Evaluate any expressions in the step task inputs
        const evalService = new ExpressionEvaluationService(
          new YamlDefinitionRepository(ctx.repoDir),
          ctx.repoDir,
        );
        stepInputs = evalService.evaluateData(
          task.inputs,
          ctx.expressionContext,
        ) as Record<string, unknown>;
      }

      // Merge step inputs with existing context inputs (step inputs take precedence)
      const originalInputs = ctx.expressionContext.inputs ?? {};
      ctx.expressionContext.inputs = { ...originalInputs, ...stepInputs };

      evaluatedDefinition = await this.evaluateDefinitionExpressions(
        originalDefinition,
        ctx.expressionContext,
        ctx.repoDir,
      );
    }

    // Save evaluated definition (with vault expressions still raw) for --last-evaluated
    const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(ctx.repoDir);
    await evaluatedDefRepo.save(modelType, evaluatedDefinition);

    // Resolve vault expressions at runtime (never persisted)
    const evalService = new ExpressionEvaluationService(
      new YamlDefinitionRepository(ctx.repoDir),
      ctx.repoDir,
    );
    evaluatedDefinition = await evalService.resolveVaultExpressionsInDefinition(
      evaluatedDefinition,
    );

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
        modelVersion: modelDef.version,
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
      runLogger?.info("Executing method {method}", {
        method: task.methodName,
      });

      // Build streaming callbacks — log via runLogger when enabled,
      // and always call progress callback for persistence
      const hasProgressStreaming = ctx.progress?.onStepStdout ||
        ctx.progress?.onStepStderr;
      const streaming = (runLogger || hasProgressStreaming)
        ? {
          onStdout: (line: string) => {
            runLogger?.info(line);
            if (ctx.progress?.onStepStdout && ctx.workflowRun) {
              ctx.progress.onStepStdout(
                ctx.workflowRun,
                ctx.jobName,
                ctx.stepName,
                line,
              );
            }
          },
          onStderr: (line: string) => {
            runLogger?.warn(line);
            if (ctx.progress?.onStepStderr && ctx.workflowRun) {
              ctx.progress.onStepStderr(
                ctx.workflowRun,
                ctx.jobName,
                ctx.stepName,
                line,
              );
            }
          },
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

          if (runLogger) {
            const dataPath = unifiedDataRepo.getPath(
              modelType,
              evaluatedDefinition.id,
              dataOutput.name,
              saveResult.version,
            );
            runLogger.info("Data saved to {path}", { path: dataPath });
          }

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

      runLogger?.with({ summary: true }).info(
        "Method {method} completed on {model}",
        { method: task.methodName, model: originalDefinition.name },
      );

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

      runLogger?.error("Method {method} failed: {error}", {
        method: task.methodName,
        model: originalDefinition.name,
        error: errorMessage,
      });

      throw error;
    }
  }

  /**
   * Evaluates CEL expressions in a definition, leaving vault expressions raw.
   * Vault expressions are resolved at runtime only.
   */
  private async evaluateDefinitionExpressions(
    definition: Definition,
    context: ExpressionContext,
    _repoDir: string,
  ): Promise<Definition> {
    const celEvaluator = new CelEvaluator();
    const definitionData = definition.toData();
    const expressions = extractExpressions(definitionData);

    if (expressions.length === 0) {
      return definition;
    }

    // Evaluate CEL-only expressions; skip vault-containing expressions
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsVaultExpression(expr.celExpression)) {
        continue;
      }

      const value = celEvaluator.evaluate(expr.celExpression, context);
      evaluatedValues.set(expr.raw, value);
    }

    // Replace only CEL-only expressions with evaluated values
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
    options?: {
      enableStepLogging?: boolean;
      lastEvaluated?: boolean;
      inputs?: Record<string, unknown>;
    },
  ): Promise<WorkflowRun> {
    // Look up workflow
    const workflow = await this.lookupWorkflow(idOrName);
    if (!workflow) {
      throw new Error(`Workflow not found: ${idOrName}`);
    }

    let expressionContext: ExpressionContext | undefined;

    if (options?.lastEvaluated) {
      // Load previously evaluated workflow from cache
      const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
        this.repoDir,
      );
      const lastEvaluated = await evaluatedWorkflowRepo.findByName(
        workflow.name,
      );
      if (!lastEvaluated) {
        throw new UserError(
          `No previously evaluated workflow found for "${workflow.name}".\n\n` +
            `Run the workflow without --last-evaluated first to generate evaluated data:\n` +
            `  swamp workflow run ${workflow.name}`,
        );
      }
      // No expression context needed — we use pre-evaluated definitions per-step
    } else {
      // Build expression context and evaluate workflow
      expressionContext = await this.modelResolver.buildContext();

      // Add workflow inputs to context
      if (options?.inputs) {
        expressionContext.inputs = options.inputs;
      }

      const evaluatedWorkflow = await this.evaluateWorkflow(
        workflow,
        expressionContext,
      );
      const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
        this.repoDir,
      );
      await evaluatedWorkflowRepo.save(evaluatedWorkflow);
    }

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
          this.executeJob(
            workflow,
            run,
            jobName,
            expressionContext,
            progress,
            options?.enableStepLogging,
            options?.lastEvaluated,
          )
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
    expressionContext: ExpressionContext | undefined,
    progress?: ExecutionProgressCallback,
    enableStepLogging?: boolean,
    lastEvaluated?: boolean,
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
      // Expand forEach steps if we have expression context
      let expandedStepsMap: Map<string, ExpandedStep[]> | undefined;
      if (expressionContext && !lastEvaluated) {
        expandedStepsMap = this.expandForEachSteps(job, expressionContext);
      }

      // Build step nodes with implicit dependencies from expressions
      const { nodes: stepNodes } = await this.buildStepNodesWithImplicitDeps(
        job,
        workflow,
      );

      // If we have expanded steps, update the graph nodes
      let effectiveNodes = stepNodes;
      if (expandedStepsMap) {
        effectiveNodes = [];
        for (const node of stepNodes) {
          const expanded = expandedStepsMap.get(node.name);
          if (expanded && expanded.length > 0) {
            // Create nodes for each expanded step
            for (const exp of expanded) {
              effectiveNodes.push({
                name: exp.expandedName,
                weight: node.weight,
                // Map dependencies to expanded step names
                dependencies: node.dependencies.map((dep) => {
                  const depExpanded = expandedStepsMap!.get(dep);
                  // For now, depend on all expansions of the dependency
                  // (future: support forEach-aware dependency mapping)
                  return depExpanded && depExpanded.length > 0
                    ? depExpanded[0].expandedName
                    : dep;
                }),
              });
            }
          } else if (!expanded || expanded.length === 0) {
            // Skip steps that expanded to empty (e.g., empty array)
            continue;
          } else {
            effectiveNodes.push(node);
          }
        }
      }

      const sortedSteps = this.sortService.sort(effectiveNodes);

      // Execute steps level by level
      let jobFailed = false;
      for (const level of sortedSteps.levels) {
        if (jobFailed) break;

        // Execute steps in parallel within each level
        const stepResults = await Promise.allSettled(
          level.map((stepName) => {
            // Find the expanded step info if applicable
            let forEachVar: { name: string; value: unknown } | undefined;
            let originalStep: Step | undefined;

            if (expandedStepsMap) {
              for (const [, expanded] of expandedStepsMap) {
                const found = expanded.find((e) => e.expandedName === stepName);
                if (found) {
                  forEachVar = found.forEachVar;
                  originalStep = found.step;
                  break;
                }
              }
            }

            return this.executeExpandedStep(
              workflow,
              run,
              job,
              jobRun,
              stepName,
              originalStep,
              forEachVar,
              expressionContext,
              streamingCallbacks,
              enableStepLogging,
              lastEvaluated,
            );
          }),
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

  /**
   * Expands forEach steps into multiple concrete steps.
   * For steps with forEach, evaluates the `in` expression and creates
   * one expanded step per item in the result.
   *
   * @param job - The job containing steps
   * @param context - Expression context for evaluating forEach.in
   * @returns Map of original step name to expanded steps (or single entry for non-forEach steps)
   */
  private expandForEachSteps(
    job: Job,
    context: ExpressionContext,
  ): Map<string, ExpandedStep[]> {
    const celEvaluator = new CelEvaluator();
    const result = new Map<string, ExpandedStep[]>();

    for (const step of job.steps) {
      if (!step.forEach) {
        // No forEach - use original step as-is
        result.set(step.name, [{
          step,
          expandedName: step.name,
          forEachVar: { name: "", value: undefined },
        }]);
        continue;
      }

      // Evaluate the forEach.in expression
      const inExpression = step.forEach.in;
      const itemName = step.forEach.item;

      // Extract the CEL expression (remove ${{ }})
      const match = inExpression.match(/\$\{\{\s*(.+?)\s*\}\}/);
      if (!match) {
        throw new Error(
          `Invalid forEach.in expression: ${inExpression}. Must be in ${{}} format.`,
        );
      }

      const celExpr = match[1];
      const items = celEvaluator.evaluate(celExpr, context);

      // Handle both arrays and objects
      const expandedSteps: ExpandedStep[] = [];

      if (Array.isArray(items)) {
        // Array iteration: self.{item} = item value
        for (const item of items) {
          // Evaluate the step name with the forEach context
          const stepContext = {
            ...context,
            self: {
              ...context.self,
              [itemName]: item,
            },
          };

          // Evaluate step name (may contain ${{ self.env }})
          let expandedName = step.name;
          const nameMatch = step.name.match(/\$\{\{\s*(.+?)\s*\}\}/);
          if (nameMatch) {
            const value = celEvaluator.evaluate(nameMatch[1], stepContext);
            expandedName = step.name.replace(nameMatch[0], String(value));
          }

          expandedSteps.push({
            step,
            expandedName,
            forEachVar: { name: itemName, value: item },
          });
        }
      } else if (items && typeof items === "object") {
        // Object iteration: self.{item} = { key, value }
        for (const [key, value] of Object.entries(items)) {
          const objItem = { key, value };

          // Evaluate the step name with the forEach context
          const stepContext = {
            ...context,
            self: {
              ...context.self,
              [itemName]: objItem,
            },
          };

          // Evaluate step name
          let expandedName = step.name;
          const nameMatch = step.name.match(/\$\{\{\s*(.+?)\s*\}\}/);
          if (nameMatch) {
            const evalValue = celEvaluator.evaluate(nameMatch[1], stepContext);
            expandedName = step.name.replace(nameMatch[0], String(evalValue));
          }

          expandedSteps.push({
            step,
            expandedName,
            forEachVar: { name: itemName, value: objItem },
          });
        }
      } else {
        throw new Error(
          `forEach.in must evaluate to an array or object, got: ${typeof items}`,
        );
      }

      // If no items, still store empty array
      result.set(step.name, expandedSteps);
    }

    return result;
  }

  private async executeStep(
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    jobRun: JobRun,
    stepName: string,
    expressionContext: ExpressionContext | undefined,
    progress?: ExecutionProgressCallback,
    enableStepLogging?: boolean,
    lastEvaluated?: boolean,
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
        expressionContext: lastEvaluated ? undefined : expressionContext,
        progress,
        workflowRun: run,
        step, // Include step for accessing data output overrides
        enableStepLogging,
        useLastEvaluated: lastEvaluated,
      };

      const output = await this.executor.execute(step, ctx);

      // Track data artifacts and update expression context if this was a model method
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

        // Update expression context for subsequent steps (only when not using --last-evaluated)
        if (expressionContext && taskOutput.model) {
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

  /**
   * Executes a step that may have been expanded from a forEach.
   * Handles both regular steps and forEach-expanded steps.
   */
  private async executeExpandedStep(
    workflow: Workflow,
    run: WorkflowRun,
    job: Job,
    jobRun: JobRun,
    stepName: string,
    originalStep: Step | undefined,
    forEachVar: { name: string; value: unknown } | undefined,
    expressionContext: ExpressionContext | undefined,
    progress?: ExecutionProgressCallback,
    enableStepLogging?: boolean,
    lastEvaluated?: boolean,
  ): Promise<void> {
    // For forEach-expanded steps, use the original step but create a dynamic step run
    const step = originalStep ?? job.getStep(stepName);
    if (!step) {
      throw new Error(`Step not found: ${stepName}`);
    }

    // For forEach-expanded steps, we need to dynamically create the step run
    let stepRun = jobRun.getStep(stepName);
    if (!stepRun && forEachVar && forEachVar.name) {
      // This is a forEach-expanded step - add it to the job run
      jobRun.addExpandedStep(stepName);
      stepRun = jobRun.getStep(stepName);
    }
    if (!stepRun) {
      throw new Error(`Step run not found: ${stepName}`);
    }

    // Check if step's trigger condition is met (skip for forEach-expanded steps
    // as they don't have the same dependencies structure)
    if (!forEachVar || !forEachVar.name) {
      const shouldRun = this.shouldStepRun(step, jobRun);
      if (!shouldRun) {
        stepRun.skip();
        progress?.onStepSkip?.(run, job.name, stepName);
        return;
      }
    }

    // Start step
    stepRun.start();
    progress?.onStepStart?.(run, job.name, stepName);

    try {
      // Build the expression context with forEach variable
      let stepExprContext = expressionContext;
      if (expressionContext && forEachVar && forEachVar.name) {
        const baseSelf = expressionContext.self ?? {
          id: "",
          name: "",
          version: 1,
          tags: {},
          attributes: {},
        };
        stepExprContext = {
          ...expressionContext,
          self: {
            ...baseSelf,
            [forEachVar.name]: forEachVar.value,
          },
        };
      }

      const ctx: StepExecutionContext = {
        workflowId: workflow.id,
        workflowRunId: run.id,
        workflowName: workflow.name,
        jobName: job.name,
        stepName,
        repoDir: this.repoDir,
        expressionContext: lastEvaluated ? undefined : stepExprContext,
        progress,
        workflowRun: run,
        step,
        enableStepLogging,
        useLastEvaluated: lastEvaluated,
        forEachVariable: forEachVar,
      };

      const output = await this.executor.execute(step, ctx);

      // Track data artifacts and update expression context if this was a model method
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

        // Update expression context for subsequent steps (only when not using --last-evaluated)
        if (stepExprContext && taskOutput.model) {
          // Create model entry if it doesn't exist
          if (!stepExprContext.model[taskOutput.model]) {
            stepExprContext.model[taskOutput.model] = {
              input: {
                id: "",
                name: taskOutput.model,
                version: 1,
                tags: {},
                attributes: {},
              },
            };
          }
          const modelData = stepExprContext.model[taskOutput.model];

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
      if (!dep.condition.evaluate(run, dep.job)) {
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
      if (!dep.condition.evaluate(jobRun, dep.step)) {
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
   * Evaluates CEL expressions in a workflow, leaving vault expressions raw.
   * Vault expressions are resolved at runtime only.
   */
  private evaluateWorkflow(
    workflow: Workflow,
    context: ExpressionContext,
  ): Workflow {
    const celEvaluator = new CelEvaluator();
    const workflowData = workflow.toData();
    const expressions = extractExpressions(workflowData);

    if (expressions.length === 0) {
      return workflow;
    }

    // Evaluate CEL-only expressions; skip vault-containing expressions
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsVaultExpression(expr.celExpression)) {
        continue;
      }

      const value = celEvaluator.evaluate(expr.celExpression, context);
      evaluatedValues.set(expr.raw, value);
    }

    // Replace only CEL-only expressions with evaluated values
    const evaluatedData = replaceExpressions(workflowData, evaluatedValues);

    // Create new Workflow from evaluated data
    return Workflow.fromData(evaluatedData as WorkflowData);
  }
}
