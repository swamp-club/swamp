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
  createWorkflowEditDeps,
  resolveWorkflowEditFile,
  workflowEdit,
  type WorkflowEditDeps,
  type WorkflowEditEvent,
} from "./edit.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { parse as parseYaml } from "@std/yaml";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import {
  registerManagedConfig,
  resetManagedConfigRegistry,
} from "../../infrastructure/persistence/paths.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";

function prepareEditor(editor: string) {
  return (path: string) =>
    Promise.resolve({
      editor,
      waitsForExit: false,
      open: () => Promise.resolve({ editor, path }),
    });
}

function makeDeps(
  overrides: Partial<WorkflowEditDeps> = {},
): WorkflowEditDeps {
  return {
    findById: () => Promise.resolve(null),
    findByName: () => Promise.resolve(null),
    findBrokenWorkflow: () => Promise.resolve(null),
    getPath: () => "/fake/path/workflow.yaml",
    resolveSymlink: () => Promise.resolve(null),
    fileExists: () => Promise.resolve(true),
    prepareEditor: prepareEditor("VS Code"),
    saveRepaired: () => Promise.resolve(),
    writePathFor: () => "/fake/path/workflow.yaml",
    isStoredFile: () => false,
    findAllById: () => Promise.resolve([]),
    updateFromStdin: () =>
      Promise.resolve(
        {
          name: "updated",
          id: "00000000-0000-4000-8000-000000000000",
        } as unknown as Workflow,
      ),
    ...overrides,
  };
}

const testWorkflow = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "deploy-workflow",
  description: "Deploy to production",
  jobs: [],
} as unknown as Workflow;

Deno.test("workflowEdit: yields error when workflow not found by name", async () => {
  const deps = makeDeps();

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "missing-workflow",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<WorkflowEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("workflowEdit: yields error when workflow not found by UUID", async () => {
  const deps = makeDeps();

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "550e8400-e29b-41d4-a716-446655440000",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<WorkflowEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("resolveWorkflowEditFile: a stored workflow resolves to its repository file", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(testWorkflow),
    getPath: () => "/repo/workflows/workflow-550e8400.yaml",
  });

  const file = await resolveWorkflowEditFile(createLibSwampContext(), deps, {
    workflowIdOrName: "deploy-workflow",
  });

  assertEquals(file, {
    kind: "workflow",
    path: "/repo/workflows/workflow-550e8400.yaml",
    workflow: testWorkflow,
  });
});

Deno.test("workflowEdit: without content refuses to open a stored workflow in place (swamp-club#4107)", async () => {
  let prepared = false;
  const deps = makeDeps({
    findByName: () => Promise.resolve(testWorkflow),
    prepareEditor: (path) => {
      prepared = true;
      return prepareEditor("Neovim")(path);
    },
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertStringIncludes(last.error.message, "edit a copy");
  assertEquals(prepared, false);
});

Deno.test("workflowEdit: announces editor launch before opening a file in place", async () => {
  let opened = false;
  const deps = makeDeps({
    findByName: () => Promise.resolve(testWorkflow),
    fileExists: () => Promise.resolve(false),
    resolveSymlink: () =>
      Promise.resolve("/repo/extensions/workflows/deploy/workflow.yaml"),
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

  const iterator = workflowEdit(createLibSwampContext(), deps, {
    workflowIdOrName: "deploy-workflow",
  })[Symbol.asyncIterator]();

  await iterator.next();
  const launch = await iterator.next();
  assertEquals(launch.value, {
    kind: "launching",
    data: {
      editor: "VS Code",
      path: "/repo/extensions/workflows/deploy/workflow.yaml",
      waitsForExit: true,
    },
  });
  assertEquals(opened, false);

  await iterator.next();
  assertEquals(opened, true);
});

Deno.test("workflowEdit: falls back to symlink when name lookup fails", async () => {
  const deps = makeDeps({
    findByName: () => {
      throw new Error("Broken YAML");
    },
    resolveSymlink: () =>
      Promise.resolve("/repo/extensions/workflows/broken/workflow.yaml"),
    prepareEditor: prepareEditor("VS Code"),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "broken",
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "launching",
      data: {
        editor: "VS Code",
        path: "/repo/extensions/workflows/broken/workflow.yaml",
        waitsForExit: false,
      },
    },
    {
      kind: "completed",
      data: {
        path: "/repo/extensions/workflows/broken/workflow.yaml",
        editor: "VS Code",
        status: "opened",
        name: "broken",
        id: "unknown",
      },
    },
  ]);
});

Deno.test("workflowEdit: resolves symlink for extension workflows when file missing", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(testWorkflow),
    getPath: () => "/repo/workflows/deploy-workflow/workflow.yaml",
    fileExists: () => Promise.resolve(false),
    resolveSymlink: () =>
      Promise.resolve(
        "/repo/extensions/workflows/deploy-workflow/workflow.yaml",
      ),
    prepareEditor: prepareEditor("VS Code"),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
    }),
  );

  const completed = events[2] as Extract<
    WorkflowEditEvent,
    { kind: "completed" }
  >;
  assertEquals(
    completed.data.path,
    "/repo/extensions/workflows/deploy-workflow/workflow.yaml",
  );
});

Deno.test("workflowEdit: yields error for broken workflow with stdin", async () => {
  const deps = makeDeps({
    findByName: () => {
      throw new Error("Broken YAML");
    },
    resolveSymlink: () =>
      Promise.resolve("/repo/workflows/broken/workflow.yaml"),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "broken",
      stdinContent: "name: foo\n",
    }),
  );

  assertEquals(events.length, 2);
  const last = events[1] as Extract<WorkflowEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("workflowEdit: opens broken workflow by name via findBrokenWorkflow fallback", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(null),
    resolveSymlink: () => Promise.resolve(null),
    findBrokenWorkflow: () =>
      Promise.resolve({
        file: "/repo/workflows/workflow-abc.yaml",
        name: "broken-wf",
        id: "abc",
        error: "Unknown key 'ependssss'",
      }),
    prepareEditor: prepareEditor("Neovim"),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "broken-wf",
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "launching",
      data: {
        editor: "Neovim",
        path: "/repo/workflows/workflow-abc.yaml",
        waitsForExit: false,
      },
    },
    {
      kind: "completed",
      data: {
        path: "/repo/workflows/workflow-abc.yaml",
        editor: "Neovim",
        status: "opened",
        name: "broken-wf",
        id: "unknown",
      },
    },
  ]);
});

Deno.test("workflowEdit: opens broken workflow by UUID via findBrokenWorkflow fallback", async () => {
  const brokenId = "550e8400-e29b-41d4-a716-446655440000";
  const deps = makeDeps({
    findById: () => {
      throw new Error("Unknown key 'ependssss'");
    },
    findBrokenWorkflow: () =>
      Promise.resolve({
        file: `/repo/workflows/workflow-${brokenId}.yaml`,
        name: "broken-wf",
        id: brokenId,
        error: "Unknown key 'ependssss'",
      }),
    prepareEditor: prepareEditor("Neovim"),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: brokenId,
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "launching",
      data: {
        editor: "Neovim",
        path: `/repo/workflows/workflow-${brokenId}.yaml`,
        waitsForExit: false,
      },
    },
    {
      kind: "completed",
      data: {
        path: `/repo/workflows/workflow-${brokenId}.yaml`,
        editor: "Neovim",
        status: "opened",
        name: brokenId,
        id: "unknown",
      },
    },
  ]);
});

Deno.test("workflowEdit: yields not_found when workflow genuinely missing (name)", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(null),
    resolveSymlink: () => Promise.resolve(null),
    findBrokenWorkflow: () => Promise.resolve(null),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "totally-missing",
    }),
  );

  assertEquals(events.length, 2);
  const last = events[1] as Extract<WorkflowEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("workflowEdit: yields not_found when workflow genuinely missing (UUID)", async () => {
  const deps = makeDeps({
    findById: () => Promise.resolve(null),
    findBrokenWorkflow: () => Promise.resolve(null),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "550e8400-e29b-41d4-a716-446655440000",
    }),
  );

  assertEquals(events.length, 2);
  const last = events[1] as Extract<WorkflowEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

/**
 * Deps whose stdin update parses to `candidate`, runs `beforeSave` like the
 * real repository-backed dep, and records whether it saved.
 */
function makeAuthorizeDeps(candidate: Workflow) {
  const saved: Workflow[] = [];
  const current = {
    ...testWorkflow,
    tags: { team: "ops" },
  } as unknown as Workflow;
  const deps = makeDeps({
    findByName: () => Promise.resolve(current),
    findById: () => Promise.resolve(current),
    updateFromStdin: async (_workflow, _content, beforeSave) => {
      if (beforeSave && !(await beforeSave(candidate))) return null;
      saved.push(candidate);
      return candidate;
    },
  });
  return { deps, saved };
}

Deno.test("workflowEdit: stdin rename asks authorizeUpdate with the edited name and tags", async () => {
  const candidate = {
    ...testWorkflow,
    name: "renamed-workflow",
    tags: { team: "ops" },
  } as unknown as Workflow;
  const { deps, saved } = makeAuthorizeDeps(candidate);
  const asked: unknown[] = [];

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: testWorkflow.id,
      stdinContent: "name: renamed-workflow\n",
      allowRename: true,
      authorizeUpdate: (before, after) => {
        asked.push({ before, after });
        return true;
      },
    }),
  );

  assertEquals(events[events.length - 1].kind, "completed");
  assertEquals(asked, [{
    before: { name: "deploy-workflow", tags: { team: "ops" } },
    after: { name: "renamed-workflow", tags: { team: "ops" } },
  }]);
  assertEquals(saved.length, 1);
});

Deno.test("workflowEdit: stdin retag denied by authorizeUpdate writes nothing", async () => {
  const candidate = {
    ...testWorkflow,
    tags: { team: "prod" },
  } as unknown as Workflow;
  const { deps, saved } = makeAuthorizeDeps(candidate);

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: testWorkflow.id,
      stdinContent: "tags:\n  team: prod\n",
      authorizeUpdate: () => false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "forbidden");
  assertEquals(saved, []);
});

Deno.test("workflowEdit: stdin update that keeps name and tags still asks authorizeUpdate", async () => {
  const candidate = {
    ...testWorkflow,
    tags: { team: "ops" },
  } as unknown as Workflow;
  const { deps, saved } = makeAuthorizeDeps(candidate);
  let asked = false;

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: testWorkflow.id,
      stdinContent: "name: deploy-workflow\n",
      authorizeUpdate: () => {
        asked = true;
        return false;
      },
    }),
  );

  // Re-authorizing every save means a concurrent retag between the serve
  // handler's lookup and the save cannot skip the check.
  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertEquals(last.error.code, "forbidden");
  assertEquals(asked, true);
  assertEquals(saved, []);
});

Deno.test("workflowEdit: a UUID is looked up by name first", async () => {
  const impostor = {
    ...testWorkflow,
    id: "00000000-0000-4000-8000-000000000000",
    name: testWorkflow.id,
  } as unknown as Workflow;
  const paths: string[] = [];
  const deps = makeDeps({
    findByName: () => Promise.resolve(impostor),
    findById: () => Promise.resolve(testWorkflow),
    getPath: (id) => {
      paths.push(id);
      return `/fake/${id}.yaml`;
    },
  });

  await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: testWorkflow.id,
    }),
  );

  assertEquals(paths, [impostor.id]);
});

Deno.test("workflowEdit: with byId edits the workflow with that id, never a same-named one", async () => {
  const impostor = {
    ...testWorkflow,
    id: "00000000-0000-4000-8000-000000000000",
    name: testWorkflow.id,
  } as unknown as Workflow;
  const paths: string[] = [];
  const deps = makeDeps({
    findByName: () => Promise.resolve(impostor),
    findById: () => Promise.resolve(testWorkflow),
    getPath: (id) => {
      paths.push(id);
      return `/fake/${id}.yaml`;
    },
  });

  await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: testWorkflow.id,
      byId: true,
    }),
  );

  assertEquals(paths, [testWorkflow.id]);
});

Deno.test("workflowEdit: with byId a broken workflow file is matched by id only", async () => {
  const deps = makeDeps({
    findBrokenWorkflow: () =>
      Promise.resolve({
        file: "/fake/broken.yaml",
        name: testWorkflow.id,
        id: null,
        error: "bad",
      }),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: testWorkflow.id,
      byId: true,
    }),
  );

  const last = events.at(-1) as Extract<WorkflowEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // realPath: resolveSymlink returns a real path, and the macOS temp dir is
  // itself a symlink.
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp_workflow_edit_" }),
  );
  try {
    await fn(dir);
  } finally {
    resetManagedConfigRegistry();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function writeLegacyWorkflow(
  workflowsDir: string,
  name: string,
): Promise<string> {
  const path = join(workflowsDir, name, "workflow.yaml");
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, `name: ${name}\n`);
  return path;
}

const unusedRepo = {} as unknown as WorkflowRepository;

Deno.test("createWorkflowEditDeps: resolveSymlink looks in the repo workflows dir without managed config", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const expected = await writeLegacyWorkflow(
      join(repoDir, "workflows"),
      "legacy-wf",
    );

    const deps = createWorkflowEditDeps(repoDir, unusedRepo);

    assertPathEquals(await deps.resolveSymlink("legacy-wf") ?? "", expected);
    assertEquals(await deps.resolveSymlink("missing-wf"), null);
  });
});

Deno.test("createWorkflowEditDeps: resolveSymlink looks in the managed config workflows dir", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const configBase = join(dir, "datastore", "config");
    registerManagedConfig(repoDir, true, configBase);
    const expected = await writeLegacyWorkflow(
      join(configBase, "workflows"),
      "legacy-wf",
    );
    // Stale repo-local copies are not what the loader reads.
    await writeLegacyWorkflow(join(repoDir, "workflows"), "legacy-wf");
    await writeLegacyWorkflow(join(repoDir, "workflows"), "repo-only-wf");

    const deps = createWorkflowEditDeps(repoDir, unusedRepo);

    assertPathEquals(await deps.resolveSymlink("legacy-wf") ?? "", expected);
    assertEquals(await deps.resolveSymlink("repo-only-wf"), null);
  });
});

function renamedCandidate(): Workflow {
  return {
    ...testWorkflow,
    name: "renamed-workflow",
    tags: { team: "ops" },
  } as unknown as Workflow;
}

function lastError(events: WorkflowEditEvent[]) {
  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  return last.error;
}

Deno.test("workflowEdit: stdin update with a different name is refused without allowRename", async () => {
  const { deps, saved } = makeAuthorizeDeps(renamedCandidate());
  let asked = 0;

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
      stdinContent: "name: renamed-workflow\n",
      authorizeUpdate: () => {
        asked++;
        return true;
      },
    }),
  );

  const error = lastError(events);
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "'deploy-workflow'");
  assertStringIncludes(error.message, "'renamed-workflow'");
  assertStringIncludes(error.message, "--allow-rename");
  assertEquals(saved, []);
  assertEquals(asked, 0);
});

Deno.test("workflowEdit: a workflow addressed by id is not renamed by the piped name either", async () => {
  const { deps, saved } = makeAuthorizeDeps(renamedCandidate());

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: testWorkflow.id,
      stdinContent: "name: renamed-workflow\n",
    }),
  );

  assertEquals(lastError(events).code, "validation_failed");
  assertEquals(saved, []);
});

Deno.test("workflowEdit: allowRename renames when the new name is free", async () => {
  const { deps, saved } = makeAuthorizeDeps(renamedCandidate());
  const findStored = deps.findByName;
  deps.findByName = (name) =>
    name === "renamed-workflow" ? Promise.resolve(null) : findStored(name);

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
      stdinContent: "name: renamed-workflow\n",
      allowRename: true,
    }),
  );

  assertEquals(events[events.length - 1].kind, "completed");
  assertEquals(saved.length, 1);
});

Deno.test("workflowEdit: allowRename refuses a name another workflow holds", async () => {
  const { deps, saved } = makeAuthorizeDeps(renamedCandidate());
  const findStored = deps.findByName;
  const other = {
    ...testWorkflow,
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    name: "renamed-workflow",
  } as unknown as Workflow;
  deps.findByName = (name) =>
    name === "renamed-workflow" ? Promise.resolve(other) : findStored(name);

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "deploy-workflow",
      stdinContent: "name: renamed-workflow\n",
      allowRename: true,
    }),
  );

  const error = lastError(events);
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "already has that name");
  assertEquals(saved, []);
});

Deno.test("workflowEdit: records the edited workflow and the principal on the span", async () => {
  const { deps } = makeAuthorizeDeps(testWorkflow);
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowEditEvent>(
      workflowEdit(createLibSwampContext(), deps, {
        workflowIdOrName: "deploy-workflow",
        stdinContent: "name: deploy-workflow\n",
        principalId: "user:alice",
      }),
    );
    const span = findSpan(spans, "swamp.workflow.edit");
    assertEquals(span.attributes["workflow.name"], "deploy-workflow");
    assertEquals(span.attributes["workflow.id"], testWorkflow.id);
    assertEquals(span.attributes["auth.principal.id"], "user:alice");
    assertEquals(span.attributes["workflow.renamed_to"], undefined);
  });
});

Deno.test("workflowEdit: records the new name on the span after an allowed rename", async () => {
  const candidate = {
    ...testWorkflow,
    name: "renamed-workflow",
  } as unknown as Workflow;
  const { deps } = makeAuthorizeDeps(candidate);
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowEditEvent>(
      workflowEdit(createLibSwampContext(), deps, {
        workflowIdOrName: "deploy-workflow",
        stdinContent: "name: renamed-workflow\n",
        allowRename: true,
      }),
    );
    const span = findSpan(spans, "swamp.workflow.edit");
    assertEquals(span.attributes["workflow.name"], "deploy-workflow");
    assertEquals(span.attributes["workflow.renamed_to"], "renamed-workflow");
    assertEquals(span.attributes["auth.principal.id"], undefined);
  });
});

Deno.test("workflowEdit: records no target on the span when the workflow is not found", async () => {
  await withCapturedSpans(async (spans) => {
    await collect<WorkflowEditEvent>(
      workflowEdit(createLibSwampContext(), makeDeps(), {
        workflowIdOrName: "missing-workflow",
      }),
    );
    const span = findSpan(spans, "swamp.workflow.edit");
    assertEquals(span.attributes["workflow.name"], undefined);
    assertEquals(span.attributes["workflow.id"], undefined);
  });
});

// --- editor edits saved through the repository (swamp-club#4107) ---

const EDITED_ID = "00000000-0000-4000-8000-000000000001";
const EDITED_YAML = `id: ${EDITED_ID}
name: my-workflow
inputs: {}
jobs:
  - name: default
    steps:
      - name: step-1
        task:
          type: model_method
          modelIdOrName: test-model
          methodName: lookup
`;

/** Deps whose stdin update parses like the real one and records saves. */
function makeEditorSaveDeps(overrides: Partial<WorkflowEditDeps> = {}) {
  const stored = Workflow.fromData(
    parseYaml(EDITED_YAML) as Parameters<typeof Workflow.fromData>[0],
  );
  const saved: Workflow[] = [];
  const repaired: Workflow[] = [];
  const deps = makeDeps({
    findByName: (name) =>
      Promise.resolve(name === "my-workflow" ? stored : null),
    updateFromStdin: async (workflow, content, beforeSave) => {
      const data = parseYaml(content) as Parameters<
        typeof Workflow.fromData
      >[0];
      const candidate = Workflow.fromData({ ...data, id: workflow.id });
      if (beforeSave && !(await beforeSave(candidate))) return null;
      saved.push(candidate);
      return candidate;
    },
    saveRepaired: (workflow) => {
      repaired.push(workflow);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { deps, saved, repaired };
}

Deno.test("workflowEdit: an editor edit equal to the stored workflow saves nothing", async () => {
  const { deps, saved } = makeEditorSaveDeps();

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      // Same data, different layout: key order and quoting.
      stdinContent: EDITED_YAML.replace(
        "name: my-workflow",
        "name: 'my-workflow'",
      ),
      source: "editor",
      editor: "Neovim",
      allowRename: true,
    }),
  );

  assertEquals(saved, []);
  assertEquals(events[events.length - 1], {
    kind: "completed",
    data: {
      path: "/fake/path/workflow.yaml",
      editor: "Neovim",
      status: "unchanged",
      name: "my-workflow",
      id: EDITED_ID,
    },
  });
});

Deno.test("workflowEdit: an editor edit saves through the repository and names the editor", async () => {
  const { deps, saved } = makeEditorSaveDeps();

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML.replace("step-1", "step-2"),
      source: "editor",
      editor: "Neovim",
      allowRename: true,
    }),
  );

  assertEquals(saved.length, 1);
  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "completed" }
  >;
  assertEquals(last.data.status, "updated");
  assertEquals(last.data.editor, "Neovim");
});

Deno.test("workflowEdit: invalid YAML from the editor says so and saves nothing", async () => {
  const { deps, saved } = makeEditorSaveDeps();

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: "name: [unclosed\n",
      source: "editor",
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertStringIncludes(
    last.error.message,
    "Invalid workflow YAML from the editor",
  );
  assertEquals(saved, []);
});

function brokenAt(path: string) {
  return {
    findByName: () => Promise.resolve(null),
    getPath: () => path,
    writePathFor: () => path,
    isStoredFile: () => true,
    findBrokenWorkflow: () =>
      Promise.resolve({
        file: path,
        name: "my-workflow",
        id: EDITED_ID,
        error: "Unknown key 'ependssss'",
      }),
  };
}

Deno.test("resolveWorkflowEditFile: a broken file at the repository's path for its id is a stored workflow to repair", async () => {
  const { deps } = makeEditorSaveDeps(
    brokenAt("/repo/workflows/workflow-1.yaml"),
  );

  const file = await resolveWorkflowEditFile(createLibSwampContext(), deps, {
    workflowIdOrName: "my-workflow",
  });

  assertEquals(file, {
    kind: "broken",
    path: "/repo/workflows/workflow-1.yaml",
    id: EDITED_ID,
    name: "my-workflow",
  });
});

Deno.test("workflowEdit: an editor edit repairs a broken stored workflow", async () => {
  const { deps, repaired } = makeEditorSaveDeps(
    brokenAt("/repo/workflows/workflow-1.yaml"),
  );

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML,
      source: "editor",
      editor: "Neovim",
    }),
  );

  assertEquals(repaired.map((w) => w.id), [EDITED_ID]);
  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "completed" }
  >;
  assertEquals(last.data.repaired, true);
  assertEquals(last.data.status, "updated");
});

Deno.test("workflowEdit: an editor repair that still does not parse writes nothing", async () => {
  const { deps, repaired } = makeEditorSaveDeps(
    brokenAt("/repo/workflows/workflow-1.yaml"),
  );

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: "name: [unclosed\n",
      source: "editor",
    }),
  );

  assertEquals(events[events.length - 1].kind, "error");
  assertEquals(repaired, []);
});

Deno.test("workflowEdit: a piped edit still cannot replace a broken workflow", async () => {
  const { deps, repaired } = makeEditorSaveDeps(
    brokenAt("/repo/workflows/workflow-1.yaml"),
  );

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML,
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertStringIncludes(last.error.message, "must be fixed in an editor first");
  assertEquals(repaired, []);
});

Deno.test("workflowEdit: an editor repair of a file repaired meanwhile writes nothing", async () => {
  let calls = 0;
  const { deps, repaired } = makeEditorSaveDeps({
    ...brokenAt("/repo/workflows/workflow-1.yaml"),
    findBrokenWorkflow: () => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? {
            file: "/repo/workflows/workflow-1.yaml",
            name: "my-workflow",
            id: EDITED_ID,
            error: "bad",
          }
          : null,
      );
    },
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML,
      source: "editor",
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertStringIncludes(last.error.message, "was repaired while this edit ran");
  assertEquals(repaired, []);
});

Deno.test("workflowEdit: an editor repair never replaces another workflow's file (swamp-club#4107)", async () => {
  const brokenPath = "/repo/workflows/workflow-1.yaml";
  const { deps, repaired } = makeEditorSaveDeps({
    ...brokenAt(brokenPath),
    // Another broken workflow's file already sits where the save would write.
    writePathFor: () => "/repo/workflows/workflow-foo.yaml",
    fileExists: (path) =>
      Promise.resolve(
        path === brokenPath || path === "/repo/workflows/workflow-foo.yaml",
      ),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML.replace("name: my-workflow", "name: foo"),
      source: "editor",
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertStringIncludes(
    last.error.message,
    "another workflow file already uses that name",
  );
  assertEquals(repaired, []);
});

Deno.test("workflowEdit: an editor repair whose name check fails is refused", async () => {
  const { deps, repaired } = makeEditorSaveDeps({
    ...brokenAt("/repo/workflows/workflow-1.yaml"),
    findByName: () => Promise.reject(new Error("Unknown key 'ependssss'")),
    // The save would write a file other than the one being repaired, so a
    // name the lookup cannot clear may belong to another broken file.
    writePathFor: () => "/repo/workflows/workflow-other.yaml",
    fileExists: (path) =>
      Promise.resolve(path === "/repo/workflows/workflow-1.yaml"),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: EDITED_ID,
      stdinContent: EDITED_YAML,
      source: "editor",
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertStringIncludes(
    last.error.message,
    "could not check that the name is free",
  );
  assertEquals(repaired, []);
});

Deno.test("workflowEdit: an editor repair may write over its own file", async () => {
  const brokenPath = "/repo/workflows/workflow-1.yaml";
  const { deps, repaired } = makeEditorSaveDeps({
    ...brokenAt(brokenPath),
    writePathFor: () => brokenPath,
    fileExists: (path) => Promise.resolve(path === brokenPath),
  });

  await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML,
      source: "editor",
    }),
  );

  assertEquals(repaired.length, 1);
});

Deno.test("resolveWorkflowEditFile: a broken file stored under its name is a stored workflow to repair", async () => {
  const { deps } = makeEditorSaveDeps({
    ...brokenAt("/repo/workflows/workflow-my-workflow.yaml"),
    // The repository's id path for an unloaded workflow is the legacy one.
    getPath: () => `/repo/workflows/workflow-${EDITED_ID}.yaml`,
  });

  const file = await resolveWorkflowEditFile(createLibSwampContext(), deps, {
    workflowIdOrName: "my-workflow",
  });

  assertEquals(file?.kind, "broken");
  assertEquals(file?.path, "/repo/workflows/workflow-my-workflow.yaml");
});

Deno.test("workflowEdit: an editor repair of a broken file stored under its name saves it in place", async () => {
  const path = "/repo/workflows/workflow-my-workflow.yaml";
  const { deps, repaired } = makeEditorSaveDeps({
    ...brokenAt(path),
    getPath: () => `/repo/workflows/workflow-${EDITED_ID}.yaml`,
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML,
      source: "editor",
    }),
  );

  assertEquals(repaired.map((w) => w.name), ["my-workflow"]);
  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "completed" }
  >;
  assertEquals(last.data.path, path);
});

Deno.test("workflowEdit: an editor repair takes the id from the edited YAML when the broken file's could not be read", async () => {
  const path = "/repo/workflows/workflow-my-workflow.yaml";
  const { deps, repaired } = makeEditorSaveDeps({
    ...brokenAt(path),
    findBrokenWorkflow: () =>
      Promise.resolve({ file: path, name: null, id: null, error: "bad" }),
  });

  await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML,
      source: "editor",
    }),
  );

  assertEquals(repaired.map((w) => w.id), [EDITED_ID]);
});

Deno.test("workflowEdit: an editor repair with no readable id anywhere is refused", async () => {
  const path = "/repo/workflows/workflow-my-workflow.yaml";
  const { deps, repaired } = makeEditorSaveDeps({
    ...brokenAt(path),
    findBrokenWorkflow: () =>
      Promise.resolve({ file: path, name: null, id: null, error: "bad" }),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML.replace(`id: ${EDITED_ID}\n`, ""),
      source: "editor",
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertStringIncludes(last.error.message, "the edited YAML must give one");
  assertEquals(repaired, []);
});

Deno.test("workflowEdit: an editor repair may not rename a broken file stored under its name", async () => {
  const path = "/repo/workflows/workflow-my-workflow.yaml";
  const { deps, repaired } = makeEditorSaveDeps({
    ...brokenAt(path),
    getPath: () => `/repo/workflows/workflow-${EDITED_ID}.yaml`,
    writePathFor: (w) => `/repo/workflows/workflow-${w.name}.yaml`,
    fileExists: (p) => Promise.resolve(p === path),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML.replace("name: my-workflow", "name: other"),
      source: "editor",
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertStringIncludes(
    last.error.message,
    "Cannot rename the workflow while repairing it",
  );
  assertEquals(repaired, []);
});

Deno.test("workflowEdit: an editor repair of a legacy id-named file may take its name path", async () => {
  const legacy = `/repo/workflows/workflow-${EDITED_ID}.yaml`;
  const { deps, repaired } = makeEditorSaveDeps({
    ...brokenAt(legacy),
    writePathFor: (w) => `/repo/workflows/workflow-${w.name}.yaml`,
    fileExists: (p) => Promise.resolve(p === legacy),
  });

  await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML,
      source: "editor",
    }),
  );

  assertEquals(repaired.length, 1);
});

Deno.test("workflowEdit: an editor repair may not take the id of a workflow in another file", async () => {
  const path = "/repo/workflows/workflow-foo.yaml";
  const { deps, repaired } = makeEditorSaveDeps({
    ...brokenAt(path),
    // A copy of `bar` renamed and then broken: it carries bar's id.
    findAllById: (id) =>
      Promise.resolve(
        id === EDITED_ID
          ? [
            Workflow.fromData({
              ...(parseYaml(EDITED_YAML) as Parameters<
                typeof Workflow.fromData
              >[0]),
              name: "bar",
            }),
          ]
          : [],
      ),
  });

  const events = await collect<WorkflowEditEvent>(
    workflowEdit(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
      stdinContent: EDITED_YAML,
      source: "editor",
    }),
  );

  const last = events[events.length - 1] as Extract<
    WorkflowEditEvent,
    { kind: "error" }
  >;
  assertStringIncludes(last.error.message, "workflow 'bar' already has its id");
  assertEquals(repaired, []);
});
