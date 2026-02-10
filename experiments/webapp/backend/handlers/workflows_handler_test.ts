import { assertEquals } from "@std/assert";
import { createWorkflowsHandlers } from "./workflows_handler.ts";
import type { WorkflowRepository } from "../../../../src/domain/workflows/repositories.ts";
import type { Workflow } from "../../../../src/domain/workflows/workflow.ts";
import type { WorkflowId } from "../../../../src/domain/workflows/workflow_id.ts";

// Mock repository for testing
function createMockRepository(
  workflows: Workflow[] = [],
): WorkflowRepository {
  const storage = new Map<string, Workflow>();

  for (const workflow of workflows) {
    storage.set(workflow.id, workflow);
  }

  return {
    findById(id: WorkflowId): Promise<Workflow | null> {
      return Promise.resolve(storage.get(id) ?? null);
    },

    findAll(): Promise<Workflow[]> {
      return Promise.resolve(Array.from(storage.values()));
    },

    findByName(name: string): Promise<Workflow | null> {
      const result =
        Array.from(storage.values()).find((w) => w.name === name) ??
          null;
      return Promise.resolve(result);
    },

    save(workflow: Workflow): Promise<void> {
      storage.set(workflow.id, workflow);
      return Promise.resolve();
    },

    delete(id: WorkflowId): Promise<void> {
      storage.delete(id);
      return Promise.resolve();
    },

    nextId(): WorkflowId {
      return crypto.randomUUID() as WorkflowId;
    },

    getPath(id: WorkflowId): string {
      return `/test/workflows/${id}.yaml`;
    },
  };
}

Deno.test("listWorkflows returns empty array when no workflows", async () => {
  const repo = createMockRepository();
  const handlers = createWorkflowsHandlers(repo);

  const request = new Request("http://localhost/api/v1/workflows");
  const response = await handlers.listWorkflows({ request, params: {} });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.workflows, []);
});

Deno.test("getWorkflow returns 404 when workflow not found", async () => {
  const repo = createMockRepository();
  const handlers = createWorkflowsHandlers(repo);

  const request = new Request("http://localhost/api/v1/workflows/nonexistent");
  const response = await handlers.getWorkflow({
    request,
    params: { id: "nonexistent" },
  });

  assertEquals(response.status, 404);
});

Deno.test("createWorkflow creates new workflow", async () => {
  const repo = createMockRepository();
  const handlers = createWorkflowsHandlers(repo);

  const request = new Request("http://localhost/api/v1/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "test-workflow",
      description: "A test workflow",
      jobs: [
        {
          name: "test-job",
          steps: [
            {
              name: "test-step",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "apply",
              },
            },
          ],
        },
      ],
    }),
  });

  const response = await handlers.createWorkflow({ request, params: {} });

  assertEquals(response.status, 201);
  const body = await response.json();
  assertEquals(body.name, "test-workflow");
  assertEquals(body.jobs.length, 1);
});

Deno.test("createWorkflow returns 409 for duplicate name", async () => {
  const repo = createMockRepository();
  const handlers = createWorkflowsHandlers(repo);

  // Create first workflow
  const firstRequest = new Request("http://localhost/api/v1/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "duplicate-workflow",
      jobs: [],
    }),
  });
  await handlers.createWorkflow({ request: firstRequest, params: {} });

  // Try to create another with same name
  const secondRequest = new Request("http://localhost/api/v1/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "duplicate-workflow",
      jobs: [],
    }),
  });
  const response = await handlers.createWorkflow({
    request: secondRequest,
    params: {},
  });

  assertEquals(response.status, 409);
});

Deno.test("deleteWorkflow returns 404 for nonexistent workflow", async () => {
  const repo = createMockRepository();
  const handlers = createWorkflowsHandlers(repo);

  const request = new Request(
    "http://localhost/api/v1/workflows/nonexistent",
    { method: "DELETE" },
  );
  const response = await handlers.deleteWorkflow({
    request,
    params: { id: "nonexistent" },
  });

  assertEquals(response.status, 404);
});

Deno.test("updateWorkflow returns 404 for nonexistent workflow", async () => {
  const repo = createMockRepository();
  const handlers = createWorkflowsHandlers(repo);

  const request = new Request(
    "http://localhost/api/v1/workflows/nonexistent",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "updated-name" }),
    },
  );
  const response = await handlers.updateWorkflow({
    request,
    params: { id: "nonexistent" },
  });

  assertEquals(response.status, 404);
});
