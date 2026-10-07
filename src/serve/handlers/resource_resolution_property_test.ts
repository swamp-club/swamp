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
  authorizeReferenceAccess,
  resolveOutputAccess,
  resolveWorkflowTarget,
  targetArgument,
} from "./resource_resolution.ts";
import { type ConnectionContext, setConnectionCollectives } from "./shared.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../../domain/workflows/workflow_lookup.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  modelOutputGet,
  type ModelOutputGetData,
  type ModelOutputGetDeps,
  type OutputInfo,
} from "../../libswamp/models/output_get.ts";
import { resolveOutputReference } from "../../libswamp/models/output_reference.ts";

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

// swamp-club#2673: an output read names an output id prefix, a model name or
// a model id. Model names may look like output id prefixes, and model ids
// may repeat (a copied definition keeps its id, and shares its outputs).

const MODEL_TYPE = ModelType.create("test/output-property");
const MODEL_IDS = Array.from({ length: 3 }, () => crypto.randomUUID());
// Output ids share leading characters, so short prefixes are ambiguous.
const OUTPUT_IDS = [
  "abc00000-0000-4000-8000-000000000001",
  "abc11111-0000-4000-8000-000000000001",
  "abd00000-0000-4000-8000-000000000001",
  crypto.randomUUID(),
];
const PREFIXES = ["abc", "abc0", "abc1", "abd", OUTPUT_IDS[3].slice(0, 8)];

const definitionSet = fc.uniqueArray(
  fc.record({
    id: fc.constantFrom(...MODEL_IDS),
    name: fc.oneof(
      fc.constantFrom("alpha", "prod-db"),
      fc.constantFrom(...PREFIXES),
    ),
  }),
  { selector: (d) => d.name, maxLength: 4 },
).map((entries) =>
  entries.map((e) => Definition.create({ id: e.id, name: e.name, version: 1 }))
);

const outputSet = fc.uniqueArray(
  fc.record({
    id: fc.constantFrom(...OUTPUT_IDS),
    definitionId: fc.constantFrom(...MODEL_IDS),
  }),
  { selector: (o) => o.id, maxLength: 4 },
);

function outputInfo(
  output: { id: string; definitionId: string },
  index: number,
): OutputInfo {
  return {
    ...output,
    methodName: "noop",
    status: "succeeded",
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    retryCount: 0,
    provenance: {
      definitionHash: "hash",
      modelVersion: "1",
      triggeredBy: "manual",
    },
  };
}

function definitionRepoOf(definitions: Definition[]): DefinitionRepository {
  const all = () =>
    definitions.map((definition) => ({ definition, type: MODEL_TYPE }));
  return {
    findAllGlobal: () => Promise.resolve(all()),
    findAllByIdGlobal: (id: string) =>
      Promise.resolve(all().filter((entry) => entry.definition.id === id)),
  } as unknown as DefinitionRepository;
}

function outputDepsOf(
  definitions: Definition[],
  outputs: OutputInfo[],
): ModelOutputGetDeps {
  return {
    isPartialId,
    matchOutputByPartialId: (prefix) => {
      const result = matchByPartialId(
        outputs.map((output) => ({
          id: output.id,
          item: { output, type: MODEL_TYPE },
        })),
        prefix,
      );
      if (result.status === "found") {
        return Promise.resolve({ status: "found", match: result.match });
      }
      if (result.status === "ambiguous") {
        return Promise.resolve({
          status: "ambiguous",
          matches: result.matches.map((m) => ({ id: m.id, match: m.match })),
        });
      }
      return Promise.resolve({ status: "not_found" });
    },
    findDefinitionByIdOrName: (idOrName) => {
      const found = definitions.find((d) => d.name === idOrName) ??
        definitions.find((d) => d.id === idOrName);
      return Promise.resolve(
        found ? { definition: found, type: MODEL_TYPE } : null,
      );
    },
    findLatestOutput: (_type, definitionId) =>
      Promise.resolve(
        outputs.filter((o) => o.definitionId === definitionId).at(-1) ?? null,
      ),
    findOutputsByDefinition: (_type, definitionId) =>
      Promise.resolve(outputs.filter((o) => o.definitionId === definitionId)),
    findDefinitionById: (_type, definitionId) =>
      Promise.resolve(definitions.find((d) => d.id === definitionId) ?? null),
    modelTypes: () => [MODEL_TYPE],
  };
}

Deno.test("resolveOutputAccess property: every model owning the output read is authorized", async () => {
  await fc.assert(
    fc.asyncProperty(
      definitionSet,
      outputSet,
      fc.oneof(
        fc.constantFrom(...PREFIXES),
        fc.constantFrom(...OUTPUT_IDS),
        fc.constantFrom(...MODEL_IDS),
        fc.constantFrom("alpha", "prod-db", "missing", "fedcba"),
      ),
      async (definitions, rawOutputs, requested) => {
        const outputs = rawOutputs.map(outputInfo);
        const deps = outputDepsOf(definitions, outputs);
        const access = await resolveOutputAccess(
          definitionRepoOf(definitions),
          async () => ({
            reference: await resolveOutputReference(deps, requested),
          }),
          requested,
          ["model"],
        );
        if (access.status === "failed") throw access.error;
        const resources = access.status === "ambiguous"
          ? access.candidates.flat()
          : access.resources;
        const authorized = resources.map((r) => r.name);

        let read: ModelOutputGetData | undefined;
        for await (
          const event of modelOutputGet(
            createLibSwampContext(),
            deps,
            requested,
            { reference: access.resolved.reference },
          )
        ) {
          if (event.kind === "completed") read = event.data;
        }
        if (!read) {
          // Nothing read: only the raw string or a resolved model needed
          // authorizing, and one of them was.
          assertEquals(authorized.length > 0, true);
          return;
        }
        const owners = definitions.filter((d) => d.id === read!.definitionId);
        const expected = owners.length > 0
          ? owners.map((d) => d.name)
          : [read.definitionId];
        for (const name of expected) {
          assertEquals(authorized.includes(name), true, name);
        }
      },
    ),
  );
});

Deno.test("authorizeReferenceAccess property: an ambiguous prefix lists exactly the readable matches, in order (swamp-club#2743)", () => {
  const NAMES = ["alpha", "beta", "gamma", "delta"];
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...NAMES), { minLength: 2, maxLength: 8 }),
      fc.subarray(NAMES),
      (matches, denied) => {
        const snapshot = new PolicySnapshot([
          {
            id: crypto.randomUUID(),
            subject: { kind: "user", name: "adam" },
            effect: "allow",
            actions: ["read"],
            resource: { kind: "model", pattern: "*" },
            state: "active",
            source: "method",
            createdBy: { kind: "user", id: "admin" },
            createdAt: "2026-01-01T00:00:00Z",
          },
          ...denied.map((name) => ({
            id: crypto.randomUUID(),
            subject: { kind: "user" as const, name: "adam" },
            effect: "deny" as const,
            actions: ["read" as const],
            resource: { kind: "model" as const, pattern: name },
            state: "active" as const,
            source: "method" as const,
            createdBy: { kind: "user" as const, id: "admin" },
            createdAt: "2026-01-01T00:00:00Z",
          })),
        ], []);
        const ctx = {
          policySnapshotLoader: {
            decisionService: new GrantBasedAccessDecisionService(snapshot),
          } as unknown as PolicySnapshotLoader,
          authConfig: { mode: "token", admins: [] },
          auditEmitter: { emit: () => {} },
          instanceId: "test-instance",
        } as unknown as ConnectionContext;
        const sent: unknown[] = [];
        const socket = {
          readyState: WebSocket.OPEN,
          send: (data: string) => sent.push(JSON.parse(data)),
        } as unknown as WebSocket;
        setConnectionCollectives(socket, [], []);

        const indexes = matches.map((_, i) => i);
        const result = authorizeReferenceAccess(
          socket,
          "req-1",
          { kind: "user", id: "adam" },
          "read",
          {
            status: "ambiguous",
            resolved: indexes,
            candidates: matches.map((name) => [
              { kind: "model", name, fields: { name } },
            ]),
            narrow: (readable) => readable,
          },
          "abc",
          ["model"],
          ctx,
          "model_output_get_failed",
        );

        const readable = indexes.filter((i) => !denied.includes(matches[i]));
        if (readable.length === 0) {
          assertEquals(result, null);
          assertEquals(sent.length, 1);
        } else {
          assertEquals(result, readable);
          assertEquals(sent, []);
        }
      },
    ),
  );
});
