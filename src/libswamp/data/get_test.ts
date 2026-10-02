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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createDataGetDeps,
  dataGet,
  type DataGetDeps,
  type DataGetEvent,
  type DataItem,
  resolveWorkflowData,
  type WorkflowDataItemInfo,
} from "./get.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";

function makeModelType(): ModelType {
  return ModelType.create("model/type");
}

function makeDataItem(): DataItem {
  return {
    id: "data-1",
    name: "output",
    version: 1,
    contentType: "application/json",
    lifetime: "run",
    garbageCollection: "none",
    streaming: false,
    tags: { modelName: "my-model" },
    ownerDefinition: {
      ownerType: "model",
      ownerRef: "def-1",
    },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    size: 42,
    checksum: "abc123",
  };
}

function makeDefinition(): Definition {
  return Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
}

function makeDeps(
  overrides: Partial<DataGetDeps> = {},
): DataGetDeps {
  const modelType = makeModelType();
  const definition = makeDefinition();
  const dataItem = makeDataItem();

  return {
    lookupDefinition: () => Promise.resolve({ definition, type: modelType }),
    findWorkflow: () => Promise.resolve({ id: "wf-1", name: "wf" }),
    findWorkflowRun: () => Promise.resolve({ id: "run-1" }),
    findDataByName: () => Promise.resolve(dataItem),
    findDataInWorkflowRun: () => {
      const info: WorkflowDataItemInfo = {
        data: {
          ...dataItem,
          ownerDefinition: {
            ...dataItem.ownerDefinition,
            workflowRunId: "run-1",
            jobName: "main",
            stepName: "build",
          },
        },
        modelType,
        modelId: definition.id,
        modelName: definition.name,
        jobName: "main",
        stepName: "build",
        contentPath: "/abs/path/to/data",
      };
      return Promise.resolve({ item: info, otherProducers: [] });
    },
    getContent: () => Promise.resolve(null),
    getContentPath: () => "/abs/path/to/data",
    toRelativePath: (_repoDir, absolutePath) => absolutePath,
    ...overrides,
  };
}

Deno.test("dataGet yields resolving then completed for model-scoped happy path", async () => {
  const deps = makeDeps();
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      dataName: "output",
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<DataGetEvent, { kind: "completed" }>;
  assertEquals(completed.data.name, "output");
  assertEquals(completed.data.modelName, "my-model");
});

Deno.test("dataGet yields error with validation_failed when dataName missing for model-scoped", async () => {
  const deps = makeDeps();
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<DataGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("dataGet yields error with validation_failed when no model or workflow", async () => {
  const deps = makeDeps();
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<DataGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("dataGet yields resolving then completed for workflow-scoped happy path", async () => {
  const deps = makeDeps();
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      workflowName: "wf",
      dataName: "result",
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<DataGetEvent, { kind: "completed" }>;
  assertEquals(completed.data.name, "output");
});

Deno.test("dataGet yields data_pending when workflow run is active and data not found", async () => {
  const deps = makeDeps({
    findWorkflowRun: () => Promise.resolve({ id: "run-1", status: "running" }),
    findDataInWorkflowRun: () => Promise.resolve(null),
  });
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      workflowName: "wf",
      dataName: "result",
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<DataGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "data_pending");
  assertStringIncludes(last.error.message, "not found in workflow");
  assertStringIncludes(last.error.message, "running");
  assertStringIncludes(last.error.message, "instance name");
  assertStringIncludes(last.error.message, "swamp workflow history wf");
});

Deno.test("dataGet yields not_found when workflow run is succeeded and data not found", async () => {
  const deps = makeDeps({
    findWorkflowRun: () =>
      Promise.resolve({ id: "run-1", status: "succeeded" }),
    findDataInWorkflowRun: () => Promise.resolve(null),
  });
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      workflowName: "wf",
      dataName: "result",
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events.length, 2);
  const last = events[1] as Extract<DataGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test(
  "createDataGetDeps: uses injectedDefinitionRepo for lookups",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
    try {
      const injected = new YamlDefinitionRepository(dir);
      const deps = createDataGetDeps(
        dir,
        undefined,
        undefined,
        undefined,
        injected,
      );
      const result = await deps.lookupDefinition("nonexistent");
      assertEquals(result, null);
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    }
  },
);

// The 8-byte PNG signature: 0x89 is not valid UTF-8.
const PNG_SIGNATURE = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

async function completedData(
  deps: DataGetDeps,
  scope: "model" | "workflow",
  includeContent = true,
) {
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      ...(scope === "model"
        ? { modelIdOrName: "my-model" }
        : { workflowName: "wf" }),
      dataName: "output",
      includeContent,
      repoDir: ".",
    }),
  );
  const completed = events.at(-1) as Extract<
    DataGetEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  return completed.data;
}

for (const scope of ["model", "workflow"] as const) {
  Deno.test(`dataGet: ${scope}-scoped binary content is base64 and lossless`, async () => {
    const deps = makeDeps({
      getContent: () => Promise.resolve(PNG_SIGNATURE),
    });
    const data = await completedData(deps, scope);
    assertEquals(data.contentEncoding, "base64");
    assertEquals(Uint8Array.fromBase64(data.content!), PNG_SIGNATURE);
  });

  Deno.test(`dataGet: ${scope}-scoped UTF-8 content is utf-8 text`, async () => {
    const text = "héllo wörld ✓\n";
    const deps = makeDeps({
      getContent: () => Promise.resolve(new TextEncoder().encode(text)),
    });
    const data = await completedData(deps, scope);
    assertEquals(data.contentEncoding, "utf-8");
    assertEquals(data.content, text);
  });

  Deno.test(`dataGet: ${scope}-scoped without content omits content and contentEncoding`, async () => {
    const deps = makeDeps({
      getContent: () => Promise.resolve(PNG_SIGNATURE),
    });
    const data = await completedData(deps, scope, false);
    assertEquals("content" in data, false);
    assertEquals("contentEncoding" in data, false);
  });
}

Deno.test("dataGet: byId resolves the model by id only, never by name", async () => {
  const definition = makeDefinition();
  const byIdLookups: string[] = [];
  const deps = makeDeps({
    lookupDefinition: () => {
      throw new Error("name-first lookup must not be used with byId");
    },
    lookupDefinitionById: (id) => {
      byIdLookups.push(id);
      return Promise.resolve({ definition, type: makeModelType() });
    },
  });
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      modelIdOrName: definition.id,
      byId: true,
      dataName: "output",
      includeContent: false,
      repoDir: ".",
    }),
  );

  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<DataGetEvent, { kind: "completed" }>;
  assertEquals(completed.data.modelName, "my-model");
  assertEquals(byIdLookups, [definition.id]);
});

Deno.test("dataGet: byId without a by-id lookup fails instead of looking up by name", async () => {
  let nameLookups = 0;
  const deps = makeDeps({
    lookupDefinition: () => {
      nameLookups++;
      return Promise.resolve({
        definition: Definition.create({
          id: "00000000-0000-4000-8000-000000000002",
          name: "00000000-0000-4000-8000-000000000001",
          version: 1,
        }),
        type: makeModelType(),
      });
    },
  });
  await assertRejects(
    () =>
      collect<DataGetEvent>(
        dataGet(createLibSwampContext(), deps, {
          modelIdOrName: "00000000-0000-4000-8000-000000000001",
          byId: true,
          dataName: "output",
          includeContent: false,
          repoDir: ".",
        }),
      ),
    Error,
    "by-id lookup was requested but none is wired",
  );
  assertEquals(nameLookups, 0);
});

// --- Workflow-scoped reads authorized before they read (swamp-club#2603) ---

function pinnedDeps(overrides: Partial<DataGetDeps> = {}): DataGetDeps {
  return makeDeps({
    findWorkflowById: (id, expectedName) =>
      Promise.resolve(
        id === "wf-1" && (expectedName === undefined || expectedName === "wf")
          ? { id: "wf-1", name: "wf" }
          : null,
      ),
    ...overrides,
  });
}

const PIN = {
  workflowId: "wf-1",
  workflowName: "wf",
  runId: "run-1",
  modelType: "model/type",
  modelId: "00000000-0000-4000-8000-000000000001",
  version: 1,
};

Deno.test("resolveWorkflowData: locates the workflow, run and owner without reading content", async () => {
  let contentReads = 0;
  const deps = pinnedDeps({
    getContent: () => {
      contentReads++;
      return Promise.resolve(null);
    },
  });

  const result = await resolveWorkflowData(deps, {
    workflowId: "wf-1",
    dataName: "output",
  });

  assertEquals(result.kind, "found");
  if (result.kind !== "found") return;
  assertEquals(result.location.workflow, { id: "wf-1", name: "wf" });
  assertEquals(result.location.run.id, "run-1");
  assertEquals(result.location.run.workflowId, "wf-1");
  assertEquals(result.location.item.modelId, PIN.modelId);
  assertEquals(contentReads, 0);
});

Deno.test("resolveWorkflowData: looks the workflow up by id only", async () => {
  let byNameOrId = 0;
  const deps = pinnedDeps({
    findWorkflow: () => {
      byNameOrId++;
      return Promise.resolve({ id: "wf-1", name: "wf" });
    },
  });

  const result = await resolveWorkflowData(deps, {
    workflowId: "wf",
    dataName: "output",
  });

  assertEquals(result.kind, "error");
  assertEquals(byNameOrId, 0);
});

Deno.test("dataGet with expectedOwner reads the pinned item", async () => {
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), pinnedDeps(), {
      workflowName: "ignored-when-pinned",
      dataName: "output",
      includeContent: false,
      repoDir: ".",
      expectedOwner: PIN,
    }),
  );

  assertEquals(events[1].kind, "completed");
});

Deno.test("dataGet with expectedOwner is not-found when the item has another owner", async () => {
  const other = {
    data: makeDataItem(),
    modelType: makeModelType(),
    modelId: "00000000-0000-4000-8000-0000000000ff",
    modelName: "other",
    contentPath: "/p",
  };
  const events = await collect<DataGetEvent>(
    dataGet(
      createLibSwampContext(),
      pinnedDeps({
        findDataInWorkflowRun: () =>
          Promise.resolve({ item: other, otherProducers: [] }),
      }),
      {
        workflowName: "wf",
        dataName: "output",
        includeContent: true,
        repoDir: ".",
        expectedOwner: PIN,
      },
    ),
  );

  assertEquals(events[1].kind, "error");
  if (events[1].kind !== "error") return;
  assertEquals(events[1].error.code, "not_found");
});

Deno.test("dataGet with expectedOwner reads the pinned run, not a newer latest run", async () => {
  const runsAsked: Array<string | undefined> = [];
  const events = await collect<DataGetEvent>(
    dataGet(
      createLibSwampContext(),
      pinnedDeps({
        findWorkflowRun: (_workflowId, runId) => {
          runsAsked.push(runId);
          return Promise.resolve({ id: runId ?? "run-2" });
        },
      }),
      {
        workflowName: "wf",
        dataName: "output",
        includeContent: false,
        repoDir: ".",
        expectedOwner: PIN,
      },
    ),
  );

  assertEquals(runsAsked, ["run-1"]);
  assertEquals(events[1].kind, "completed");
});

Deno.test("dataGet with expectedOwner is not-found when the pinned workflow was renamed", async () => {
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), pinnedDeps(), {
      workflowName: "wf",
      dataName: "output",
      includeContent: false,
      repoDir: ".",
      expectedOwner: { ...PIN, workflowName: "old-name" },
    }),
  );

  assertEquals(events[1].kind, "error");
});

/** A workflow-run item produced by `jobName`/`stepName` of `modelName`. */
function producedBy(
  jobName: string,
  stepName: string,
  modelName: string,
  modelId: string,
): WorkflowDataItemInfo {
  const data = makeDataItem();
  return {
    data: {
      ...data,
      ownerDefinition: {
        ...data.ownerDefinition,
        workflowRunId: "run-1",
        jobName,
        stepName,
      },
    },
    modelType: makeModelType(),
    modelId,
    modelName,
    jobName,
    stepName,
    contentPath: "/abs/path/to/data",
  };
}

async function readCompleted(
  deps: DataGetDeps,
  input: Partial<Parameters<typeof dataGet>[2]>,
) {
  const events = await collect<DataGetEvent>(
    dataGet(createLibSwampContext(), deps, {
      includeContent: true,
      repoDir: ".",
      ...input,
    }),
  );
  const last = events[events.length - 1];
  if (last.kind !== "completed") {
    throw new Error(`expected completed, got ${JSON.stringify(last)}`);
  }
  return last.data;
}

Deno.test("dataGet: a model-scoped read is deprecated and names the equivalent query", async () => {
  const data = await readCompleted(makeDeps(), {
    modelIdOrName: "my-model",
    dataName: "output",
  });

  assertEquals(
    data.replacementQuery,
    `swamp data query 'modelType == "model/type" && modelId == "00000000-0000-4000-8000-000000000001" && ` +
      `name == "output" && version == 1' --select content`,
  );
  assertEquals(data.warnings?.length, 1);
  assertStringIncludes(data.warnings![0], "swamp data get is deprecated");
  assertStringIncludes(data.warnings![0], data.replacementQuery!);
  assertStringIncludes(data.warnings![0], "drop the version clause");
  assertStringIncludes(data.warnings![0], "narrow by stepName");
});

Deno.test("dataGet: a metadata-only read's query lists metadata instead of selecting content", async () => {
  const data = await readCompleted(makeDeps(), {
    modelIdOrName: "my-model",
    dataName: "output",
    includeContent: false,
  });

  assertEquals(
    data.replacementQuery,
    `swamp data query 'modelType == "model/type" && modelId == "00000000-0000-4000-8000-000000000001" && ` +
      `name == "output" && version == 1'`,
  );
});

Deno.test("dataGet: a workflow-scoped read's query names the run, job and step", async () => {
  const data = await readCompleted(makeDeps(), {
    workflowName: "wf",
    dataName: "output",
  });

  assertEquals(
    data.replacementQuery,
    `swamp data query 'workflowRunId == "run-1" && jobName == "main" && ` +
      `stepName == "build" && name == "output" && version == 1' --select content`,
  );
  assertEquals(data.warnings?.length, 1);
});

Deno.test("dataGet: warns when other steps in the run wrote the same data name (swamp-club#2948)", async () => {
  const deps = makeDeps({
    findDataInWorkflowRun: () =>
      Promise.resolve({
        item: producedBy("setup", "checkout", "git", "id-git"),
        otherProducers: [
          producedBy("reviews", "code-review", "review-code", "id-review"),
        ],
      }),
  });

  const data = await readCompleted(deps, {
    workflowName: "wf",
    dataName: "output",
  });

  assertEquals(data.warnings?.length, 2);
  const ambiguity = data.warnings![1];
  assertStringIncludes(ambiguity, '2 items in run run-1 are named "output"');
  assertStringIncludes(
    ambiguity,
    "data get returned the one from job setup, step checkout (git)",
  );
  assertStringIncludes(
    ambiguity,
    "job reviews, step code-review (review-code), read with: " +
      `swamp data query 'workflowRunId == "run-1" && jobName == "reviews" && ` +
      'stepName == "code-review"',
  );
  assertStringIncludes(data.replacementQuery!, 'stepName == "checkout"');
});

Deno.test("dataGet: never names another producer the caller cannot read", async () => {
  const deps = makeDeps({
    findDataInWorkflowRun: () =>
      Promise.resolve({
        item: producedBy("setup", "checkout", "git", "id-git"),
        otherProducers: [
          producedBy("reviews", "code-review", "secret-model", "id-secret"),
        ],
      }),
  });

  const data = await readCompleted(deps, {
    workflowName: "wf",
    dataName: "output",
    canReadOwner: (owner) => Promise.resolve(owner.modelId !== "id-secret"),
  });

  assertEquals(data.warnings?.length, 1);
  for (const warning of data.warnings!) {
    assertEquals(warning.includes("secret-model"), false);
  }
});

Deno.test("dataGet: a read of a pinned version does not suggest dropping it", async () => {
  const data = await readCompleted(makeDeps(), {
    modelIdOrName: "my-model",
    dataName: "output",
    version: 1,
  });

  assertEquals(data.warnings?.length, 1);
  assertEquals(data.warnings![0].includes("drop the version clause"), false);
});

Deno.test("dataGet: the model-scoped query names the owner by id, not by a name another model may reuse", async () => {
  const renamed = { ...makeDataItem(), tags: { modelName: "old-name" } };
  const data = await readCompleted(
    makeDeps({ findDataByName: () => Promise.resolve(renamed) }),
    { modelIdOrName: "my-model", dataName: "output" },
  );

  assertStringIncludes(
    data.replacementQuery!,
    'modelId == "00000000-0000-4000-8000-000000000001"',
  );
  assertEquals(data.replacementQuery!.includes("modelName"), false);
});

Deno.test("dataGet: a binary item names a query that selects its content encoding", async () => {
  const binary = { ...makeDataItem(), contentType: "image/png" };
  const data = await readCompleted(
    makeDeps({ findDataByName: () => Promise.resolve(binary) }),
    { modelIdOrName: "my-model", dataName: "output" },
  );

  assertStringIncludes(
    data.replacementQuery!,
    `--select '{"content": content, "contentEncoding": contentEncoding}' --json`,
  );
  assertEquals(data.warnings?.length, 1);
  assertStringIncludes(data.warnings![0], data.replacementQuery!);
});

Deno.test("dataGet: text content that is not UTF-8 names a query that selects its content encoding", async () => {
  const text = { ...makeDataItem(), contentType: "text/plain" };
  // A UTF-16LE byte-order mark followed by "hi": not valid UTF-8.
  const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
  const data = await readCompleted(
    makeDeps({
      findDataByName: () => Promise.resolve(text),
      getContent: () => Promise.resolve(utf16),
    }),
    { modelIdOrName: "my-model", dataName: "output" },
  );

  assertEquals(data.contentEncoding, "base64");
  assertStringIncludes(
    data.replacementQuery!,
    `--select '{"content": content, "contentEncoding": contentEncoding}' --json`,
  );
  assertStringIncludes(data.warnings![0], data.replacementQuery!);
});

Deno.test("dataGet: a metadata-only read of a binary item still names a query", async () => {
  const binary = { ...makeDataItem(), contentType: "image/png" };
  const data = await readCompleted(
    makeDeps({ findDataByName: () => Promise.resolve(binary) }),
    { modelIdOrName: "my-model", dataName: "output", includeContent: false },
  );

  assertStringIncludes(data.replacementQuery!, 'name == "output"');
  assertEquals(data.replacementQuery!.includes("--select"), false);
});

Deno.test("dataGet: workflow data that records no run is queried by its owner", async () => {
  const report: WorkflowDataItemInfo = {
    data: makeDataItem(),
    modelType: makeModelType(),
    modelId: "id-report",
    modelName: "wf",
    contentPath: "/abs/path/to/data",
  };
  const data = await readCompleted(
    makeDeps({
      findDataInWorkflowRun: () =>
        Promise.resolve({ item: report, otherProducers: [] }),
    }),
    { workflowName: "wf", dataName: "output" },
  );

  assertEquals(
    data.replacementQuery,
    `swamp data query 'modelType == "model/type" && modelId == "id-report" && ` +
      `name == "output" && version == 1' --select content`,
  );
});

Deno.test("dataGet: a failing owner check leaves that producer out instead of failing the read", async () => {
  const deps = makeDeps({
    findDataInWorkflowRun: () =>
      Promise.resolve({
        item: producedBy("setup", "checkout", "git", "id-git"),
        otherProducers: [
          producedBy("reviews", "code-review", "review-code", "id-review"),
        ],
      }),
  });

  const data = await readCompleted(deps, {
    workflowName: "wf",
    dataName: "output",
    canReadOwner: () => Promise.reject(new Error("lookup failed")),
  });

  assertEquals(data.warnings?.length, 1);
});

Deno.test("dataGet: the shared-name notice lists each other producer as an alternative", async () => {
  const deps = makeDeps({
    findDataInWorkflowRun: () =>
      Promise.resolve({
        item: producedBy("setup", "checkout", "git", "id-git"),
        otherProducers: [
          producedBy("reviews", "code-review", "review-code", "id-review"),
        ],
      }),
  });

  const data = await readCompleted(deps, {
    workflowName: "wf",
    dataName: "output",
  });

  assertEquals(data.alternatives?.length, 1);
  const [alt] = data.alternatives!;
  assertEquals(
    [alt.jobName, alt.stepName, alt.modelName, alt.modelId],
    ["reviews", "code-review", "review-code", "id-review"],
  );
  assertStringIncludes(alt.replacementQuery!, 'stepName == "code-review"');
  assertStringIncludes(data.warnings![1], alt.replacementQuery!);
});

Deno.test("dataGet: a pinned read still warns about producers at another version", async () => {
  const selected = producedBy("main", "build", "my-model", PIN.modelId);
  const other = {
    ...producedBy("main", "lint", "linter", "id-linter"),
  };
  other.data = { ...other.data, version: 2 };
  const versionsAsked: Array<number | undefined> = [];
  const deps = pinnedDeps({
    findDataInWorkflowRun: (_run, _name, version) => {
      versionsAsked.push(version);
      // The pinned lookup (version 1) sees only the selected item; the
      // caller's own constraint (none) also sees the v2 producer.
      return Promise.resolve(
        version === PIN.version
          ? { item: selected, otherProducers: [] }
          : { item: other, otherProducers: [selected] },
      );
    },
  });

  const data = await readCompleted(deps, {
    workflowName: "wf",
    dataName: "output",
    expectedOwner: PIN,
  });

  assertEquals(versionsAsked, [PIN.version, undefined]);
  assertEquals(data.modelId, PIN.modelId);
  assertEquals(data.alternatives?.map((alt) => alt.stepName), ["lint"]);
});
