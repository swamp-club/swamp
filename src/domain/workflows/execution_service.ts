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
import { UserError } from "../errors.ts";
import { InputOverrideValidationService } from "../inputs/mod.ts";
import {
  getRunLogger,
  runFileSink,
} from "../../infrastructure/logging/logger.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { join } from "@std/path";

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
  /** Current workflow nesting depth for recursion guard (max 10) */
  workflowNestingDepth?: number;
  /** Set of ancestor workflow IDs for cycle detection */
  ancestorWorkflowIds?: Set<string>;
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
 * Maximum nesting depth for workflow-calling-workflow execution.
 */
const MAX_WORKFLOW_NESTING_DEPTH = 10;

/**
 * Default step executor that handles model methods and workflow invocations.
 */
export class DefaultStepExecutor implements StepExecutor {
  private readonly validationService = new DefaultModelValidationService();

  constructor(
    private readonly workflowRepo?: WorkflowRepository,
    private readonly runRepo?: WorkflowRunRepository,
    private readonly repoDir?: string,
  ) {}

  async execute(step: Step, ctx: StepExecutionContext): Promise<unknown> {
    const task = step.task.data;

    if (task.type === "model_method") {
      return await this.executeModelMethod(task, ctx);
    } else if (task.type === "workflow") {
      return await this.executeWorkflowTask(task, ctx);
    }

    throw new Error(`Unknown task type: ${(task as { type: string }).type}`);
  }

  private async executeWorkflowTask(
    task: {
      workflowIdOrName: string;
      inputs?: Record<string, unknown>;
    },
    ctx: StepExecutionContext,
  ): Promise<unknown> {
    if (!this.workflowRepo || !this.runRepo || !this.repoDir) {
      throw new Error(
        "Workflow execution requires workflowRepo, runRepo, and repoDir to be provided to DefaultStepExecutor",
      );
    }

    // Recursion guard
    const depth = ctx.workflowNestingDepth ?? 0;
    if (depth >= MAX_WORKFLOW_NESTING_DEPTH) {
      throw new Error(
        `Maximum workflow nesting depth (${MAX_WORKFLOW_NESTING_DEPTH}) exceeded. ` +
          `Workflow "${task.workflowIdOrName}" cannot be invoked at depth ${
            depth + 1
          }.`,
      );
    }

    // Cycle detection
    const ancestors = ctx.ancestorWorkflowIds ?? new Set<string>();
    if (ancestors.has(task.workflowIdOrName)) {
      const chain = [...ancestors, task.workflowIdOrName].join(" -> ");
      throw new Error(
        `Workflow cycle detected: ${chain}. ` +
          `A workflow cannot invoke itself directly or indirectly.`,
      );
    }

    // Evaluate inputs using the expression context
    let evaluatedInputs = task.inputs;
    if (task.inputs && ctx.expressionContext) {
      const evalService = new ExpressionEvaluationService(
        new YamlDefinitionRepository(ctx.repoDir),
        ctx.repoDir,
      );
      evaluatedInputs = evalService.evaluateData(
        task.inputs,
        ctx.expressionContext,
      ) as Record<string, unknown>;
    }

    // Create a child WorkflowExecutionService with nesting context
    const childAncestors = new Set(ancestors);
    childAncestors.add(ctx.workflowName);

    const childExecutor = new DefaultStepExecutor(
      this.workflowRepo,
      this.runRepo,
      this.repoDir,
    );

    const childService = new WorkflowExecutionService(
      this.workflowRepo,
      this.runRepo,
      this.repoDir,
      childExecutor,
    );

    const childRun = await childService.execute(
      task.workflowIdOrName,
      ctx.progress,
      {
        enableStepLogging: ctx.enableStepLogging,
        inputs: evaluatedInputs,
        workflowNestingDepth: depth + 1,
        ancestorWorkflowIds: childAncestors,
      },
    );

    // Propagate child workflow failure to the parent step
    if (childRun.status === "failed") {
      throw new Error(
        `Nested workflow "${task.workflowIdOrName}" failed.`,
      );
    }

    return {
      type: "workflow",
      workflow: task.workflowIdOrName,
      runId: childRun.id,
      status: childRun.status,
    };
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
    const runLogger = getRunLogger(originalDefinition.name, task.methodName);

    runLogger.info("Found model {name} ({type})", {
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
      runLogger.info("Evaluating expressions");
      // Set self context for this specific model before evaluating
      // Preserve any forEach variables that were set by the workflow engine
      const forEachVars: Record<string, unknown> = {};
      if (ctx.forEachVariable && ctx.forEachVariable.name) {
        forEachVars[ctx.forEachVariable.name] = ctx.forEachVariable.value;
      }
      ctx.expressionContext.self = {
        id: originalDefinition.id,
        name: originalDefinition.name,
        version: originalDefinition.version,
        tags: originalDefinition.tags,
        attributes: originalDefinition.attributes,
        ...forEachVars,
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

      // Validate and apply step inputs as attribute overrides (implicit inputs)
      // But only for keys that aren't defined in the definition's inputs schema
      // (those are handled by expression evaluation via ${{ inputs.X }})
      const definitionInputKeys = originalDefinition.inputs
        ? Object.keys(
          (originalDefinition.inputs as {
            properties?: Record<string, unknown>;
          })
            .properties || {},
        )
        : [];
      const overrideInputs = Object.fromEntries(
        Object.entries(stepInputs).filter(([key]) =>
          !definitionInputKeys.includes(key)
        ),
      );
      if (Object.keys(overrideInputs).length > 0) {
        const method = modelDef.methods[task.methodName];
        if (method) {
          const overrideValidationService =
            new InputOverrideValidationService();
          const overrideResult = overrideValidationService.validate(
            overrideInputs,
            method.inputAttributesSchema,
          );
          if (!overrideResult.valid) {
            const errorMessages = overrideResult.errors
              .map((e) => {
                let msg = `  ${e.key}: ${e.message}`;
                if (e.suggestion) {
                  msg += ` (${e.suggestion})`;
                }
                return msg;
              })
              .join("\n");
            throw new UserError(
              `Invalid step input overrides in "${ctx.stepName}":\n${errorMessages}`,
            );
          }
        }
        for (const [key, value] of Object.entries(overrideInputs)) {
          evaluatedDefinition.setAttribute(key, value);
        }
      }
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
    // Reference the workflow run's log file for history access
    if (ctx.workflowRun?.logFile) {
      output.setLogFile(ctx.workflowRun.logFile);
    }
    await outputRepo.save(modelType, task.methodName, output);

    // Track data outputs for context refresh
    let dataAttributes: Record<string, unknown> = {};
    let dataId: string | undefined;
    let dataName: string | undefined;

    try {
      runLogger.info("Executing method {method}", {
        method: task.methodName,
      });

      // Build workflow-specific tag overrides
      const workflowTagOverrides: Record<string, string> = {
        type: "step-output",
        workflow: ctx.workflowName,
        step: ctx.stepName,
      };

      // Convert step's dataOutputOverrides to the format expected by createDataWriterFactory
      const stepDataOutputOverrides = ctx.step?.dataOutputOverrides
        ? Array.from(ctx.step.dataOutputOverrides).map((override) => ({
          specType: override.specType.value,
          lifetime: override.lifetime,
          garbageCollection: override.garbageCollection,
          tags: override.tags,
        }))
        : undefined;

      // Execute the method with EVALUATED definition
      // Logger handles both console and file persistence via RunFileSink
      // Data is persisted by DataWriter during execution — no double-save
      const result = await executionService.executeWorkflow(
        evaluatedDefinition,
        modelDef,
        task.methodName,
        {
          repoDir: ctx.repoDir,
          modelType,
          modelId: evaluatedDefinition.id,
          logger: runLogger,
          dataRepository: unifiedDataRepo,
          definitionRepository: definitionRepo,
          modelDefinition: modelDef,
          tagOverrides: workflowTagOverrides,
          dataOutputOverrides: stepDataOutputOverrides,
        },
      );

      // Extract artifact info from dataHandles (already persisted by DataWriter)
      const savedArtifacts: Array<{
        dataId: string;
        name: string;
        version: number;
        tags: Record<string, string>;
      }> = [];
      if (result.dataHandles && result.dataHandles.length > 0) {
        for (const handle of result.dataHandles) {
          const artifactRef = {
            dataId: handle.dataId,
            name: handle.name,
            version: handle.version,
            tags: handle.tags,
          };
          output.addDataArtifact(artifactRef);
          savedArtifacts.push(artifactRef);

          const dataPath = unifiedDataRepo.getPath(
            modelType,
            evaluatedDefinition.id,
            handle.name,
            handle.version,
          );
          runLogger.info("Data saved to {path}", { path: dataPath });

          // Use first JSON data handle for context refresh
          if (
            !dataId && handle.metadata.contentType === "application/json"
          ) {
            dataId = handle.dataId;
            dataName = handle.name;
            try {
              const content = await unifiedDataRepo.getContent(
                modelType,
                evaluatedDefinition.id,
                handle.name,
                handle.version,
              );
              if (content) {
                const text = new TextDecoder().decode(content);
                dataAttributes = JSON.parse(text) as Record<string, unknown>;
              }
            } catch {
              // Not valid JSON, skip attributes
            }
          }
        }
      }

      // Mark output as succeeded and save
      output.markSucceeded();
      await outputRepo.save(modelType, task.methodName, output);

      runLogger.with({ summary: true }).info(
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

      runLogger.error("Method {method} failed: {error}", {
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
    this.executor = executor ??
      new DefaultStepExecutor(workflowRepo, runRepo, repoDir);
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
      workflowNestingDepth?: number;
      ancestorWorkflowIds?: Set<string>;
    },
  ): Promise<WorkflowRun> {
    // Look up workflow
    let workflow = await this.lookupWorkflow(idOrName);
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
            `Evaluate the workflow first to generate evaluated data:\n` +
            `  swamp workflow evaluate ${workflow.name}`,
        );
      }
      // Use the fully evaluated workflow (forEach expanded, expressions resolved)
      workflow = lastEvaluated;
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

    // Register run file sink target for the workflow log output
    const workflowLogPath = join(
      swampPath(this.repoDir, SWAMP_SUBDIRS.workflowRuns),
      workflow.id,
      `workflow-run-${run.id}.log`,
    );
    const workflowLogCategory: string[] = [];
    await runFileSink.register(workflowLogCategory, workflowLogPath);
    run.setLogFile(workflowLogPath);

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
            options?.workflowNestingDepth,
            options?.ancestorWorkflowIds,
          )
        ),
      );
      await this.saveRun(workflow.id, run);
    }

    // Complete workflow
    run.complete();
    progress?.onWorkflowComplete?.(run);
    await this.saveRun(workflow.id, run);

    // Unregister workflow log file sink
    runFileSink.unregister(workflowLogCategory);

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
    workflowNestingDepth?: number,
    ancestorWorkflowIds?: Set<string>,
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
            progress,
            enableStepLogging,
            lastEvaluated,
            workflowNestingDepth,
            ancestorWorkflowIds,
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
        throw new UserError(
          `Invalid forEach.in expression: ${inExpression}. Must be in $\{{ }} format.`,
        );
      }

      const celExpr = match[1];
      const items = celEvaluator.evaluate(celExpr, context);

      // Handle both arrays and objects
      const expandedSteps: ExpandedStep[] = [];

      const nameHasExpression = /\$\{\{.+?\}\}/.test(step.name);

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
          } else if (!nameHasExpression) {
            // Step name has no expression template — append item value for uniqueness
            expandedName = `${step.name}-${String(item)}`;
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
          } else if (!nameHasExpression) {
            // Step name has no expression template — append key for uniqueness
            expandedName = `${step.name}-${key}`;
          }

          expandedSteps.push({
            step,
            expandedName,
            forEachVar: { name: itemName, value: objItem },
          });
        }
      } else {
        throw new UserError(
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
    workflowNestingDepth?: number,
    ancestorWorkflowIds?: Set<string>,
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
        step,
        enableStepLogging,
        useLastEvaluated: lastEvaluated,
        workflowNestingDepth,
        ancestorWorkflowIds,
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
    workflowNestingDepth?: number,
    ancestorWorkflowIds?: Set<string>,
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
        workflowNestingDepth,
        ancestorWorkflowIds,
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
   * Evaluates CEL expressions in a workflow, leaving vault expressions raw.
   * Vault expressions are resolved at runtime only.
   * forEach-related expressions (self.* and forEach.in) are left raw for
   * runtime expansion.
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

    // Collect forEach.in expressions to skip during evaluation
    const forEachInExpressions = new Set<string>();
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (step.forEach) {
          const match = step.forEach.in.match(/\$\{\{\s*(.+?)\s*\}\}/);
          if (match) {
            forEachInExpressions.add(step.forEach.in);
          }
        }
      }
    }

    // Evaluate CEL-only expressions; skip vault, self.*, and forEach.in expressions
    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsVaultExpression(expr.celExpression)) {
        continue;
      }
      // Skip self.* expressions — they reference forEach variables resolved at runtime
      if (expr.celExpression.match(/\bself\./)) {
        continue;
      }
      // Skip forEach.in expressions — they must remain as strings for forEach expansion
      if (forEachInExpressions.has(expr.raw)) {
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
