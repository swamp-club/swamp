import { assertEquals } from "@std/assert";
import { ModelInput } from "../../model_input.ts";
import {
  MERMAID_WORKFLOW_MODEL_TYPE,
  mermaidWorkflowModel,
  type MermaidWorkflowInputAttributes,
} from "./workflow_diagram_model.ts";

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
              jobName: "build",
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

  const input = ModelInput.create({
    name: "test-diagram",
    attributes: inputAttributes,
  });

  const result = await mermaidWorkflowModel.methods.generate.execute(
    input,
    { repoDir: "/tmp" },
  );

  assertEquals(result.resource !== undefined, true);
  assertEquals(result.file !== undefined, true);

  // Verify resource attributes
  const resource = result.resource!;
  assertEquals(resource.attributes.workflowName, "test-workflow");
  assertEquals(resource.attributes.jobCount, 2);
  assertEquals(resource.attributes.stepCount, 2);
  assertEquals(resource.attributes.workflowStatus, "succeeded");

  // Verify file content contains Mermaid syntax
  const diagramContent = new TextDecoder().decode(result.file!.content);
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

  const input = ModelInput.create({
    name: "simple-diagram",
    attributes: inputAttributes,
  });

  const result = await mermaidWorkflowModel.methods.generate.execute(
    input,
    { repoDir: "/tmp" },
  );

  // Verify file content is simpler without steps
  const diagramContent = new TextDecoder().decode(result.file!.content);
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
            condition: { type: "succeeded", jobName: "setup" },
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
            condition: { type: "succeeded", jobName: "setup" },
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
            condition: { type: "succeeded", jobName: "build-frontend" },
          },
          {
            job: "build-backend",
            condition: { type: "succeeded", jobName: "build-backend" },
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

  const input = ModelInput.create({
    name: "complex-diagram",
    attributes: inputAttributes,
  });

  const result = await mermaidWorkflowModel.methods.generate.execute(
    input,
    { repoDir: "/tmp" },
  );

  const diagramContent = new TextDecoder().decode(result.file!.content);
  
  // Verify all jobs are present
  assertEquals(diagramContent.includes("Job: setup"), true);
  assertEquals(diagramContent.includes("Job: build-frontend"), true);
  assertEquals(diagramContent.includes("Job: build-backend"), true);
  assertEquals(diagramContent.includes("Job: integration-test"), true);
  
  // Verify dependency arrows are present
  assertEquals(diagramContent.includes("job_setup --> job_build_frontend"), true);
  assertEquals(diagramContent.includes("job_setup --> job_build_backend"), true);
  assertEquals(diagramContent.includes("job_build_frontend --> job_integration_test"), true);
  assertEquals(diagramContent.includes("job_build_backend --> job_integration_test"), true);
});

Deno.test("mermaidWorkflowModel: model type is correctly defined", () => {
  assertEquals(MERMAID_WORKFLOW_MODEL_TYPE.normalized, "mermaid/workflow-diagram");
  assertEquals(mermaidWorkflowModel.type, MERMAID_WORKFLOW_MODEL_TYPE);
  assertEquals(mermaidWorkflowModel.version, 1);
});