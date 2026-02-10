import { z } from "zod";
import { ModelType } from "../../model_type.ts";
import { computeChecksum } from "../../checksum.ts";
import {
  DataSpecType,
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../../model.ts";
import type { Definition } from "../../../definitions/definition.ts";

/**
 * Schema for workflow execution data that will be converted to Mermaid diagram.
 */
export const WorkflowExecutionSchema = z.object({
  workflowName: z.string(),
  status: z.enum(["succeeded", "failed", "cancelled", "skipped"]),
  jobs: z.array(z.object({
    name: z.string(),
    status: z.enum(["succeeded", "failed", "cancelled", "skipped"]),
    dependsOn: z.array(z.object({
      job: z.string(),
      condition: z.object({
        type: z.string(),
      }),
    })).optional(),
    steps: z.array(z.object({
      name: z.string(),
      status: z.enum(["succeeded", "failed", "cancelled", "skipped"]),
      task: z.object({
        type: z.enum(["model_method", "workflow"]),
        modelIdOrName: z.string().optional(),
        methodName: z.string().optional(),
        workflowIdOrName: z.string().optional(),
      }),
      dependsOn: z.array(z.object({
        step: z.string(),
        condition: z.object({
          type: z.string(),
        }),
      })).optional(),
    })),
  })),
});

/**
 * Schema for mermaid diagram model input attributes.
 */
export const MermaidWorkflowInputAttributesSchema = z.object({
  /** The workflow execution data to convert to Mermaid */
  workflowExecution: WorkflowExecutionSchema,
  /** Optional title for the diagram */
  title: z.string().optional(),
  /** Include step details in the diagram */
  includeSteps: z.boolean().default(false),
  /** Color scheme for different statuses */
  colorScheme: z.object({
    succeeded: z.string().default("#90EE90"),
    failed: z.string().default("#FFB6C1"),
    cancelled: z.string().default("#D3D3D3"),
    skipped: z.string().default("#FFFFE0"),
  }).default({
    succeeded: "#90EE90",
    failed: "#FFB6C1",
    cancelled: "#D3D3D3",
    skipped: "#FFFFE0",
  }),
});

/**
 * Type for mermaid diagram model input attributes.
 */
export type MermaidWorkflowInputAttributes = z.infer<
  typeof MermaidWorkflowInputAttributesSchema
>;

/**
 * Schema for mermaid diagram model resource attributes.
 */
export const MermaidWorkflowResourceAttributesSchema = z.object({
  /** The original workflow name */
  workflowName: z.string(),
  /** Number of jobs in the workflow */
  jobCount: z.number().int().nonnegative(),
  /** Number of steps across all jobs */
  stepCount: z.number().int().nonnegative(),
  /** Overall workflow status */
  workflowStatus: z.enum(["succeeded", "failed", "cancelled", "skipped"]),
  /** Timestamp when diagram was generated */
  generatedAt: z.string().datetime(),
  /** Reference to the Mermaid diagram file */
  diagramFileId: z.string().uuid(),
});

/**
 * Type for mermaid diagram model resource attributes.
 */
export type MermaidWorkflowResourceAttributes = z.infer<
  typeof MermaidWorkflowResourceAttributesSchema
>;

/**
 * The mermaid workflow diagram model type identifier.
 */
export const MERMAID_WORKFLOW_MODEL_TYPE = ModelType.create(
  "mermaid/workflow-diagram",
);

/**
 * Generates a node ID safe for Mermaid syntax.
 */
function generateNodeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Gets the appropriate color for a status.
 */
function getStatusColor(
  status: string,
  colorScheme: Record<string, string>,
): string {
  return colorScheme[status] || "#FFFFFF";
}

/**
 * Generates Mermaid diagram syntax from workflow execution data.
 */
function generateMermaidDiagram(
  execution: z.infer<typeof WorkflowExecutionSchema>,
  options: {
    title?: string;
    includeSteps: boolean;
    colorScheme: Record<string, string>;
  },
): string {
  const lines: string[] = [];

  // Add diagram type and direction
  lines.push("graph TD");

  // Add title if provided
  if (options.title) {
    lines.push(`    %% ${options.title}`);
  }

  // Add workflow start node
  const startId = "START";
  lines.push(`    ${startId}[Workflow: ${execution.workflowName}]`);

  // Track nodes and connections
  const jobNodes: string[] = [];
  const connections: string[] = [];
  const styling: string[] = [];

  // Create job nodes
  for (const job of execution.jobs) {
    const jobId = generateNodeId(`job_${job.name}`);
    jobNodes.push(jobId);

    if (options.includeSteps && job.steps.length > 0) {
      // Create subgraph for job with steps
      lines.push(`    subgraph ${jobId}_sg["Job: ${job.name}"]`);

      const stepNodes: string[] = [];
      for (const step of job.steps) {
        const stepId = generateNodeId(`${job.name}_${step.name}`);
        stepNodes.push(stepId);

        let taskInfo = "";
        if (
          step.task.type === "model_method"
        ) {
          taskInfo = `${step.task.modelIdOrName}.${step.task.methodName}`;
        } else if (step.task.type === "workflow") {
          taskInfo = `workflow: ${step.task.workflowIdOrName}`;
        }

        lines.push(`        ${stepId}["${step.name}<br/>${taskInfo}"]`);
        styling.push(
          `    classDef ${stepId}_class fill:${
            getStatusColor(step.status, options.colorScheme)
          }`,
        );
        styling.push(`    class ${stepId} ${stepId}_class`);

        // Add step dependencies
        if (step.dependsOn) {
          for (const dep of step.dependsOn) {
            const depStepId = generateNodeId(`${job.name}_${dep.step}`);
            connections.push(`    ${depStepId} --> ${stepId}`);
          }
        }
      }

      // Connect steps in sequence if no explicit dependencies
      for (let i = 0; i < stepNodes.length - 1; i++) {
        const hasExplicitDeps = job.steps[i + 1].dependsOn &&
          job.steps[i + 1].dependsOn!.length > 0;
        if (!hasExplicitDeps) {
          connections.push(`        ${stepNodes[i]} --> ${stepNodes[i + 1]}`);
        }
      }

      lines.push("    end");

      // Create main job node that represents the subgraph
      lines.push(`    ${jobId}["Job: ${job.name}<br/>Status: ${job.status}"]`);
    } else {
      // Simple job node without steps
      lines.push(`    ${jobId}["Job: ${job.name}<br/>Status: ${job.status}"]`);
    }

    // Add job styling
    styling.push(
      `    classDef ${jobId}_class fill:${
        getStatusColor(job.status, options.colorScheme)
      }`,
    );
    styling.push(`    class ${jobId} ${jobId}_class`);

    // Connect start to job if it has no dependencies
    if (!job.dependsOn || job.dependsOn.length === 0) {
      connections.push(`    ${startId} --> ${jobId}`);
    }
  }

  // Add job dependencies
  for (const job of execution.jobs) {
    if (job.dependsOn) {
      const jobId = generateNodeId(`job_${job.name}`);
      for (const dep of job.dependsOn) {
        const depJobId = generateNodeId(`job_${dep.job}`);
        connections.push(`    ${depJobId} --> ${jobId}`);
      }
    }
  }

  // Add workflow end node
  const endId = "END";
  lines.push(`    ${endId}[End: ${execution.status}]`);
  styling.push(
    `    classDef ${endId}_class fill:${
      getStatusColor(execution.status, options.colorScheme)
    }`,
  );
  styling.push(`    class ${endId} ${endId}_class`);

  // Connect final jobs to end
  const finalJobs = execution.jobs.filter((job) =>
    !execution.jobs.some((otherJob) =>
      otherJob.dependsOn?.some((dep) => dep.job === job.name)
    )
  );

  for (const finalJob of finalJobs) {
    const finalJobId = generateNodeId(`job_${finalJob.name}`);
    connections.push(`    ${finalJobId} --> ${endId}`);
  }

  // Add all connections
  lines.push("    %% Connections");
  lines.push(...connections);

  // Add all styling
  lines.push("    %% Styling");
  lines.push(...styling);

  return lines.join("\n");
}

/**
 * Executes the "generate" method for the mermaid workflow diagram model.
 */
async function executeGenerate(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = MermaidWorkflowInputAttributesSchema.parse(
    definition.attributes,
  );

  // Generate the Mermaid diagram
  const diagramContent = generateMermaidDiagram(attrs.workflowExecution, {
    title: attrs.title,
    includeSteps: attrs.includeSteps,
    colorScheme: attrs.colorScheme,
  });

  // Convert to bytes
  const content = new TextEncoder().encode(diagramContent);
  const checksum = await computeChecksum(content);
  const filename =
    `workflow-${attrs.workflowExecution.workflowName}-diagram.mmd`;

  // Count jobs and steps
  const jobCount = attrs.workflowExecution.jobs.length;
  const stepCount = attrs.workflowExecution.jobs.reduce(
    (total, job) => total + job.steps.length,
    0,
  );

  // Create metadata attributes
  const metadataAttributes = {
    workflowName: attrs.workflowExecution.workflowName,
    jobCount,
    stepCount,
    workflowStatus: attrs.workflowExecution.status,
    generatedAt: new Date().toISOString(),
    filename,
    checksum,
  };

  const metadataWriter = context.createDataWriter!({
    name: `${definition.name}-metadata`,
    specType: "metadata",
  });

  const diagramWriter = context.createDataWriter!({
    name: `${definition.name}-diagram`,
    specType: "file",
    tags: { filename },
  });

  const metadataHandle = await metadataWriter.writeText(
    JSON.stringify(metadataAttributes),
  );
  const diagramHandle = await diagramWriter.writeAll(content);

  return { dataHandles: [metadataHandle, diagramHandle] };
}

/**
 * The mermaid workflow diagram model definition.
 *
 * A model that converts workflow execution data into Mermaid diagram format.
 * Creates visual representations of workflow structure, dependencies, and execution status.
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const mermaidWorkflowModel: ModelDefinition<
  typeof MermaidWorkflowInputAttributesSchema
> = defineModel({
  type: MERMAID_WORKFLOW_MODEL_TYPE,
  version: "2026.02.09.1",
  inputAttributesSchema: MermaidWorkflowInputAttributesSchema,
  dataOutputSpecs: {
    "metadata": {
      specType: DataSpecType.create("metadata"),
      description: "Workflow diagram metadata (job count, step count, status)",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
    "file": {
      specType: DataSpecType.create("file"),
      description: "Mermaid diagram file content",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "file" },
    },
  },
  methods: {
    generate: {
      description: "Generate a Mermaid diagram from workflow execution data",
      inputAttributesSchema: MermaidWorkflowInputAttributesSchema,
      execute: executeGenerate,
    },
  },
});
