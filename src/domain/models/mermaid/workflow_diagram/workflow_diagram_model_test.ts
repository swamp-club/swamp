import { assertEquals } from "@std/assert";
import {
  createDefinitionId,
  Definition,
} from "../../../definitions/definition.ts";
import {
  MERMAID_WORKFLOW_MODEL_TYPE,
  type MermaidWorkflowInputAttributes,
  mermaidWorkflowModel,
} from "./workflow_diagram_model.ts";
import type { MethodContext } from "../../model.ts";
import type { UnifiedDataRepository } from "../../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../../definitions/repositories.ts";
import { generateDataId } from "../../../data/data_id.ts";

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
function createMockDataRepo(): UnifiedDataRepository {
  return {
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestSymlink: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
  };
}

/**
 * Creates a mock DefinitionRepository for testing.
 */
function createMockDefinitionRepo(): DefinitionRepository {
  return {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findByNameGlobal: () => Promise.resolve(null),
    findAllGlobal: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => createDefinitionId(crypto.randomUUID()),
    getPath: () => "",
  };
}

/**
 * Creates a test MethodContext with mocked repositories.
 */
function createTestContext(): MethodContext {
  return {
    repoDir: "/tmp",
    modelType: MERMAID_WORKFLOW_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
  };
}

/**
 * Helper to get attributes from a DataOutput by name.
 */
function getDataOutputAttributes(
  dataOutputs: { name: string; content: Uint8Array }[] | undefined,
  name: string,
): Record<string, unknown> | undefined {
  const dataOutput = dataOutputs?.find((d) => d.name.includes(name));
  if (!dataOutput) return undefined;
  const content = new TextDecoder().decode(dataOutput.content);
  return JSON.parse(content);
}

/**
 * Helper to get diagram content as string.
 */
function getDiagramContent(
  dataOutputs: { name: string; content: Uint8Array }[] | undefined,
): string {
  const diagramOutput = dataOutputs?.find((d) => d.name.endsWith("-diagram"));
  if (!diagramOutput) return "";
  return new TextDecoder().decode(diagramOutput.content);
}

Deno.test("mermaidWorkflowModel: generate creates Mermaid diagram for simple workflow", async () => {
  const workflowExecution = {
    workflowName: "test-workflow",
    status: "succeeded" as const,
    jobs: [
      {
        name: "build",
        status: "succeeded" as const,
        steps: [
          {
            name: "compile",
            status: "succeeded" as const,
            task: {
              type: "shell" as const,
              command: "make build",
            },
          },
        ],
      },
      {
        name: "test",
        status: "succeeded" as const,
        dependsOn: [
          {
            job: "build",
            condition: {
              type: "succeeded",
            },
          },
        ],
        steps: [
          {
            name: "unit-tests",
            status: "succeeded" as const,
            task: {
              type: "model_method" as const,
              modelIdOrName: "test-runner",
              methodName: "run",
            },
          },
        ],
      },
    ],
  };

  const inputAttributes: MermaidWorkflowInputAttributes = {
    workflowExecution,
    title: "Test Workflow Diagram",
    includeSteps: true,
    colorScheme: {
      succeeded: "#90EE90",
      failed: "#FFB6C1",
      cancelled: "#D3D3D3",
      skipped: "#FFFFE0",
    },
  };

  const definition = Definition.create({
    name: "test-diagram",
    attributes: inputAttributes,
  });

  const context = createTestContext();
  const result = await mermaidWorkflowModel.methods.generate.execute(
    definition,
    context,
  );

  assertEquals(result.dataOutputs !== undefined, true);
  assertEquals(result.dataOutputs!.length >= 1, true);

  // Verify metadata attributes
  const attrs = getDataOutputAttributes(result.dataOutputs, "metadata");
  assertEquals(attrs?.workflowName, "test-workflow");
  assertEquals(attrs?.jobCount, 2);
  assertEquals(attrs?.stepCount, 2);
  assertEquals(attrs?.workflowStatus, "succeeded");

  // Verify diagram content contains Mermaid syntax
  const diagramContent = getDiagramContent(result.dataOutputs);
  assertEquals(diagramContent.includes("graph TD"), true);
  assertEquals(diagramContent.includes("Workflow: test-workflow"), true);
  assertEquals(diagramContent.includes("Job: build"), true);
  assertEquals(diagramContent.includes("Job: test"), true);
  assertEquals(diagramContent.includes("compile"), true);
  assertEquals(diagramContent.includes("unit-tests"), true);
});

Deno.test("mermaidWorkflowModel: generate creates simple diagram without steps", async () => {
  const workflowExecution = {
    workflowName: "simple-workflow",
    status: "failed" as const,
    jobs: [
      {
        name: "deploy",
        status: "failed" as const,
        steps: [
          {
            name: "deploy-step",
            status: "failed" as const,
            task: {
              type: "shell" as const,
              command: "deploy.sh",
            },
          },
        ],
      },
    ],
  };

  const inputAttributes: MermaidWorkflowInputAttributes = {
    workflowExecution,
    includeSteps: false, // Don't include step details
    colorScheme: {
      succeeded: "#90EE90",
      failed: "#FFB6C1",
      cancelled: "#D3D3D3",
      skipped: "#FFFFE0",
    },
  };

  const definition = Definition.create({
    name: "simple-diagram",
    attributes: inputAttributes,
  });

  const context = createTestContext();
  const result = await mermaidWorkflowModel.methods.generate.execute(
    definition,
    context,
  );

  // Verify diagram content is simpler without steps
  const diagramContent = getDiagramContent(result.dataOutputs);
  assertEquals(diagramContent.includes("graph TD"), true);
  assertEquals(diagramContent.includes("Job: deploy"), true);
  assertEquals(diagramContent.includes("Status: failed"), true);
  // Should not include step details
  assertEquals(diagramContent.includes("deploy-step"), false);
  assertEquals(diagramContent.includes("subgraph"), false);
});

Deno.test("mermaidWorkflowModel: generate handles complex workflow with multiple dependencies", async () => {
  const workflowExecution = {
    workflowName: "complex-workflow",
    status: "succeeded" as const,
    jobs: [
      {
        name: "setup",
        status: "succeeded" as const,
        steps: [
          {
            name: "init",
            status: "succeeded" as const,
            task: { type: "shell" as const, command: "setup.sh" },
          },
        ],
      },
      {
        name: "build-frontend",
        status: "succeeded" as const,
        dependsOn: [
          {
            job: "setup",
            condition: { type: "succeeded" },
          },
        ],
        steps: [
          {
            name: "build-ui",
            status: "succeeded" as const,
            task: { type: "shell" as const, command: "npm run build" },
          },
        ],
      },
      {
        name: "build-backend",
        status: "succeeded" as const,
        dependsOn: [
          {
            job: "setup",
            condition: { type: "succeeded" },
          },
        ],
        steps: [
          {
            name: "build-api",
            status: "succeeded" as const,
            task: { type: "shell" as const, command: "go build" },
          },
        ],
      },
      {
        name: "integration-test",
        status: "succeeded" as const,
        dependsOn: [
          {
            job: "build-frontend",
            condition: { type: "succeeded" },
          },
          {
            job: "build-backend",
            condition: { type: "succeeded" },
          },
        ],
        steps: [
          {
            name: "test-integration",
            status: "succeeded" as const,
            task: { type: "shell" as const, command: "run-tests.sh" },
          },
        ],
      },
    ],
  };

  const inputAttributes: MermaidWorkflowInputAttributes = {
    workflowExecution,
    includeSteps: false,
    colorScheme: {
      succeeded: "#90EE90",
      failed: "#FFB6C1",
      cancelled: "#D3D3D3",
      skipped: "#FFFFE0",
    },
  };

  const definition = Definition.create({
    name: "complex-diagram",
    attributes: inputAttributes,
  });

  const context = createTestContext();
  const result = await mermaidWorkflowModel.methods.generate.execute(
    definition,
    context,
  );

  const diagramContent = getDiagramContent(result.dataOutputs);

  // Verify all jobs are present
  assertEquals(diagramContent.includes("Job: setup"), true);
  assertEquals(diagramContent.includes("Job: build-frontend"), true);
  assertEquals(diagramContent.includes("Job: build-backend"), true);
  assertEquals(diagramContent.includes("Job: integration-test"), true);

  // Verify dependency arrows are present
  assertEquals(
    diagramContent.includes("job_setup --> job_build_frontend"),
    true,
  );
  assertEquals(
    diagramContent.includes("job_setup --> job_build_backend"),
    true,
  );
  assertEquals(
    diagramContent.includes("job_build_frontend --> job_integration_test"),
    true,
  );
  assertEquals(
    diagramContent.includes("job_build_backend --> job_integration_test"),
    true,
  );
});

Deno.test("mermaidWorkflowModel: model type is correctly defined", () => {
  assertEquals(
    MERMAID_WORKFLOW_MODEL_TYPE.normalized,
    "mermaid/workflow-diagram",
  );
  assertEquals(mermaidWorkflowModel.type, MERMAID_WORKFLOW_MODEL_TYPE);
  assertEquals(mermaidWorkflowModel.version, 1);
});
