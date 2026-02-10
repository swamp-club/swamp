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
import { normalizeSpecType } from "../../model.ts";
import type {
  DataHandle,
  DataWriter,
  DataWriterFactory,
  MethodContext,
  SpecBasedWriterOptions,
} from "../../model.ts";
import type { UnifiedDataRepository } from "../../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../../definitions/repositories.ts";
import { type DataId, generateDataId } from "../../../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

/**
 * Stored result from mock data writer.
 */
interface MockWriterResult {
  handle: DataHandle;
  content: Uint8Array;
}

/**
 * Creates a mock DataWriterFactory that stores written content in memory.
 */
function createMockDataWriterFactory(): {
  factory: DataWriterFactory;
  getResults: () => MockWriterResult[];
} {
  const results: MockWriterResult[] = [];
  const getResults = (): MockWriterResult[] => results;
  let nextId = 1;

  const factory: DataWriterFactory = (
    options: SpecBasedWriterOptions,
  ): DataWriter => {
    const dataId = `mock-data-${nextId++}` as DataId;

    const buildHandle = (content: Uint8Array): DataHandle => ({
      name: options.name,
      specType: normalizeSpecType(options.specType),
      dataId,
      version: 1,
      size: content.length,
      tags: { ...(options.tags ?? {}) },
      metadata: {
        contentType: options.contentType ?? "application/json",
        lifetime: options.lifetime ?? "infinite",
        garbageCollection: options.garbageCollection ?? 10,
        streaming: options.streaming ?? false,
        tags: { ...(options.tags ?? {}) },
        ownerDefinition: {
          definitionHash: "test-hash",
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    });

    return {
      dataId,
      name: options.name,
      writeAll(content: Uint8Array): Promise<DataHandle> {
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeText(text: string): Promise<DataHandle> {
        const content = new TextEncoder().encode(text);
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeLine(_line: string): Promise<void> {
        return Promise.resolve();
      },
      writeStream(
        _stream: ReadableStream<Uint8Array>,
      ): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      getFilePath(): Promise<string> {
        return Promise.resolve("/tmp/mock");
      },
      finalize(): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
    } as DataWriter;
  };

  return { factory, getResults };
}

/**
 * Helper to get parsed JSON content from mock results by name.
 */
function getResultAttributes(
  results: MockWriterResult[],
  namePart: string,
): Record<string, unknown> | undefined {
  const result = results.find((r) => r.handle.name.includes(namePart));
  if (!result) return undefined;
  return JSON.parse(new TextDecoder().decode(result.content));
}

/**
 * Helper to get diagram content as string.
 */
function getDiagramContent(results: MockWriterResult[]): string {
  const diagramResult = results.find((r) => r.handle.name.endsWith("-diagram"));
  if (!diagramResult) return "";
  return new TextDecoder().decode(diagramResult.content);
}

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
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
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
function createTestContext(): {
  context: MethodContext;
  getResults: () => MockWriterResult[];
} {
  const { factory, getResults } = createMockDataWriterFactory();
  const context: MethodContext = {
    repoDir: "/tmp",
    modelType: MERMAID_WORKFLOW_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    createDataWriter: factory,
  };
  return { context, getResults };
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
              type: "model_method" as const,
              modelIdOrName: "test-model",
              methodName: "run",
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

  const { context, getResults } = createTestContext();
  const result = await mermaidWorkflowModel.methods.generate.execute(
    definition,
    context,
  );

  assertEquals(result.dataHandles !== undefined, true);
  assertEquals(result.dataHandles!.length >= 1, true);

  // Verify metadata attributes
  const attrs = getResultAttributes(getResults(), "metadata");
  assertEquals(attrs?.workflowName, "test-workflow");
  assertEquals(attrs?.jobCount, 2);
  assertEquals(attrs?.stepCount, 2);
  assertEquals(attrs?.workflowStatus, "succeeded");

  // Verify diagram content contains Mermaid syntax
  const diagramContent = getDiagramContent(getResults());
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
              type: "model_method" as const,
              modelIdOrName: "test-model",
              methodName: "run",
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

  const { context, getResults } = createTestContext();
  await mermaidWorkflowModel.methods.generate.execute(
    definition,
    context,
  );

  // Verify diagram content is simpler without steps
  const diagramContent = getDiagramContent(getResults());
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
            task: {
              type: "model_method" as const,
              modelIdOrName: "test-model",
              methodName: "run",
            },
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
            task: {
              type: "model_method" as const,
              modelIdOrName: "test-model",
              methodName: "run",
            },
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
            task: {
              type: "model_method" as const,
              modelIdOrName: "test-model",
              methodName: "run",
            },
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
            task: {
              type: "model_method" as const,
              modelIdOrName: "test-model",
              methodName: "run",
            },
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

  const { context, getResults } = createTestContext();
  await mermaidWorkflowModel.methods.generate.execute(
    definition,
    context,
  );

  const diagramContent = getDiagramContent(getResults());

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
  assertEquals(mermaidWorkflowModel.version, "2026.02.09.1");
});
