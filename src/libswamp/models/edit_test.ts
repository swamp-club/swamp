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
import { createLibSwampContext } from "../context.ts";
import { modelEdit, type ModelEditDeps, type ModelEditEvent } from "./edit.ts";

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

Deno.test("modelEdit: opens editor when model found", async () => {
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({
        definition: testDefinition,
        type: testModelType,
      }),
    getDefinitionPath: () => "/repo/models/my-model/definition.yaml",
    prepareEditor: prepareEditor("Neovim"),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "launching",
      data: {
        editor: "Neovim",
        path: "/repo/models/my-model/definition.yaml",
        waitsForExit: false,
      },
    },
    {
      kind: "completed",
      data: {
        path: "/repo/models/my-model/definition.yaml",
        editor: "Neovim",
        status: "opened",
        name: "my-model",
        type: "aws/s3-bucket",
        editType: "definition",
      },
    },
  ]);
});

Deno.test("modelEdit: announces editor launch before opening", async () => {
  let opened = false;
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: testDefinition, type: testModelType }),
    getDefinitionPath: () => "/repo/models/my-model/definition.yaml",
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

Deno.test("modelEdit: re-reads after a blocking editor closes and reports a malformed typeVersion", async () => {
  // The definition on disk is only malformed *after* the editor has run, so
  // the check has to read it again rather than reuse the pre-edit lookup.
  let reads = 0;
  const deps = makeDeps({
    lookupDefinition: () => {
      reads += 1;
      return Promise.resolve({
        definition: reads === 1 ? testDefinition : definitionWith("1.0"),
        type: testModelType,
      });
    },
    prepareEditor: blockingEditor("Neovim"),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, { modelIdOrName: "my-model" }),
  );

  assertEquals(reads, 2, "the file must be read again after the editor exits");
  const data = completedData(events);
  assertEquals(data.status, "opened");
  assertEquals(data.warnings?.length, 1);
  assertStringIncludes(data.warnings![0], "1.0");
});

Deno.test("modelEdit: does not re-read for a non-blocking editor", async () => {
  // open() resolves before the human has typed anything, so a check here would
  // report on the pre-edit content.
  let reads = 0;
  const deps = makeDeps({
    lookupDefinition: () => {
      reads += 1;
      return Promise.resolve({
        definition: definitionWith("1.0"),
        type: testModelType,
      });
    },
    prepareEditor: prepareEditor("VS Code"),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, { modelIdOrName: "my-model" }),
  );

  assertEquals(reads, 1, "no second read when the launch did not wait");
  assertEquals(completedData(events).warnings, undefined);
});

Deno.test("modelEdit: a failed re-read after the editor closes is not reported", async () => {
  // The model may have been renamed in the editor, or left mid-edit. Neither
  // is worth a warning about typeVersion.
  let reads = 0;
  const deps = makeDeps({
    lookupDefinition: () => {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve({
          definition: testDefinition,
          type: testModelType,
        });
      }
      return Promise.reject(new Error("unparseable YAML"));
    },
    prepareEditor: blockingEditor("Neovim"),
  });

  const events = await collect<ModelEditEvent>(
    modelEdit(createLibSwampContext(), deps, { modelIdOrName: "my-model" }),
  );

  assertEquals(completedData(events).warnings, undefined);
});
