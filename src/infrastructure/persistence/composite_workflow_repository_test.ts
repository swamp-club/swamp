// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { assertEquals } from "@std/assert";
import { CompositeWorkflowRepository } from "./composite_workflow_repository.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";

/**
 * In-memory WorkflowRepository for testing.
 */
class InMemoryWorkflowRepository implements WorkflowRepository {
  private workflows: Map<string, Workflow> = new Map();

  constructor(workflows: Workflow[] = []) {
    for (const w of workflows) {
      this.workflows.set(w.id, w);
    }
  }

  findById(id: WorkflowId): Promise<Workflow | null> {
    return Promise.resolve(this.workflows.get(id) ?? null);
  }

  findByName(name: string): Promise<Workflow | null> {
    for (const w of this.workflows.values()) {
      if (w.name === name) return Promise.resolve(w);
    }
    return Promise.resolve(null);
  }

  findAll(): Promise<Workflow[]> {
    return Promise.resolve([...this.workflows.values()]);
  }

  save(workflow: Workflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
    return Promise.resolve();
  }

  delete(id: WorkflowId): Promise<void> {
    this.workflows.delete(id);
    return Promise.resolve();
  }

  nextId(): WorkflowId {
    return createWorkflowId(crypto.randomUUID());
  }

  getPath(id: WorkflowId): string {
    return `workflows/workflow-${id}.yaml`;
  }
}

function createTestWorkflow(name: string, id?: string): Workflow {
  return Workflow.create({
    id: id ?? crypto.randomUUID(),
    name,
  });
}

Deno.test("CompositeWorkflowRepository findByName checks primary first", async () => {
  const primaryWorkflow = createTestWorkflow("shared-name");
  const extensionWorkflow = createTestWorkflow("shared-name");

  const primary = new InMemoryWorkflowRepository([primaryWorkflow]);
  const extension = new InMemoryWorkflowRepository([extensionWorkflow]);
  const composite = new CompositeWorkflowRepository(primary, extension);

  const result = await composite.findByName("shared-name");
  assertEquals(result?.id, primaryWorkflow.id);
});

Deno.test("CompositeWorkflowRepository findByName falls back to extension", async () => {
  const extensionWorkflow = createTestWorkflow("ext-only");

  const primary = new InMemoryWorkflowRepository([]);
  const extension = new InMemoryWorkflowRepository([extensionWorkflow]);
  const composite = new CompositeWorkflowRepository(primary, extension);

  const result = await composite.findByName("ext-only");
  assertEquals(result?.id, extensionWorkflow.id);
});

Deno.test("CompositeWorkflowRepository findByName returns null when not found in either", async () => {
  const primary = new InMemoryWorkflowRepository([]);
  const extension = new InMemoryWorkflowRepository([]);
  const composite = new CompositeWorkflowRepository(primary, extension);

  const result = await composite.findByName("nonexistent");
  assertEquals(result, null);
});

Deno.test("CompositeWorkflowRepository findById checks primary first", async () => {
  const id = createWorkflowId(crypto.randomUUID());
  const primaryWorkflow = createTestWorkflow("primary-wf", id);

  const primary = new InMemoryWorkflowRepository([primaryWorkflow]);
  const extension = new InMemoryWorkflowRepository([]);
  const composite = new CompositeWorkflowRepository(primary, extension);

  const result = await composite.findById(id);
  assertEquals(result?.name, "primary-wf");
});

Deno.test("CompositeWorkflowRepository findById falls back to extension", async () => {
  const id = createWorkflowId(crypto.randomUUID());
  const extensionWorkflow = createTestWorkflow("ext-wf", id);

  const primary = new InMemoryWorkflowRepository([]);
  const extension = new InMemoryWorkflowRepository([extensionWorkflow]);
  const composite = new CompositeWorkflowRepository(primary, extension);

  const result = await composite.findById(id);
  assertEquals(result?.name, "ext-wf");
});

Deno.test("CompositeWorkflowRepository findAll deduplicates by name, primary wins", async () => {
  const primaryWorkflow = createTestWorkflow("shared-name");
  const extWorkflow1 = createTestWorkflow("shared-name");
  const extWorkflow2 = createTestWorkflow("ext-unique");

  const primary = new InMemoryWorkflowRepository([primaryWorkflow]);
  const extension = new InMemoryWorkflowRepository([
    extWorkflow1,
    extWorkflow2,
  ]);
  const composite = new CompositeWorkflowRepository(primary, extension);

  const results = await composite.findAll();
  assertEquals(results.length, 2);

  const names = results.map((w) => w.name);
  assertEquals(names.includes("shared-name"), true);
  assertEquals(names.includes("ext-unique"), true);

  // The "shared-name" should be the primary one
  const sharedWorkflow = results.find((w) => w.name === "shared-name");
  assertEquals(sharedWorkflow?.id, primaryWorkflow.id);
});

Deno.test("CompositeWorkflowRepository save delegates to primary", async () => {
  const primary = new InMemoryWorkflowRepository([]);
  const extension = new InMemoryWorkflowRepository([]);
  const composite = new CompositeWorkflowRepository(primary, extension);

  const workflow = createTestWorkflow("new-workflow");
  await composite.save(workflow);

  // Should be findable in primary
  const found = await primary.findByName("new-workflow");
  assertEquals(found?.id, workflow.id);
});

Deno.test("CompositeWorkflowRepository delete delegates to primary", async () => {
  const workflow = createTestWorkflow("to-delete");
  const primary = new InMemoryWorkflowRepository([workflow]);
  const extension = new InMemoryWorkflowRepository([]);
  const composite = new CompositeWorkflowRepository(primary, extension);

  await composite.delete(workflow.id);

  const found = await primary.findById(workflow.id);
  assertEquals(found, null);
});

Deno.test("CompositeWorkflowRepository works with null extension (backwards compat)", async () => {
  const workflow = createTestWorkflow("primary-only");
  const primary = new InMemoryWorkflowRepository([workflow]);
  const composite = new CompositeWorkflowRepository(primary, null);

  const all = await composite.findAll();
  assertEquals(all.length, 1);

  const byName = await composite.findByName("primary-only");
  assertEquals(byName?.id, workflow.id);

  const notFound = await composite.findByName("nonexistent");
  assertEquals(notFound, null);

  const byId = await composite.findById(workflow.id);
  assertEquals(byId?.id, workflow.id);

  const notFoundId = await composite.findById(
    createWorkflowId(crypto.randomUUID()),
  );
  assertEquals(notFoundId, null);
});

Deno.test("CompositeWorkflowRepository nextId delegates to primary", () => {
  const primary = new InMemoryWorkflowRepository([]);
  const composite = new CompositeWorkflowRepository(primary, null);

  const id = composite.nextId();
  // Should be a valid UUID-like string
  assertEquals(typeof id, "string");
  assertEquals(id.length > 0, true);
});

Deno.test("CompositeWorkflowRepository getPath delegates to primary", () => {
  const primary = new InMemoryWorkflowRepository([]);
  const composite = new CompositeWorkflowRepository(primary, null);

  const id = createWorkflowId("test-id");
  const path = composite.getPath(id);
  assertEquals(path, "workflows/workflow-test-id.yaml");
});
