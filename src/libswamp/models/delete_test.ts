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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { collect } from "../testing.ts";
import {
  diagnosticPhases,
  findSpan,
  isChildOf,
  type ReadableSpan,
  withCapturedSpans,
  withObservedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";
import { withDiagnosticArea } from "../../domain/diagnostics/diagnostic_phase.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createModelDeleteDeps,
  modelDelete,
  type ModelDeleteDeps,
  type ModelDeleteEvent,
  modelDeletePreview,
} from "./delete.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { catalogDbPath } from "../../infrastructure/persistence/repository_factory.ts";
import type { Data } from "../../domain/data/data.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles
      // yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function catalogDbExists(repoDir: string): Promise<boolean> {
  try {
    await Deno.lstat(catalogDbPath(repoDir));
    return true;
  } catch {
    return false;
  }
}

Deno.test(
  "createModelDeleteDeps: reuses an injected data repo and opens no new catalog db",
  async () => {
    await withTempDir(async (dir) => {
      const injected = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        new CatalogStore(":memory:"),
      );
      createModelDeleteDeps(dir, undefined, injected);
      assertEquals(await catalogDbExists(dir), false);
    });
  },
);

Deno.test(
  "createModelDeleteDeps: opens a file-based catalog db when no repo is injected",
  async () => {
    await withTempDir(async (dir) => {
      createModelDeleteDeps(dir);
      assertEquals(await catalogDbExists(dir), true);
    });
  },
);

function mockData(name: string, opts?: { lifetime?: string }): Data {
  return {
    name,
    lifetime: opts?.lifetime ?? "infinite",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    isDeleted: false,
  } as unknown as Data;
}

const testDefinition = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "my-model",
} as unknown as import("../../domain/definitions/definition.ts").Definition;

const testModelType = {
  normalized: "aws/s3-bucket",
} as unknown as import("../../domain/models/model_type.ts").ModelType;

function makeDeps(overrides: Partial<ModelDeleteDeps> = {}): ModelDeleteDeps {
  return {
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    findAllWorkflows: () => Promise.resolve([]),
    findDataArtifacts: () => Promise.resolve([]),
    findOutputs: () => Promise.resolve([]),
    getDefinitionPath: () => "/repo/models/my-model/definition.yaml",
    deleteOutput: () => Promise.resolve(),
    deleteData: () => Promise.resolve(),
    deleteDefinition: () => Promise.resolve(),
    deleteEvaluatedDefinition: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("modelDeletePreview: returns preview data", async () => {
  const deps = makeDeps({
    findDataArtifacts: () =>
      Promise.resolve([mockData("data1"), mockData("data2")]),
    findOutputs: () => Promise.resolve([{ id: "o1", methodName: "validate" }]),
  });

  const preview = await modelDeletePreview(
    createLibSwampContext(),
    deps,
    { modelIdOrName: "my-model", force: false },
  );

  assertEquals(preview.name, "my-model");
  assertEquals(preview.dataArtifactCount, 2);
  assertEquals(preview.outputCount, 1);
  assertEquals(preview.referencingWorkflows, []);
});

Deno.test("modelDeletePreview: throws not_found for missing model", async () => {
  const deps = makeDeps({
    lookupDefinition: () => Promise.resolve(null),
  });

  try {
    await modelDeletePreview(
      createLibSwampContext(),
      deps,
      { modelIdOrName: "missing", force: false },
    );
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "not_found");
  }
});

Deno.test("modelDelete: yields completed after successful deletion", async () => {
  let definitionDeleted = false;
  const deps = makeDeps({
    deleteDefinition: () => {
      definitionDeleted = true;
      return Promise.resolve();
    },
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      force: false,
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "deleting");
  const completed = events[1] as Extract<
    ModelDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.name, "my-model");
  assertEquals(completed.data.type, "aws/s3-bucket");
  assertEquals(definitionDeleted, true);
});

Deno.test("modelDelete: yields error when model referenced by workflows", async () => {
  const deps = makeDeps({
    findAllWorkflows: () =>
      Promise.resolve([
        {
          name: "deploy",
          jobs: [{
            steps: [{
              task: {
                isModelMethod: () => true,
                data: { type: "model_method", modelIdOrName: "my-model" },
              },
            }],
          }],
        },
      ] as unknown as import("../../domain/workflows/workflow.ts").Workflow[]),
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      force: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelDeleteEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("modelDelete: yields error when data exists without force", async () => {
  const deps = makeDeps({
    findDataArtifacts: () => Promise.resolve([mockData("data1")]),
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      force: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelDeleteEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("modelDelete: force deletes data artifacts", async () => {
  let dataDeletedCount = 0;
  const deps = makeDeps({
    findDataArtifacts: () => Promise.resolve([mockData("d1"), mockData("d2")]),
    deleteData: () => {
      dataDeletedCount++;
      return Promise.resolve();
    },
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      force: true,
    }),
  );

  const completed = events[events.length - 1] as Extract<
    ModelDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.dataDeleted, true);
  assertEquals(dataDeletedCount, 2);
});

Deno.test("modelDelete: auto-collects expired data without requiring force", async () => {
  const deletedNames: string[] = [];
  const deps = makeDeps({
    findDataArtifacts: () =>
      Promise.resolve([
        mockData("expired-cache", { lifetime: "15m" }),
        mockData("another-expired", { lifetime: "1h" }),
      ]),
    isExpired: () => Promise.resolve(true),
    deleteData: (_type, _id, name) => {
      deletedNames.push(name);
      return Promise.resolve();
    },
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      force: false,
    }),
  );

  const completed = events[events.length - 1] as Extract<
    ModelDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.expiredDataAutoCollected, 2);
  assertEquals(completed.data.dataDeleted, false);
  assertEquals(deletedNames, ["expired-cache", "another-expired"]);
});

Deno.test("modelDelete: blocks on live data even when some are expired", async () => {
  const deps = makeDeps({
    findDataArtifacts: () =>
      Promise.resolve([
        mockData("expired-cache", { lifetime: "15m" }),
        mockData("live-data", { lifetime: "infinite" }),
      ]),
    isExpired: (data) => Promise.resolve(data.lifetime !== "infinite"),
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      force: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelDeleteEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("modelDeletePreview: excludes expired data from artifact count", async () => {
  const deps = makeDeps({
    findDataArtifacts: () =>
      Promise.resolve([
        mockData("expired-cache", { lifetime: "15m" }),
        mockData("live-data", { lifetime: "infinite" }),
      ]),
    isExpired: (data) => Promise.resolve(data.lifetime !== "infinite"),
  });

  const preview = await modelDeletePreview(
    createLibSwampContext(),
    deps,
    { modelIdOrName: "my-model", force: false },
  );

  assertEquals(preview.dataArtifactCount, 1);
});

function byIdDefinition(id: string) {
  return {
    id,
    name: "by-id-model",
  } as unknown as import("../../domain/definitions/definition.ts").Definition;
}

Deno.test("modelDeletePreview: byId resolves through lookupDefinitionById, never the name-first lookup", async () => {
  const id = crypto.randomUUID();
  const calls: string[] = [];
  const deps = makeDeps({
    lookupDefinition: (idOrName) => {
      calls.push(`name:${idOrName}`);
      return Promise.resolve({
        definition: testDefinition,
        type: testModelType,
      });
    },
    lookupDefinitionById: (lookupId) => {
      calls.push(`id:${lookupId}`);
      return Promise.resolve({
        definition: byIdDefinition(lookupId),
        type: testModelType,
      });
    },
  });

  const preview = await modelDeletePreview(createLibSwampContext(), deps, {
    modelIdOrName: id,
    force: false,
    byId: true,
  });

  assertEquals(preview.id, id);
  assertEquals(preview.name, "by-id-model");
  assertEquals(calls, [`id:${id}`]);
});

Deno.test("modelDelete: byId deletes the definition whose id matches, never the name-first match", async () => {
  const id = crypto.randomUUID();
  const deleted: string[] = [];
  let nameLookups = 0;
  const deps = makeDeps({
    lookupDefinition: () => {
      nameLookups++;
      return Promise.resolve({
        definition: testDefinition,
        type: testModelType,
      });
    },
    lookupDefinitionById: (lookupId) =>
      Promise.resolve({
        definition: byIdDefinition(lookupId),
        type: testModelType,
      }),
    deleteDefinition: (_type, defId) => {
      deleted.push(defId);
      return Promise.resolve();
    },
  });

  const events = await collect<ModelDeleteEvent>(
    modelDelete(createLibSwampContext(), deps, {
      modelIdOrName: id,
      force: false,
      byId: true,
    }),
  );

  const completed = events[1] as Extract<
    ModelDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.id, id);
  assertEquals(deleted, [id]);
  assertEquals(nameLookups, 0);
});

Deno.test("modelDelete: byId without lookupDefinitionById fails and deletes nothing", async () => {
  let nameLookups = 0;
  let deletes = 0;
  const deps = makeDeps({
    lookupDefinition: () => {
      nameLookups++;
      return Promise.resolve({
        definition: testDefinition,
        type: testModelType,
      });
    },
    deleteDefinition: () => {
      deletes++;
      return Promise.resolve();
    },
  });
  const input = {
    modelIdOrName: crypto.randomUUID(),
    force: true,
    byId: true,
  };

  await assertRejects(
    () => modelDeletePreview(createLibSwampContext(), deps, input),
    Error,
    "none is wired",
  );
  await assertRejects(
    () =>
      collect<ModelDeleteEvent>(
        modelDelete(createLibSwampContext(), deps, input),
      ),
    Error,
    "none is wired",
  );
  assertEquals(nameLookups, 0);
  assertEquals(deletes, 0);
});

Deno.test("modelDelete: records the deleted model and the principal on the span", async () => {
  await withCapturedSpans(async (spans) => {
    await collect(
      modelDelete(createLibSwampContext(), makeDeps(), {
        modelIdOrName: testDefinition.id,
        force: false,
        principalId: "user:alice",
      }),
    );
    const span = findSpan(spans, "swamp.model.delete");
    assertEquals(span.attributes["model.id_or_name"], testDefinition.id);
    assertEquals(span.attributes["model.name"], "my-model");
    assertEquals(span.attributes["model.type"], "aws/s3-bucket");
    assertEquals(span.attributes["model.id"], testDefinition.id);
    assertEquals(span.attributes["auth.principal.id"], "user:alice");
  });
});

Deno.test("modelDelete: records no target or principal on the span when neither is known", async () => {
  await withCapturedSpans(async (spans) => {
    await collect(
      modelDelete(
        createLibSwampContext(),
        makeDeps({ lookupDefinition: () => Promise.resolve(null) }),
        { modelIdOrName: "missing-model", force: false },
      ),
    );
    const span = findSpan(spans, "swamp.model.delete");
    assertEquals(span.attributes["model.id_or_name"], "missing-model");
    assertEquals(span.attributes["model.name"], undefined);
    assertEquals(span.attributes["auth.principal.id"], undefined);
  });
});

// ── Diagnostic phases (swamp-club#4003) ─────────────────────────────

/** Runs a delete the way worker prune does: in the worker_delete area. */
function deleteInArea(
  deps: ModelDeleteDeps,
  force = true,
): Promise<ModelDeleteEvent[]> {
  return withDiagnosticArea("worker_delete", () =>
    collect<ModelDeleteEvent>(
      modelDelete(createLibSwampContext(), deps, {
        modelIdOrName: "my-model",
        force,
      }),
    ));
}

function phase(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  return findSpan(spans, `swamp.diagnostic.${name}`);
}

function attr(span: ReadableSpan, key: string): unknown {
  return span.attributes[`swamp.diagnostic.${key}`];
}

const REFERENCING_WORKFLOW = [{
  name: "deploy",
  jobs: [{
    steps: [{
      task: {
        isModelMethod: () => true,
        data: { type: "model_method", modelIdOrName: "my-model" },
      },
    }],
  }],
}] as unknown as import("../../domain/workflows/workflow.ts").Workflow[];

Deno.test("modelDelete: in an area, each stage is a phase under model_delete with its counts", async () => {
  await withObservedSpans(async (spans) => {
    const expiredData = mockData("old");
    await deleteInArea(makeDeps({
      findAllWorkflows: () =>
        Promise.resolve(
          [{
            name: "other",
            jobs: [],
          }] as unknown as import("../../domain/workflows/workflow.ts").Workflow[],
        ),
      findDataArtifacts: () =>
        Promise.resolve([expiredData, mockData("a"), mockData("b")]),
      isExpired: (data) => Promise.resolve(data === expiredData),
      findOutputs: () =>
        Promise.resolve([
          { id: "o1", methodName: "run" },
          { id: "o2", methodName: "run" },
        ]),
    }));

    const del = findSpan(spans, "swamp.model.delete");
    const model = phase(spans, "model_delete");
    assert(isChildOf(model, del));
    // The model's identity stays on the span queries select.
    assertEquals(del.attributes["model.name"], "my-model");
    assertEquals(model.attributes["model.name"], undefined);
    assertEquals(attr(model, "definition_type"), "aws/s3-bucket");
    assertEquals(model.attributes["swamp.outcome"], "ok");

    const stages = [
      "definition_resolve",
      "workflow_reference_check",
      "data_discovery",
      "expiry_check",
      "output_discovery",
      "output_removal",
      "data_removal",
      "evaluated_removal",
      "definition_removal",
    ];
    for (const stage of stages) {
      const span = phase(spans, stage);
      assert(isChildOf(span, model), stage);
      assertEquals(span.attributes["swamp.outcome"], "ok", stage);
      assertEquals(attr(span, "area"), "worker_delete", stage);
    }
    assertEquals(attr(phase(spans, "definition_resolve"), "hit"), true);
    const refs = phase(spans, "workflow_reference_check");
    assertEquals(attr(refs, "workflows"), 1);
    assertEquals(attr(refs, "referencing"), 0);
    assertEquals(typeof attr(refs, "reference_match_work_ms"), "number");
    assertEquals(attr(phase(spans, "data_discovery"), "artifacts"), 3);
    const expiry = phase(spans, "expiry_check");
    assertEquals(attr(expiry, "checker"), true);
    assertEquals(attr(expiry, "checked"), 3);
    assertEquals(attr(expiry, "expired"), 1);
    assertEquals(attr(expiry, "live"), 2);
    assertEquals(attr(phase(spans, "output_discovery"), "outputs"), 2);
    const outputs = phase(spans, "output_removal");
    assertEquals(attr(outputs, "attempted"), 2);
    assertEquals(attr(outputs, "deleted"), 2);
    const data = phase(spans, "data_removal");
    assertEquals(attr(data, "expired_deleted"), 1);
    assertEquals(attr(data, "live_deleted"), 2);
  });
});

Deno.test("modelDelete: a refused delete ends model_delete as an error with its reason", async () => {
  await withObservedSpans(async (spans) => {
    await deleteInArea(makeDeps({
      lookupDefinition: () => Promise.resolve(null),
    }));
    await deleteInArea(makeDeps({
      findAllWorkflows: () => Promise.resolve(REFERENCING_WORKFLOW),
    }));
    await deleteInArea(
      makeDeps({ findDataArtifacts: () => Promise.resolve([mockData("d")]) }),
      false,
    );

    const models = diagnosticPhases(spans, "model_delete");
    assertEquals(models.map((s) => s.attributes["swamp.outcome"]), [
      "error",
      "error",
      "error",
    ]);
    assertEquals(models.map((s) => attr(s, "refusal")), [
      "not_found",
      "workflow_referenced",
      "live_data",
    ]);
    assertEquals(
      attr(diagnosticPhases(spans, "definition_resolve")[0], "hit"),
      false,
    );
    assertEquals(
      diagnosticPhases(spans, "workflow_reference_check").map((s) =>
        attr(s, "referencing")
      ),
      [1, 0],
    );
    assertEquals(attr(phase(spans, "expiry_check"), "checker"), false);
    assertEquals(attr(phase(spans, "expiry_check"), "live"), 1);
    // A refusal stops before any removal.
    assertEquals(diagnosticPhases(spans, "output_removal").length, 0);
  });
});

Deno.test("modelDelete: a removal that throws ends its phase and model_delete as errors", async () => {
  await withObservedSpans(async (spans) => {
    await assertRejects(() =>
      deleteInArea(makeDeps({
        findOutputs: () => Promise.resolve([{ id: "o1", methodName: "run" }]),
        deleteOutput: () => Promise.reject(new Error("disk full")),
      }))
    );
    const outputs = phase(spans, "output_removal");
    assertEquals(outputs.attributes["swamp.outcome"], "error");
    assertEquals(attr(outputs, "attempted"), 1);
    assertEquals(attr(outputs, "deleted"), undefined);
    assertEquals(
      phase(spans, "model_delete").attributes["swamp.outcome"],
      "error",
    );
    assertEquals(diagnosticPhases(spans, "data_removal").length, 0);
  });
});

Deno.test("modelDelete: outside an area no phases are exported", async () => {
  await withObservedSpans(async (spans) => {
    await collect(
      modelDelete(createLibSwampContext(), makeDeps(), {
        modelIdOrName: "my-model",
        force: false,
      }),
    );
    findSpan(spans, "swamp.model.delete");
    assertEquals(
      spans.filter((s) => s.name.startsWith("swamp.diagnostic.")).length,
      0,
    );
  });
});
