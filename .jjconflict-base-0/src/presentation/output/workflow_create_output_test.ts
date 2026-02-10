import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderWorkflowCreate,
  type WorkflowCreateData,
} from "./workflow_create_output.ts";

await initializeLogging({});

const testData: WorkflowCreateData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "my-workflow",
  path: "workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
};

const testDataWithJobs: WorkflowCreateData = {
  ...testData,
  jobs: [
    {
      name: "main",
      description: "Main job",
      steps: [
        {
          name: "example",
          description: "Example step",
          taskType: "shell",
        },
      ],
    },
  ],
};

Deno.test("renderWorkflowCreate with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowCreate(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, testData.id);
    assertEquals(parsed.name, testData.name);
    assertEquals(parsed.path, testData.path);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderWorkflowCreate with log mode does not throw", () => {
  renderWorkflowCreate(testData, "log");
});

Deno.test("renderWorkflowCreate with log mode shows jobs when provided", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowCreate(testDataWithJobs, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "Jobs:");
    assertStringIncludes(combined, "main");
    assertStringIncludes(combined, "Steps:");
    assertStringIncludes(combined, "example");
    assertStringIncludes(combined, "(shell)");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderWorkflowCreate json mode includes jobs", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowCreate(testDataWithJobs, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.jobs.length, 1);
    assertEquals(parsed.jobs[0].name, "main");
    assertEquals(parsed.jobs[0].steps[0].name, "example");
  } finally {
    console.log = originalLog;
  }
});
