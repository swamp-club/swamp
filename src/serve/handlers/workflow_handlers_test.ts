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
import { resolveWorkflowFields } from "./workflow_handlers.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";

function makeWorkflowRepo(
  workflows: Map<string, Workflow>,
): WorkflowRepository {
  return {
    findByName: (name: string) => Promise.resolve(workflows.get(name) ?? null),
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  } as unknown as WorkflowRepository;
}

Deno.test("resolveWorkflowFields: returns tags when workflow has them", async () => {
  const wf = Workflow.create({
    name: "tagged-workflow",
    tags: { env: "staging", team: "ops" },
  });
  const repo = makeWorkflowRepo(new Map([["tagged-workflow", wf]]));

  const fields = await resolveWorkflowFields(repo, "tagged-workflow");

  assertEquals(fields.name, "tagged-workflow");
  assertEquals(fields.tags, { env: "staging", team: "ops" });
});

Deno.test("resolveWorkflowFields: omits tags when workflow has none", async () => {
  const wf = Workflow.create({ name: "plain-workflow" });
  const repo = makeWorkflowRepo(new Map([["plain-workflow", wf]]));

  const fields = await resolveWorkflowFields(repo, "plain-workflow");

  assertEquals(fields.name, "plain-workflow");
  assertEquals(fields.tags, undefined);
});

Deno.test("resolveWorkflowFields: falls back to name-only when workflow not found", async () => {
  const repo = makeWorkflowRepo(new Map());

  const fields = await resolveWorkflowFields(repo, "missing-workflow");

  assertEquals(fields.name, "missing-workflow");
  assertEquals(fields.tags, undefined);
});

Deno.test("resolveWorkflowFields: falls back to findById when findByName returns null", async () => {
  const wf = Workflow.create({
    id: "abc-123",
    name: "id-workflow",
    tags: { env: "prod" },
  });
  const repo = {
    findByName: () => Promise.resolve(null),
    findById: (id: unknown) =>
      Promise.resolve(String(id) === "abc-123" ? wf : null),
    findAll: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  } as unknown as WorkflowRepository;

  const fields = await resolveWorkflowFields(repo, "abc-123");

  assertEquals(fields.name, "id-workflow");
  assertEquals(fields.tags, { env: "prod" });
});

Deno.test("resolveWorkflowFields: falls back to name-only when repo throws", async () => {
  const repo = {
    findByName: () => Promise.reject(new Error("PermissionDenied")),
    findById: () => Promise.reject(new Error("PermissionDenied")),
    findAll: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  } as unknown as WorkflowRepository;

  const fields = await resolveWorkflowFields(repo, "erroring-workflow");

  assertEquals(fields.name, "erroring-workflow");
  assertEquals(fields.tags, undefined);
});
