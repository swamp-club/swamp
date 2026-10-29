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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import {
  findSpan,
  withCapturedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";
import { createLibSwampContext } from "../context.ts";
import {
  modelEdit,
  type ModelEditDeps,
  type ModelEditEvent,
  resolveModelEditFile,
} from "./edit.ts";

function prepareEditor(editor: string) {
  return (path: string) =>
    Promise.resolve({
      editor,
      waitsForExit: false,
      open: () => Promise.resolve({ editor, path }),
    });
}

function makeDeps(overrides: Partial<ModelEditDeps> = {}): ModelEditDeps {
  return {
    lookupDefinition: () => Promise.resolve(null),
    lookupDefinitionById: () => Promise.resolve(null),
    resolveSymlink: () => Promise.resolve(null),
    getDefinitionPath: () => "/fake/path/definition.yaml",
    prepareEditor: prepareEditor("VS Code"),
    updateFromStdin: () =>
      Promise.resolve(
        {
          name: "updated",
        } as unknown as import("../../domain/definitions/definition.ts").Definition,
      ),
    ...overrides,
  };
}

const testDefinition = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "my-model",
  version: 3,
  tags: { env: "prod" },
  globalArguments: { region: "us-east-1" },
} as unknown as import("../../domain/definitions/definition.ts").Definition;

const testModelType = {
  normalized: "aws/s3-bucket",
} as unknown as import("../../domain/models/model_type.ts").ModelType;

Deno.test("modelEdit: yields error when model not found", async () => {
  const deps = makeDeps();

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "missing-model",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<ModelEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("resolveModelEditFile: a stored definition resolves to its repository file", async () => {
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    getDefinitionPath: () => "/repo/.swamp/config/models/aws/web.yaml",
  });

  const file = await resolveModelEditFile(createLibSwampContext(), deps, {
    modelIdOrName: "my-model",
  });

  assertEquals(file, {
    kind: "definition",
    path: "/repo/.swamp/config/models/aws/web.yaml",
    definition: testDefinition,
    type: testModelType,
  });
});

Deno.test("modelEdit: without content refuses to open a stored definition in place (swamp-club#4107)", async () => {
  let prepared = false;
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    prepareEditor: (path) => {
      prepared = true;
      return prepareEditor("Neovim")(path);
    },
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, { modelIdOrName: "my-model" }),
  );

  const last = events[events.length - 1] as Extract<
    ModelEditEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertStringIncludes(last.error.message, "edit a copy");
  assertEquals(prepared, false);
});

Deno.test("modelEdit: announces editor launch before opening a file in place", async () => {
  let opened = false;
  const deps = makeDeps({
    lookupDefinition: () => Promise.reject(new Error("Broken YAML")),
    resolveSymlink: () =>
      Promise.resolve("/repo/models/my-model/definition.yaml"),
    prepareEditor: (path) =>
      Promise.resolve({
        editor: "VS Code",
        waitsForExit: true,
        open: () => {
          opened = true;
          return Promise.resolve({ editor: "VS Code", path });
        },
      }),
  });

  const iterator = modelEdit(createLibSwampContext(), deps, {
    modelIdOrName: "my-model",
  })[Symbol.asyncIterator]();

  await iterator.next();
  const launch = await iterator.next();
  assertEquals(launch.value, {
    kind: "launching",
    data: {
      editor: "VS Code",
      path: "/repo/models/my-model/definition.yaml",
      waitsForExit: true,
    },
  });
  assertEquals(opened, false);

  await iterator.next();
  assertEquals(opened, true);
});

Deno.test("modelEdit: falls back to symlink when lookup fails", async () => {
  const deps = makeDeps({
    lookupDefinition: () => {
      throw new Error("Broken YAML");
    },
    resolveSymlink: () =>
      Promise.resolve("/repo/extensions/models/broken/definition.yaml"),
    prepareEditor: prepareEditor("VS Code"),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "broken",
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "launching",
      data: {
        editor: "VS Code",
        path: "/repo/extensions/models/broken/definition.yaml",
        waitsForExit: false,
      },
    },
    {
      kind: "completed",
      data: {
        path: "/repo/extensions/models/broken/definition.yaml",
        editor: "VS Code",
        status: "opened",
        name: "broken",
        type: "unknown",
        editType: "definition",
      },
    },
  ]);
});

Deno.test("modelEdit: updates from stdin when content provided", async () => {
  let updateCalled = false;

  const updatedDefinition = {
    name: "updated-model",
  } as unknown as import("../../domain/definitions/definition.ts").Definition;

  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({
        definition: testDefinition,
        type: testModelType,
      }),
    getDefinitionPath: () => "/repo/models/my-model/definition.yaml",
    updateFromStdin: () => {
      updateCalled = true;
      return Promise.resolve(updatedDefinition);
    },
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: updated-model\nversion: 1\n",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    ModelEditEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "updated");
  assertEquals(completed.data.name, "updated-model");
  assertEquals(completed.data.type, "aws/s3-bucket");
  assertEquals(updateCalled, true);
});

Deno.test("modelEdit: yields error when updateFromStdin throws", async () => {
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({
        definition: testDefinition,
        type: testModelType,
      }),
    getDefinitionPath: () => "/repo/models/my-model/definition.yaml",
    updateFromStdin: () => {
      throw new Error("Invalid YAML");
    },
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "bad yaml",
    }),
  );

  const last = events[1] as Extract<ModelEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("modelEdit: yields error for broken model with stdin", async () => {
  const deps = makeDeps({
    lookupDefinition: () => {
      throw new Error("Broken YAML");
    },
    resolveSymlink: () =>
      Promise.resolve("/repo/models/broken/definition.yaml"),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "broken",
      stdinContent: "name: foo\n",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<ModelEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

// --- typeVersion reporting (swamp-club#2412) ---

/** A blocking editor: `open()` resolves only after the human has finished. */
function blockingEditor(editor: string) {
  return (path: string) =>
    Promise.resolve({
      editor,
      waitsForExit: true,
      open: () => Promise.resolve({ editor, path }),
    });
}

function definitionWith(typeVersion: string | undefined) {
  return {
    ...(testDefinition as unknown as Record<string, unknown>),
    typeVersion,
  } as unknown as import("../../domain/definitions/definition.ts").Definition;
}

function completedData(events: ModelEditEvent[]) {
  const completed = events.find((e) => e.kind === "completed");
  return (completed as Extract<ModelEditEvent, { kind: "completed" }>).data;
}

Deno.test("modelEdit: reports a malformed typeVersion written through stdin", async () => {
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    updateFromStdin: () => Promise.resolve(definitionWith("1.0")),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: my-model\n",
    }),
  );

  const data = completedData(events);
  assertEquals(data.status, "updated");
  assertEquals(data.warnings?.length, 1);
  assertStringIncludes(data.warnings![0], "1.0");
  assertStringIncludes(data.warnings![0], "YYYY.MM.DD.MICRO");
});

Deno.test("modelEdit: stdin write with a valid typeVersion carries no warning", async () => {
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    updateFromStdin: () => Promise.resolve(definitionWith("2026.02.09.1")),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: my-model\n",
    }),
  );

  assertEquals(completedData(events).warnings, undefined);
});

Deno.test("modelEdit: stdin write with no typeVersion carries no warning", async () => {
  // Absence is a legitimate state for a hand-written definition, not an error.
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    updateFromStdin: () => Promise.resolve(definitionWith(undefined)),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: my-model\n",
    }),
  );

  assertEquals(completedData(events).warnings, undefined);
});

Deno.test("modelEdit: an editor edit with a malformed typeVersion carries the warning", async () => {
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    updateFromStdin: () => Promise.resolve(definitionWith("1.0")),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: my-model\n",
      source: "editor",
      editor: "Neovim",
    }),
  );

  const data = completedData(events);
  assertEquals(data.status, "updated");
  assertEquals(data.editor, "Neovim");
  assertStringIncludes(data.warnings![0], "1.0");
});

Deno.test("modelEdit: an editor edit equal to the stored definition saves nothing", async () => {
  let saved = false;
  // Two loads of the same YAML: separate objects with equal data.
  const load = () =>
    ({
      ...(testDefinition as unknown as Record<string, unknown>),
      toData: () => ({ name: "my-model", tags: { env: "prod" } }),
    }) as unknown as TestDefinition;
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: load(), type: testModelType }),
    updateFromStdin: async (_definition, _type, _content, beforeSave) => {
      const candidate = load();
      if (beforeSave && !(await beforeSave(candidate))) return null;
      saved = true;
      return candidate;
    },
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: my-model\n",
      source: "editor",
      editor: "Neovim",
    }),
  );

  assertEquals(saved, false);
  assertEquals(completedData(events).status, "unchanged");
});

Deno.test("modelEdit: invalid YAML from the editor says so", async () => {
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    updateFromStdin: () => Promise.reject(new Error("bad indentation")),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: [x\n",
      source: "editor",
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelEditEvent,
    { kind: "error" }
  >;
  assertStringIncludes(last.error.message, "YAML from the editor");
});

Deno.test("modelEdit: re-reads a file opened in place after a blocking editor closes", async () => {
  // A legacy link to a broken definition: once fixed in the editor it
  // loads, and a malformed typeVersion is reported.
  let reads = 0;
  const deps = makeDeps({
    lookupDefinition: () => {
      reads += 1;
      return reads === 1
        ? Promise.reject(new Error("Broken YAML"))
        : Promise.resolve({
          definition: definitionWith("1.0"),
          type: testModelType,
        });
    },
    resolveSymlink: () =>
      Promise.resolve("/repo/models/my-model/definition.yaml"),
    prepareEditor: blockingEditor("Neovim"),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, { modelIdOrName: "my-model" }),
  );

  assertEquals(reads, 2);
  const data = completedData(events);
  assertEquals(data.status, "opened");
  assertStringIncludes(data.warnings![0], "1.0");
});

type TestDefinition =
  import("../../domain/definitions/definition.ts").Definition;

/**
 * Deps whose stdin update parses to `candidate`, runs `beforeSave` like the
 * real repository-backed dep, and records whether it saved.
 */
function makeAuthorizeDeps(candidate: TestDefinition) {
  const saved: TestDefinition[] = [];
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    updateFromStdin: async (_definition, _type, _content, beforeSave) => {
      if (beforeSave && !(await beforeSave(candidate))) return null;
      saved.push(candidate);
      return candidate;
    },
  });
  return { deps, saved };
}

Deno.test("modelEdit: stdin rename asks authorizeUpdate with the edited name, type and tags", async () => {
  const candidate = {
    ...testDefinition,
    name: "renamed-model",
    tags: { env: "prod" },
  } as unknown as TestDefinition;
  const { deps, saved } = makeAuthorizeDeps(candidate);
  const asked: unknown[] = [];

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: renamed-model\n",
      allowRename: true,
      authorizeUpdate: (before, after) => {
        asked.push({ before, after });
        return true;
      },
    }),
  );

  assertEquals(events[events.length - 1].kind, "completed");
  assertEquals(asked, [{
    before: {
      name: "my-model",
      modelType: "aws/s3-bucket",
      tags: { env: "prod" },
    },
    after: {
      name: "renamed-model",
      modelType: "aws/s3-bucket",
      tags: { env: "prod" },
    },
  }]);
  assertEquals(saved.length, 1);
});

Deno.test("modelEdit: stdin retag denied by authorizeUpdate writes nothing", async () => {
  const candidate = {
    ...testDefinition,
    name: "my-model",
    tags: { env: "dev" },
  } as unknown as TestDefinition;
  const { deps, saved } = makeAuthorizeDeps(candidate);

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "tags:\n  env: dev\n",
      authorizeUpdate: () => false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    ModelEditEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "forbidden");
  assertEquals(saved, []);
});

Deno.test("modelEdit: stdin update that keeps name and tags still asks authorizeUpdate", async () => {
  const candidate = {
    ...testDefinition,
    name: "my-model",
    tags: { env: "prod" },
  } as unknown as TestDefinition;
  const { deps, saved } = makeAuthorizeDeps(candidate);
  let asked = false;

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: my-model\n",
      authorizeUpdate: () => {
        asked = true;
        return false;
      },
    }),
  );

  // Re-authorizing every save means a concurrent retag between the serve
  // handler's lookup and the save cannot skip the check.
  const last = events[events.length - 1] as Extract<
    ModelEditEvent,
    { kind: "error" }
  >;
  assertEquals(last.error.code, "forbidden");
  assertEquals(asked, true);
  assertEquals(saved, []);
});

Deno.test("modelEdit: byId looks the definition up by id only", async () => {
  const lookups: string[] = [];
  const deps = makeDeps({
    lookupDefinition: (idOrName) => {
      lookups.push(`idOrName:${idOrName}`);
      return Promise.resolve(null);
    },
    lookupDefinitionById: (id) => {
      lookups.push(`id:${id}`);
      return Promise.resolve({
        definition: testDefinition,
        type: testModelType,
      });
    },
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: testDefinition.id,
      byId: true,
      stdinContent: "name: my-model\n",
    }),
  );

  assertEquals(lookups, [`id:${testDefinition.id}`]);
  assertEquals(events[events.length - 1].kind, "completed");
});

function renamedCandidate(): TestDefinition {
  return {
    ...testDefinition,
    name: "renamed-model",
  } as unknown as TestDefinition;
}

function lastError(events: ModelEditEvent[]) {
  const last = events[events.length - 1] as Extract<
    ModelEditEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  return last.error;
}

Deno.test("modelEdit: stdin update with a different name is refused without allowRename", async () => {
  const { deps, saved } = makeAuthorizeDeps(renamedCandidate());
  let asked = 0;

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: renamed-model\n",
      authorizeUpdate: () => {
        asked++;
        return true;
      },
    }),
  );

  const error = lastError(events);
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "'my-model'");
  assertStringIncludes(error.message, "'renamed-model'");
  assertStringIncludes(error.message, "--allow-rename");
  assertEquals(saved, []);
  assertEquals(asked, 0);
});

Deno.test("modelEdit: a model addressed by id is not renamed by the piped name either", async () => {
  const { deps, saved } = makeAuthorizeDeps(renamedCandidate());

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: testDefinition.id,
      stdinContent: "name: renamed-model\n",
    }),
  );

  assertEquals(lastError(events).code, "validation_failed");
  assertEquals(saved, []);
});

Deno.test("modelEdit: allowRename renames when the new name is free", async () => {
  const { deps, saved } = makeAuthorizeDeps(renamedCandidate());
  deps.lookupDefinition = (idOrName) =>
    Promise.resolve(
      idOrName === "my-model"
        ? { definition: testDefinition, type: testModelType }
        : null,
    );

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: renamed-model\n",
      allowRename: true,
    }),
  );

  assertEquals(completedData(events).name, "renamed-model");
  assertEquals(saved.length, 1);
});

Deno.test("modelEdit: allowRename refuses a name another model holds", async () => {
  const { deps, saved } = makeAuthorizeDeps(renamedCandidate());
  const other = {
    ...testDefinition,
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    name: "renamed-model",
  } as unknown as TestDefinition;
  deps.lookupDefinition = (idOrName) =>
    Promise.resolve({
      definition: idOrName === "renamed-model" ? other : testDefinition,
      type: testModelType,
    });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "name: renamed-model\n",
      allowRename: true,
    }),
  );

  const error = lastError(events);
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "already has that name");
  assertEquals(saved, []);
});

Deno.test("modelEdit: stdin update that keeps the name needs no allowRename", async () => {
  const candidate = {
    ...testDefinition,
    tags: { env: "dev" },
  } as unknown as TestDefinition;
  const { deps, saved } = makeAuthorizeDeps(candidate);

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      stdinContent: "tags:\n  env: dev\n",
    }),
  );

  assertEquals(events[events.length - 1].kind, "completed");
  assertEquals(saved.length, 1);
});

Deno.test("modelEdit: records the edited model and the principal on the span", async () => {
  const { deps } = makeAuthorizeDeps(testDefinition);
  await withCapturedSpans(async (spans) => {
    await collect<ModelEditEvent>(
      modelEdit(createLibSwampContext(), deps, {
        modelIdOrName: "my-model",
        stdinContent: "name: my-model\n",
        principalId: "user:alice",
      }),
    );
    const span = findSpan(spans, "swamp.model.edit");
    assertEquals(span.attributes["model.name"], "my-model");
    assertEquals(span.attributes["model.type"], "aws/s3-bucket");
    assertEquals(span.attributes["model.id"], testDefinition.id);
    assertEquals(span.attributes["auth.principal.id"], "user:alice");
    assertEquals(span.attributes["model.renamed_to"], undefined);
  });
});

Deno.test("modelEdit: records the new name on the span after an allowed rename", async () => {
  const candidate = {
    ...testDefinition,
    name: "renamed-model",
  } as unknown as TestDefinition;
  const { deps } = makeAuthorizeDeps(candidate);
  await withCapturedSpans(async (spans) => {
    await collect<ModelEditEvent>(
      modelEdit(createLibSwampContext(), deps, {
        modelIdOrName: "my-model",
        stdinContent: "name: renamed-model\n",
        allowRename: true,
      }),
    );
    const span = findSpan(spans, "swamp.model.edit");
    assertEquals(span.attributes["model.name"], "my-model");
    assertEquals(span.attributes["model.renamed_to"], "renamed-model");
    assertEquals(span.attributes["auth.principal.id"], undefined);
  });
});

Deno.test("modelEdit: records no target on the span when the model is not found", async () => {
  await withCapturedSpans(async (spans) => {
    await collect<ModelEditEvent>(
      modelEdit(createLibSwampContext(), makeDeps(), {
        modelIdOrName: "missing-model",
      }),
    );
    const span = findSpan(spans, "swamp.model.edit");
    assertEquals(span.attributes["model.name"], undefined);
    assertEquals(span.attributes["model.id"], undefined);
  });
});
