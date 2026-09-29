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

/**
 * The invariant swamp-club#2674 rests on: whatever string a client sends,
 * the resource serve authorizes is the resource the operation then acts on.
 * Names may collide with other resources' ids, and the request may be any
 * name, any id, or neither.
 */

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  resolveWorkflowTarget,
  targetArgument,
} from "./resource_resolution.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../../domain/workflows/workflow_lookup.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";

const IDS = Array.from({ length: 6 }, () => crypto.randomUUID());

/**
 * A workflow set whose names are drawn from plain names and the other
 * workflows' ids, so collisions are common. Ids may repeat too, as a copied
 * workflow file keeps its id.
 */
const workflowSet = fc.uniqueArray(
  fc.record({
    id: fc.constantFrom(...IDS),
    name: fc.oneof(
      fc.constantFrom("alpha", "beta", "prod-db"),
      fc.constantFrom(...IDS),
    ),
  }),
  { selector: (w) => w.name, maxLength: 6 },
).map((entries) =>
  entries.map((e) => Workflow.create({ id: e.id, name: e.name }))
);

function repoOf(workflows: Workflow[]): WorkflowRepository {
  return {
    findByName: (name: string) =>
      Promise.resolve(workflows.find((w) => w.name === name) ?? null),
    findById: (id: string) =>
      Promise.resolve(workflows.find((w) => w.id === id) ?? null),
  } as unknown as WorkflowRepository;
}

Deno.test("resolveWorkflowTarget property: the workflow authorized is the workflow acted on", async () => {
  await fc.assert(
    fc.asyncProperty(
      workflowSet,
      fc.oneof(
        fc.constantFrom(...IDS),
        fc.constantFrom("alpha", "beta", "prod-db", "missing"),
      ),
      async (workflows, requested) => {
        const repo = repoOf(workflows);
        const resolution = await resolveWorkflowTarget(repo, requested);
        if (resolution.status === "failed") throw resolution.error;
        const { idOrName, byId, expectedName } = targetArgument(
          resolution,
          requested,
        );
        // What an operation handed that argument looks up.
        const actedOn = byId
          ? await findWorkflowById(repo, idOrName, expectedName)
          : await findWorkflowByIdOrName(repo, idOrName);

        if (resolution.status === "found") {
          assertEquals(actedOn?.name, resolution.resource.name);
          assertEquals(actedOn?.id, resolution.id);
        } else {
          // Authorized as the raw string: nothing may be acted on.
          assertEquals(actedOn, null);
        }
      },
    ),
  );
});
