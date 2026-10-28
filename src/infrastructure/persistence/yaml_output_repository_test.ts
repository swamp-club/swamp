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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { UNREADABLE_CONTENT_CODE } from "../../domain/datastore/unreadable_content.ts";
import { UserError } from "../../domain/errors.ts";
import {
  captureUnreadableWarnings,
  fakeUnreadableLookup,
} from "./unreadable_records_test_helpers.ts";
import { assertPathStringIncludes } from "./path_test_helpers.ts";
import { ensureDir } from "@std/fs";
import { basename, dirname, join, SEPARATOR } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../logging/logger.ts";
import {
  createModelOutputId,
  type ExecutionProvenance,
  ModelOutput,
  type ModelOutputData,
} from "../../domain/models/model_output.ts";
import {
  createDefinitionId,
  type DefinitionId,
} from "../../domain/definitions/definition.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { YamlOutputRepository } from "./yaml_output_repository.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../../domain/models/access/server_token_model.ts";
import {
  observeDiagnosticPhase,
  withDiagnosticArea,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import {
  diagnosticPhases,
  findSpan,
  type ReadableSpan,
  withObservedSpans,
} from "../tracing/span_test_helpers.ts";

// Import the models barrel so `modelRegistry.types()` returns real entries —
// `findAllGlobalSince` and `findAll` both walk the registry, so tests that
// exercise them need at least one registered type. The `command/shell` model
// is the simplest entry the barrel registers.
import "../../domain/models/models.ts";

const registeredType = ModelType.create("command/shell");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const defaultProvenance: ExecutionProvenance = {
  definitionHash: "abc123",
  modelVersion: "2026.02.09.1",
  triggeredBy: "manual",
};

const testType = ModelType.create("test/type");

Deno.test("YamlOutputRepository.save creates directory structure", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output);

    const expectedDir = join(
      dir,
      ".swamp",
      "outputs",
      testType.normalized,
      "create",
    );
    const stat = await Deno.stat(expectedDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("YamlOutputRepository.save creates yaml file with correct path structure", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const definitionId = createDefinitionId(crypto.randomUUID());
    const output = ModelOutput.create({
      definitionId,
      methodName: "deploy",
      provenance: {
        definitionHash: "xyz789",
        modelVersion: "2026.02.09.2",
        triggeredBy: "workflow",
        workflowId: "wf-123",
      },
    });

    await repo.save(testType, "deploy", output);

    const path = repo.getPath(testType, "deploy", output);
    // Path should be: outputs/{type}/{method}/{definition-id}-{timestamp}.yaml
    assertPathStringIncludes(path, "outputs");
    assertPathStringIncludes(path, testType.normalized);
    assertPathStringIncludes(path, "deploy");
    assertPathStringIncludes(path, definitionId);
    assertPathStringIncludes(path, ".yaml");

    const content = await Deno.readTextFile(path);
    assertStringIncludes(content, "methodName: deploy");
    assertStringIncludes(content, "status: pending");
    assertStringIncludes(content, "workflowId: wf-123");
  });
});

Deno.test("YamlOutputRepository.findById returns saved output", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const definitionId = createDefinitionId(crypto.randomUUID());
    const output = ModelOutput.create({
      definitionId,
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output);
    const found = await repo.findById(testType, "create", output.id);

    assertEquals(found?.id, output.id);
    assertEquals(found?.definitionId, definitionId);
    assertEquals(found?.methodName, "create");
    assertEquals(found?.status, "pending");
    assertEquals(found?.provenance.definitionHash, "abc123");
  });
});

Deno.test("YamlOutputRepository.findById returns null for non-existent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const id = createModelOutputId("550e8400-e29b-41d4-a716-446655440001");

    const found = await repo.findById(testType, "create", id);
    assertEquals(found, null);
  });
});

Deno.test("YamlOutputRepository.findAll returns all outputs for a type", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);

    const output1 = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "create",
      provenance: defaultProvenance,
    });
    const output2 = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "delete",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output1);
    await repo.save(testType, "delete", output2);

    const all = await repo.findAll(testType);
    assertEquals(all.length, 2);
  });
});

Deno.test("YamlOutputRepository.findAll returns empty array when none", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);

    const all = await repo.findAll(testType);
    assertEquals(all, []);
  });
});

Deno.test("YamlOutputRepository.findByDefinition filters by definition ID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const defId1 = createDefinitionId(crypto.randomUUID());
    const defId2 = createDefinitionId(crypto.randomUUID());

    const output1 = ModelOutput.create({
      definitionId: defId1,
      methodName: "create",
      provenance: defaultProvenance,
    });
    const output2 = ModelOutput.create({
      definitionId: defId1,
      methodName: "update",
      provenance: defaultProvenance,
    });
    const output3 = ModelOutput.create({
      definitionId: defId2,
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output1);
    await repo.save(testType, "update", output2);
    await repo.save(testType, "create", output3);

    const forDef1 = await repo.findByDefinition(testType, defId1);
    assertEquals(forDef1.length, 2);

    const forDef2 = await repo.findByDefinition(testType, defId2);
    assertEquals(forDef2.length, 1);
  });
});

Deno.test("YamlOutputRepository.findLatestByDefinition returns most recent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const defId = createDefinitionId(crypto.randomUUID());

    const output1 = ModelOutput.create({
      definitionId: defId,
      methodName: "create",
      startedAt: new Date("2023-01-01T00:00:00Z"),
      provenance: defaultProvenance,
    });
    const output2 = ModelOutput.create({
      definitionId: defId,
      methodName: "update",
      startedAt: new Date("2023-01-02T00:00:00Z"),
      provenance: defaultProvenance,
    });
    const output3 = ModelOutput.create({
      definitionId: defId,
      methodName: "delete",
      startedAt: new Date("2023-01-01T12:00:00Z"),
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output1);
    await repo.save(testType, "update", output2);
    await repo.save(testType, "delete", output3);

    const latest = await repo.findLatestByDefinition(testType, defId);
    assertEquals(latest?.id, output2.id);
    assertEquals(latest?.methodName, "update");
  });
});

Deno.test("YamlOutputRepository.findLatestByDefinition returns null when none", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const defId = createDefinitionId(crypto.randomUUID());

    const latest = await repo.findLatestByDefinition(testType, defId);
    assertEquals(latest, null);
  });
});

Deno.test("YamlOutputRepository.delete removes output file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output);
    assertEquals(
      await repo.findById(testType, "create", output.id) !== null,
      true,
    );

    await repo.delete(testType, "create", output.id);
    assertEquals(await repo.findById(testType, "create", output.id), null);
  });
});

Deno.test("YamlOutputRepository.delete is idempotent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const id = createModelOutputId("550e8400-e29b-41d4-a716-446655440001");

    // Should not throw even if file doesn't exist
    await repo.delete(testType, "create", id);
  });
});

Deno.test("YamlOutputRepository.nextId generates valid UUID", () => {
  const repo = new YamlOutputRepository("/tmp");
  const id = repo.nextId();
  assertEquals(typeof id, "string");
  assertEquals(id.length, 36);
});

Deno.test("YamlOutputRepository preserves completed output state", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "create",
      status: "running",
      provenance: defaultProvenance,
    });
    output.markSucceeded();
    output.addDataArtifact({
      dataId: "550e8400-e29b-41d4-a716-446655440010",
      name: "test-resource",
      version: 1,
      tags: { type: "resource" },
    });
    output.addDataArtifact({
      dataId: "550e8400-e29b-41d4-a716-446655440011",
      name: "test-log",
      version: 1,
      tags: { type: "log" },
    });

    await repo.save(testType, "create", output);
    const found = await repo.findById(testType, "create", output.id);

    assertEquals(found?.status, "succeeded");
    assertEquals(found?.isComplete, true);
    assertEquals(found?.artifacts.dataArtifacts.length, 2);
    assertEquals(
      found?.artifacts.dataArtifacts[0].dataId,
      "550e8400-e29b-41d4-a716-446655440010",
    );
    assertEquals(
      found?.artifacts.dataArtifacts[1].dataId,
      "550e8400-e29b-41d4-a716-446655440011",
    );
  });
});

Deno.test("YamlOutputRepository preserves failed output state", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "deploy",
      status: "running",
      provenance: defaultProvenance,
    });
    output.markFailed({
      message: "Deployment failed",
      stack: "Error: Connection timeout\n  at deploy()",
    });

    await repo.save(testType, "deploy", output);
    const found = await repo.findById(testType, "deploy", output.id);

    assertEquals(found?.status, "failed");
    assertEquals(found?.error?.message, "Deployment failed");
    assertEquals(found?.error?.stack?.includes("Connection timeout"), true);
  });
});

Deno.test("YamlOutputRepository.getPath uses correct format", () => {
  const repo = new YamlOutputRepository("/tmp/test");
  const definitionId = createDefinitionId(
    "550e8400-e29b-41d4-a716-446655440000",
  );
  const output = ModelOutput.create({
    definitionId,
    methodName: "create",
    startedAt: new Date("2023-01-15T10:30:00.000Z"),
    provenance: defaultProvenance,
  });

  const path = repo.getPath(testType, "create", output);

  // Path should include: outputs/{type}/{method}/{definition-id}-{timestamp}.yaml
  assertPathStringIncludes(path, "outputs");
  assertPathStringIncludes(path, testType.normalized);
  assertPathStringIncludes(path, "create");
  assertPathStringIncludes(path, "550e8400-e29b-41d4-a716-446655440000");
  assertPathStringIncludes(path, "2023-01-15T10-30-00-000Z");
  assertPathStringIncludes(path, ".yaml");
});

Deno.test("YamlOutputRepository invokes markDirty with relPath on mutations", async () => {
  await withTempDir(async (dir) => {
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new YamlOutputRepository(dir, undefined, markDirty);

    const output = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "create",
      provenance: defaultProvenance,
    });

    const expectedPath = repo.getPath(testType, "create", output);

    // Each mutation marks before it and again after it (swamp-club#2421).
    await repo.save(testType, "create", output);
    assertEquals(calls, [expectedPath, expectedPath]);

    await repo.delete(testType, "create", output.id);
    assertEquals(calls.slice(2), [expectedPath, expectedPath]);

    // Reads do not notify.
    await repo.findAll(testType);
    await repo.findById(testType, "create", output.id);
    assertEquals(calls.length, 4);
  });
});

// findAllGlobalSince tests use a type that's actually in the model registry
// because the implementation iterates `modelRegistry.types()` to know where
// to look on disk.

async function makeOutput(
  repo: YamlOutputRepository,
  startedAt: Date,
  type: ModelType = registeredType,
): Promise<ModelOutput> {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "run",
    status: "running",
    startedAt,
    provenance: defaultProvenance,
  });
  output.markSucceeded();
  await repo.save(type, "run", output);
  return output;
}

/**
 * Configures the global model registry's extension loader to register one
 * lazy extension type, as the real catalog loader does, and runs `fn` with
 * that type. Nothing is loaded until something calls `ensureLoaded()`. The
 * type name is unique per run and the loaded flag is reset on both sides, so
 * every `--repeats` run goes through the loader again.
 */
async function withLazyExtensionType(
  fn: (type: ModelType) => Promise<void>,
): Promise<void> {
  const type = ModelType.create(
    `@user/output-ext-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.resetLoadedFlag();
  modelRegistry.setLoader(() => {
    modelRegistry.registerLazy({
      type,
      bundlePath: "unused.js",
      sourcePath: "unused.ts",
      version: "2026.09.25.1",
    });
    return Promise.resolve();
  });
  try {
    await fn(type);
  } finally {
    modelRegistry.invalidateType(type);
    modelRegistry.setLoader(() => Promise.resolve());
    modelRegistry.resetLoadedFlag();
  }
}

Deno.test(
  "findAllGlobal: loads extension types before walking the registry",
  async () => {
    await withTempDir(async (dir) => {
      await withLazyExtensionType(async (extType) => {
        const repo = new YamlOutputRepository(dir);
        const output = await makeOutput(repo, new Date(), extType);
        assertEquals(modelRegistry.has(extType), false);

        const found = await repo.findAllGlobal();

        const match = found.find((f) => f.output.id === output.id);
        assertEquals(match?.type.normalized, extType.normalized);
        assertEquals(match?.method, "run");
      });
    });
  },
);

Deno.test(
  "findAllGlobalSince: loads extension types before walking the registry",
  async () => {
    await withTempDir(async (dir) => {
      await withLazyExtensionType(async (extType) => {
        const repo = new YamlOutputRepository(dir);
        const output = await makeOutput(repo, new Date(), extType);
        assertEquals(modelRegistry.has(extType), false);

        const cutoff = new Date(Date.now() - 60 * 60 * 1000);
        const found = await repo.findAllGlobalSince(cutoff);

        assertEquals(found.length, 1);
        assertEquals(found[0].output.id, output.id);
        assertEquals(found[0].type.normalized, extType.normalized);
      });
    });
  },
);

Deno.test("findAllGlobalSince: returns only in-window outputs", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);

    const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const old = await makeOutput(repo, oldDate);

    // Backdate the file so its mtime falls before the cutoff.
    const oldPath = repo.getPath(registeredType, "run", old);
    await Deno.utime(oldPath, oldDate, oldDate);

    const fresh = await makeOutput(repo, new Date());

    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const found = await repo.findAllGlobalSince(cutoff);

    assertEquals(found.length, 1);
    assertEquals(found[0].output.id, fresh.id);
  });
});

Deno.test(
  "findAllGlobalSince: file deleted mid-iteration is skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);

      const keep = await makeOutput(repo, new Date());
      const doomed = await makeOutput(repo, new Date());

      // Simulate a concurrent deletion. Pre-fix behavior: NotFound from
      // Deno.stat propagates to the model-type catch and continues past
      // the entire current type, dropping `keep`.
      await Deno.remove(repo.getPath(registeredType, "run", doomed));

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);

      assertEquals(found.length, 1);
      assertEquals(found[0].output.id, keep.id);
    });
  },
);

Deno.test(
  "findAll: file deleted mid-iteration is skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);

      const keep = await makeOutput(repo, new Date());
      const doomed = await makeOutput(repo, new Date());

      await Deno.remove(repo.getPath(registeredType, "run", doomed));

      const found = await repo.findAll(registeredType);

      assertEquals(found.length, 1);
      assertEquals(found[0].id, keep.id);
    });
  },
);

// Wraps `Deno.readDir` so that a single chosen path yields a phantom
// entry before its real entries. The phantom points to nothing on disk,
// so when production code follows up with `Deno.readTextFile` or
// `Deno.readDir` on it, the syscall throws `NotFound` naturally —
// deterministically exercising the TOCTOU window. Returns a restore
// function that must be called in `finally`. We monkey-patch the global
// because the `find*`/`delete` walkers call `Deno.readDir` directly with
// no injection point; the alternative ("remove file before call") only
// triggers the race on platforms where readDir surfaces stale entries,
// which isn't portable.
function withPhantomReadDirEntry<T>(
  targetDir: string,
  phantom: Deno.DirEntry,
  fn: () => Promise<T>,
): Promise<T> {
  const original = Deno.readDir;
  const wrapped = (path: string | URL): AsyncIterable<Deno.DirEntry> => {
    const realIter = original(path);
    const matchPath = typeof path === "string" ? path : path.pathname;
    if (matchPath === targetDir) {
      return (async function* () {
        yield phantom;
        yield* realIter;
      })();
    }
    return realIter;
  };
  (Deno as { readDir: typeof Deno.readDir }).readDir = wrapped;
  return fn().finally(() => {
    (Deno as { readDir: typeof Deno.readDir }).readDir = original;
  });
}

Deno.test(
  "findAll: method directory deleted mid-iteration is skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);

      // Seed one real output under method "run". We then inject a
      // phantom method-dir entry into readDir(typeDir); production
      // code calls readDir(phantomMethodDir) and gets NotFound.
      // Pre-fix: NotFound escapes the inner for-await to the outer
      // catch, returns [], discarding `keep`.
      const keep = await makeOutput(repo, new Date());

      const typeDir = join(
        dir,
        ".swamp",
        "outputs",
        registeredType.normalized,
      );
      const phantom: Deno.DirEntry = {
        name: "phantom-method",
        isFile: false,
        isDirectory: true,
        isSymlink: false,
      };

      const found = await withPhantomReadDirEntry(
        typeDir,
        phantom,
        () => repo.findAll(registeredType),
      );

      assertEquals(found.length, 1);
      assertEquals(found[0].id, keep.id);
    });
  },
);

Deno.test(
  "findAllGlobalSince: method directory deleted mid-iteration is skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);

      // Same shape as above, against the per-model-type walker. Pre-fix:
      // NotFound from readDir(phantomMethodDir) escapes to the per-type
      // catch which `continue`s past the entire current model type,
      // discarding results already pushed for it.
      const keep = await makeOutput(repo, new Date());

      const typeDir = join(
        dir,
        ".swamp",
        "outputs",
        registeredType.normalized,
      );
      const phantom: Deno.DirEntry = {
        name: "phantom-method",
        isFile: false,
        isDirectory: true,
        isSymlink: false,
      };

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await withPhantomReadDirEntry(
        typeDir,
        phantom,
        () => repo.findAllGlobalSince(cutoff),
      );

      assertEquals(found.length, 1);
      assertEquals(found[0].output.id, keep.id);
    });
  },
);

Deno.test(
  "findById: non-target file deleted mid-iteration still returns target",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);

      // Seed the target. Inject a phantom .yaml entry into the method
      // dir's readDir so production code reads it before reaching the
      // real target file. Pre-fix: NotFound from readTextFile on the
      // phantom escapes the outer catch and returns null even though
      // the target exists.
      const target = await makeOutput(repo, new Date());

      const methodDir = join(
        dir,
        ".swamp",
        "outputs",
        registeredType.normalized,
        "run",
      );
      const phantom: Deno.DirEntry = {
        name: "phantom-non-target.yaml",
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      };

      const found = await withPhantomReadDirEntry(
        methodDir,
        phantom,
        () => repo.findById(registeredType, "run", target.id),
      );

      assertEquals(found?.id, target.id);
    });
  },
);

Deno.test(
  "delete: non-target file deleted mid-iteration still deletes target",
  async () => {
    await withTempDir(async (dir) => {
      // Capture markDirty so we can assert notifyDirty fires for the
      // target's path. Pre-fix, a NotFound on a non-target file aborts
      // the search before the match is found — notifyDirty never fires
      // and the target survives.
      const dirtyPaths: string[] = [];
      const markDirty = (path?: string): Promise<void> => {
        if (path) dirtyPaths.push(path);
        return Promise.resolve();
      };
      const repo = new YamlOutputRepository(dir, undefined, markDirty);

      const target = await makeOutput(repo, new Date());
      const targetPath = repo.getPath(registeredType, "run", target);

      // Reset dirty log: makeOutput's save called markDirty already.
      dirtyPaths.length = 0;

      const methodDir = join(
        dir,
        ".swamp",
        "outputs",
        registeredType.normalized,
        "run",
      );
      const phantom: Deno.DirEntry = {
        name: "phantom-non-target.yaml",
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      };

      await withPhantomReadDirEntry(
        methodDir,
        phantom,
        () => repo.delete(registeredType, "run", target.id),
      );

      // Target file must be gone.
      assertEquals(
        await repo.findById(registeredType, "run", target.id),
        null,
      );

      // The mark must have fired with the target's path, before the
      // removal and after it (swamp-club#2421).
      assertEquals(dirtyPaths, [targetPath, targetPath]);
    });
  },
);

async function seedEmptyYaml(
  dir: string,
  type: ModelType,
  method: string,
): Promise<void> {
  const methodDir = join(dir, ".swamp", "outputs", type.normalized, method);
  await ensureDir(methodDir);
  await Deno.writeTextFile(join(methodDir, "empty-corrupt.yaml"), "");
}

Deno.test(
  "findById: empty YAML file is skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const target = await makeOutput(repo, new Date());

      await seedEmptyYaml(dir, registeredType, "run");

      const found = await repo.findById(registeredType, "run", target.id);
      assertEquals(found?.id, target.id);
    });
  },
);

Deno.test(
  "findAll: empty YAML file is skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const valid = await makeOutput(repo, new Date());

      await seedEmptyYaml(dir, registeredType, "run");

      const found = await repo.findAll(registeredType);
      assertEquals(found.length, 1);
      assertEquals(found[0].id, valid.id);
    });
  },
);

Deno.test(
  "findAllGlobalSince: empty YAML file is skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const valid = await makeOutput(repo, new Date());

      await seedEmptyYaml(dir, registeredType, "run");

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);
      assertEquals(found.length, 1);
      assertEquals(found[0].output.id, valid.id);
    });
  },
);

Deno.test(
  "delete: empty YAML file does not crash scan",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const target = await makeOutput(repo, new Date());

      await seedEmptyYaml(dir, registeredType, "run");

      await repo.delete(registeredType, "run", target.id);
      assertEquals(
        await repo.findById(registeredType, "run", target.id),
        null,
      );
    });
  },
);

/**
 * Rewrites a saved output so it finishes 835ms before it starts, as a record
 * written while the clock stepped backward mid-run does.
 */
async function backdateCompletion(path: string): Promise<void> {
  const data = parseYaml(await Deno.readTextFile(path)) as ModelOutputData;
  data.completedAt = new Date(new Date(data.startedAt).getTime() - 835)
    .toISOString();
  data.durationMs = -835;
  await Deno.writeTextFile(path, stringifyYaml(data));
}

/** Seeds a record that fails validation and one that is not valid YAML. */
async function seedUnreadableYaml(
  dir: string,
  type: ModelType,
  method: string,
): Promise<{ invalidId: string }> {
  const methodDir = join(dir, ".swamp", "outputs", type.normalized, method);
  await ensureDir(methodDir);
  const invalidId = "not-a-uuid";
  await Deno.writeTextFile(
    join(methodDir, "invalid-record.yaml"),
    stringifyYaml({
      id: invalidId,
      definitionId: crypto.randomUUID(),
      methodName: method,
      status: "succeeded",
      startedAt: new Date().toISOString(),
      retryCount: 0,
      provenance: defaultProvenance,
    }),
  );
  await Deno.writeTextFile(
    join(methodDir, "malformed.yaml"),
    "id: [unclosed\n",
  );
  return { invalidId };
}

Deno.test(
  "findByDefinition: a record with a negative durationMs loads as 0 and does not block other definitions",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const skewed = await makeOutput(repo, new Date());
      await backdateCompletion(repo.getPath(registeredType, "run", skewed));
      const other = await makeOutput(repo, new Date());

      const found = await repo.findByDefinition(
        registeredType,
        other.definitionId,
      );
      assertEquals(found.map((o) => o.id), [other.id]);

      const all = await repo.findAll(registeredType);
      assertEquals(all.length, 2);
      assertEquals(all.find((o) => o.id === skewed.id)?.durationMs, 0);
    });
  },
);

Deno.test(
  "findByDefinition: unreadable records of another definition are skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const valid = await makeOutput(repo, new Date());

      await seedUnreadableYaml(dir, registeredType, "run");

      const found = await repo.findByDefinition(
        registeredType,
        valid.definitionId,
      );
      assertEquals(found.map((o) => o.id), [valid.id]);
    });
  },
);

Deno.test(
  "findAll: unreadable records are skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const valid = await makeOutput(repo, new Date());

      await seedUnreadableYaml(dir, registeredType, "run");

      const found = await repo.findAll(registeredType);
      assertEquals(found.map((o) => o.id), [valid.id]);
    });
  },
);

Deno.test(
  "findAllGlobalSince: unreadable records are skipped, not fatal",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const valid = await makeOutput(repo, new Date());

      await seedUnreadableYaml(dir, registeredType, "run");

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);
      assertEquals(found.map((r) => r.output.id), [valid.id]);
    });
  },
);

Deno.test(
  "findById: unreadable records are skipped and an unreadable target is not found",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const target = await makeOutput(repo, new Date());

      const { invalidId } = await seedUnreadableYaml(
        dir,
        registeredType,
        "run",
      );

      const found = await repo.findById(registeredType, "run", target.id);
      assertEquals(found?.id, target.id);
      assertEquals(
        await repo.findById(
          registeredType,
          "run",
          createModelOutputId(invalidId),
        ),
        null,
      );
    });
  },
);

Deno.test(
  "findByIds: returns the outputs asked for and skips unreadable records",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const first = await makeOutput(repo, new Date());
      const second = await makeOutput(repo, new Date());
      await makeOutput(repo, new Date());
      const { invalidId } = await seedUnreadableYaml(
        dir,
        registeredType,
        "run",
      );

      const found = await repo.findByIds(
        registeredType,
        "run",
        new Set([first.id, second.id, invalidId, crypto.randomUUID()]),
      );
      assertEquals(
        [...found.keys()].sort(),
        [first.id, second.id].sort(),
      );
      assertEquals(found.get(first.id)?.id, first.id);
    });
  },
);

Deno.test(
  "findByIds: a method with no outputs, or no IDs asked for, finds nothing",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const output = await makeOutput(repo, new Date());

      assertEquals(
        (await repo.findByIds(registeredType, "missing", new Set([output.id])))
          .size,
        0,
      );
      assertEquals(
        (await repo.findByIds(registeredType, "run", new Set())).size,
        0,
      );
    });
  },
);

Deno.test(
  "findAll: a malformed record quoting I/O error text is skipped, not rethrown",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const valid = await makeOutput(repo, new Date());
      const methodDir = join(
        dir,
        ".swamp",
        "outputs",
        registeredType.normalized,
        "run",
      );
      // The YAML error message quotes this line, which isIoError matches on.
      await Deno.writeTextFile(
        join(methodDir, "quotes-io-error.yaml"),
        "id: Permission denied: EACCES\n",
      );

      const found = await repo.findAll(registeredType);
      assertEquals(found.map((o) => o.id), [valid.id]);
    });
  },
);

Deno.test({
  name: "findAll: an I/O error reading a record still propagates",
  // chmod has no effect on Windows, and root reads the file regardless.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const output = await makeOutput(repo, new Date());
      const path = repo.getPath(registeredType, "run", output);
      await Deno.chmod(path, 0o000);
      try {
        await assertRejects(() => repo.findAll(registeredType));
      } finally {
        await Deno.chmod(path, 0o644);
      }
    });
  },
});

Deno.test(
  "deleteOlderThan: empty YAML file is cleaned up",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);

      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const old = await makeOutput(repo, oldDate);
      const oldPath = repo.getPath(registeredType, "run", old);
      await Deno.utime(oldPath, oldDate, oldDate);

      await seedEmptyYaml(dir, registeredType, "run");
      const emptyPath = join(
        dir,
        ".swamp",
        "outputs",
        registeredType.normalized,
        "run",
        "empty-corrupt.yaml",
      );
      await Deno.utime(emptyPath, oldDate, oldDate);

      const result = await repo.deleteOlderThan(
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      );
      assertEquals(result.deleted, 2);
    });
  },
);

// --- deleteByMethodLifetime ---

async function makeOutputForMethod(
  repo: YamlOutputRepository,
  type: ModelType,
  method: string,
  startedAt: Date,
): Promise<ModelOutput> {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: method,
    status: "running",
    startedAt,
    provenance: defaultProvenance,
  });
  output.markSucceeded();
  await repo.save(type, method, output);
  return output;
}

Deno.test(
  "deleteByMethodLifetime: respects per-method outputLifetime",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);

      // server-token redeem has outputLifetime: "1d"
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const old = await makeOutputForMethod(
        repo,
        SERVER_TOKEN_MODEL_TYPE,
        "redeem",
        twoDaysAgo,
      );
      const oldPath = repo.getPath(SERVER_TOKEN_MODEL_TYPE, "redeem", old);
      await Deno.utime(oldPath, twoDaysAgo, twoDaysAgo);

      // Use a 30-day fallback — the 1d method lifetime should still clean up
      const fallback = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await repo.deleteByMethodLifetime(fallback);
      assertEquals(result.deleted, 1);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: uses fallback for methods without outputLifetime",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);

      // command/shell has no outputLifetime
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const old = await makeOutputForMethod(
        repo,
        registeredType,
        "run",
        twoDaysAgo,
      );
      const oldPath = repo.getPath(registeredType, "run", old);
      await Deno.utime(oldPath, twoDaysAgo, twoDaysAgo);

      // Fallback is 1 day — should delete the 2-day-old output
      const fallback = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const result = await repo.deleteByMethodLifetime(fallback);
      assertEquals(result.deleted, 1);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: skips non-terminal outputs",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);

      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const running = ModelOutput.create({
        definitionId: createDefinitionId(crypto.randomUUID()),
        methodName: "redeem",
        status: "running",
        startedAt: twoDaysAgo,
        provenance: defaultProvenance,
      });
      await repo.save(SERVER_TOKEN_MODEL_TYPE, "redeem", running);
      const runPath = repo.getPath(SERVER_TOKEN_MODEL_TYPE, "redeem", running);
      await Deno.utime(runPath, twoDaysAgo, twoDaysAgo);

      const fallback = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await repo.deleteByMethodLifetime(fallback);
      assertEquals(result.deleted, 0);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: cleans orphaned type outputs using fallback",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const orphanType = ModelType.create("orphan/unregistered");

      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const old = await makeOutputForMethod(
        repo,
        orphanType,
        "run",
        twoDaysAgo,
      );
      const oldPath = repo.getPath(orphanType, "run", old);
      await Deno.utime(oldPath, twoDaysAgo, twoDaysAgo);

      const fallback = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const result = await repo.deleteByMethodLifetime(fallback);
      assertEquals(result.deleted, 1);
    });
  },
);

// --- run log removal (swamp-club#2475) ---

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function localMethodDir(repoDir: string): string {
  return join(repoDir, ".swamp", "outputs", registeredType.normalized, "run");
}

async function writeAgedLog(path: string, age: Date): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, "run log line\n");
  await Deno.utime(path, age, age);
}

/**
 * Saves a succeeded output with a run log, then ages both files to
 * startedAt. By default the log lives in the repo-local outputs root and is
 * named from a timestamp a few ms before startedAt, as createRunLog does.
 * `logPath` places the log elsewhere; `logFile` records a different value
 * than the log's path (as a hand-edited record would); `logWrittenAt` sets
 * the log's mtime instead of startedAt.
 */
async function makeOutputWithRunLog(
  repo: YamlOutputRepository,
  repoDir: string,
  startedAt: Date,
  overrides?: { logPath?: string; logFile?: string; logWrittenAt?: Date },
): Promise<{ output: ModelOutput; yamlPath: string; logPath: string }> {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "run",
    status: "running",
    startedAt,
    provenance: defaultProvenance,
  });
  const logStamp = new Date(startedAt.getTime() - 4).toISOString()
    .replace(/[:.]/g, "-");
  const logPath = overrides?.logPath ??
    join(localMethodDir(repoDir), `${output.definitionId}-${logStamp}.log`);
  await writeAgedLog(logPath, overrides?.logWrittenAt ?? startedAt);
  output.setLogFile(overrides?.logFile ?? logPath);
  output.markSucceeded();
  await repo.save(registeredType, "run", output);
  const yamlPath = repo.getPath(registeredType, "run", output);
  await Deno.utime(yamlPath, startedAt, startedAt);
  return { output, yamlPath, logPath };
}

function workflowRunLogPath(repoDir: string): string {
  return join(
    repoDir,
    ".swamp",
    "workflow-runs",
    crypto.randomUUID(),
    `workflow-run-${crypto.randomUUID()}.log`,
  );
}

Deno.test(
  "deleteByMethodLifetime: removes the run log recorded in logFile",
  async () => {
    await withTempDir(async (dir) => {
      const dirtyPaths: string[] = [];
      const markDirty = (path?: string): Promise<void> => {
        if (path) dirtyPaths.push(path);
        return Promise.resolve();
      };
      const repo = new YamlOutputRepository(dir, undefined, markDirty);
      const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
      // A fresh log is out of the orphan sweep's reach, so only the
      // output's own removal can delete it.
      const { yamlPath, logPath } = await makeOutputWithRunLog(
        repo,
        dir,
        twoDaysAgo,
        { logWrittenAt: new Date() },
      );
      const yamlBytes = (await Deno.stat(yamlPath)).size;
      const logBytes = (await Deno.stat(logPath)).size;
      dirtyPaths.length = 0;

      const result = await repo.deleteByMethodLifetime(
        new Date(Date.now() - DAY_MS),
      );

      assertEquals(result.deleted, 1);
      assertEquals(result.bytesReclaimed, yamlBytes + logBytes);
      assertEquals(await pathExists(logPath), false);
      assertEquals(await pathExists(localMethodDir(dir)), false);
      assertEquals(dirtyPaths.includes(logPath), true);
    });
  },
);

Deno.test(
  "deleteOlderThan: removes the run log recorded in logFile",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
      // A fresh log is out of the orphan sweep's reach, so only the
      // output's own removal can delete it.
      const { logPath } = await makeOutputWithRunLog(repo, dir, twoDaysAgo, {
        logWrittenAt: new Date(),
      });

      const result = await repo.deleteOlderThan(new Date(Date.now() - DAY_MS));

      assertEquals(result.deleted, 1);
      assertEquals(await pathExists(logPath), false);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: removes the repo-local run log of a datastore output",
  async () => {
    await withTempDir(async (dir) => {
      const dirtyPaths: string[] = [];
      const markDirty = (path?: string): Promise<void> => {
        if (path) dirtyPaths.push(path);
        return Promise.resolve();
      };
      const datastoreOutputs = join(dir, "datastore", "outputs");
      const repo = new YamlOutputRepository(dir, datastoreOutputs, markDirty);
      const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
      // A fresh log is out of the orphan sweep's reach, so only the
      // output's own removal can delete it.
      const { yamlPath, logPath } = await makeOutputWithRunLog(
        repo,
        dir,
        twoDaysAgo,
        { logWrittenAt: new Date() },
      );
      assertPathStringIncludes(yamlPath, "datastore");

      const result = await repo.deleteByMethodLifetime(
        new Date(Date.now() - DAY_MS),
      );

      assertEquals(result.deleted, 1);
      assertEquals(await pathExists(yamlPath), false);
      assertEquals(await pathExists(logPath), false);
      // The record syncs with the datastore; the repo-local log never did.
      assertEquals(dirtyPaths.includes(yamlPath), true);
      assertEquals(dirtyPaths.includes(logPath), false);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: leaves a workflow run's log a step output points at",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
      const workflowLog = workflowRunLogPath(dir);
      const { yamlPath } = await makeOutputWithRunLog(repo, dir, twoDaysAgo, {
        logPath: workflowLog,
      });

      const result = await repo.deleteByMethodLifetime(
        new Date(Date.now() - DAY_MS),
      );

      assertEquals(result.deleted, 1);
      assertEquals(await pathExists(yamlPath), false);
      assertEquals(await pathExists(workflowLog), true);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: ignores a logFile outside the output's method directory",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
      // A relative logFile that climbs out of the method directory.
      const traversed = join(dir, "outside.log");
      await makeOutputWithRunLog(repo, dir, twoDaysAgo, {
        logPath: traversed,
        logFile: [
          ".swamp",
          "outputs",
          ...registeredType.normalized.split("/"),
          "run",
          "..",
          "..",
          "..",
          "..",
          "outside.log",
        ].join(SEPARATOR),
      });
      // An absolute logFile somewhere else entirely.
      const absolute = join(dir, "elsewhere", "absolute.log");
      await makeOutputWithRunLog(repo, dir, twoDaysAgo, { logPath: absolute });

      const result = await repo.deleteByMethodLifetime(
        new Date(Date.now() - DAY_MS),
      );

      assertEquals(result.deleted, 2);
      assertEquals(await pathExists(traversed), true);
      assertEquals(await pathExists(absolute), true);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: removes the same-stem log of a record without logFile",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
      const old = await makeOutput(repo, twoDaysAgo);
      const yamlPath = repo.getPath(registeredType, "run", old);
      await Deno.utime(yamlPath, twoDaysAgo, twoDaysAgo);
      // Younger than the orphan-sweep floor, so only the record's own
      // removal can delete it.
      const legacyLog = yamlPath.replace(/\.yaml$/, ".log");
      await writeAgedLog(legacyLog, new Date());

      const result = await repo.deleteByMethodLifetime(
        new Date(Date.now() - DAY_MS),
      );

      assertEquals(result.deleted, 1);
      assertEquals(await pathExists(legacyLog), false);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: sweeps unreferenced run logs past the cutoff",
  async () => {
    await withTempDir(async (dir) => {
      const dirtyPaths: string[] = [];
      const markDirty = (path?: string): Promise<void> => {
        if (path) dirtyPaths.push(path);
        return Promise.resolve();
      };
      const repo = new YamlOutputRepository(dir, undefined, markDirty);
      const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
      const orphan = join(localMethodDir(dir), "orphan-left-by-old-gc.log");
      await writeAgedLog(orphan, tenDaysAgo);
      const orphanBytes = (await Deno.stat(orphan)).size;

      const result = await repo.deleteByMethodLifetime(
        new Date(Date.now() - DAY_MS),
      );

      assertEquals(result.deleted, 0);
      assertEquals(result.bytesReclaimed, orphanBytes);
      assertEquals(await pathExists(orphan), false);
      assertEquals(await pathExists(localMethodDir(dir)), false);
      assertEquals(dirtyPaths.includes(orphan), true);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: keeps an old run log a surviving output references",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      // The output started inside the retention window, but its log was
      // last written before the cutoff.
      const { yamlPath, logPath } = await makeOutputWithRunLog(
        repo,
        dir,
        new Date(Date.now() - 2 * HOUR_MS),
      );
      const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
      await Deno.utime(logPath, tenDaysAgo, tenDaysAgo);

      const result = await repo.deleteByMethodLifetime(
        new Date(Date.now() - DAY_MS),
      );

      assertEquals(result.deleted, 0);
      assertEquals(result.bytesReclaimed, 0);
      assertEquals(await pathExists(yamlPath), true);
      assertEquals(await pathExists(logPath), true);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: keeps a silent in-progress run's log under a short cutoff",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      // A direct run writes its output record only when it finishes, so a
      // long run that has logged nothing for two days has no record yet.
      const running = join(localMethodDir(dir), "run-in-progress.log");
      await writeAgedLog(running, new Date(Date.now() - 2 * DAY_MS));

      const result = await repo.deleteByMethodLifetime(
        new Date(Date.now() - HOUR_MS),
      );

      assertEquals(result.bytesReclaimed, 0);
      assertEquals(await pathExists(running), true);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: keeps a silent in-progress run's log past its method's outputLifetime",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      // server-token redeem declares outputLifetime: "1d".
      const running = join(
        dir,
        ".swamp",
        "outputs",
        SERVER_TOKEN_MODEL_TYPE.normalized,
        "redeem",
        "run-in-progress.log",
      );
      await writeAgedLog(running, new Date(Date.now() - 2 * DAY_MS));

      await repo.deleteByMethodLifetime(new Date(Date.now() - 30 * DAY_MS));

      assertEquals(await pathExists(running), true);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: keeps orphan candidates beside an unreadable record",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const orphan = join(localMethodDir(dir), "orphan-left-by-old-gc.log");
      await writeAgedLog(orphan, new Date(Date.now() - 10 * DAY_MS));
      // A recent record gc would not delete, and cannot parse.
      await Deno.writeTextFile(
        join(localMethodDir(dir), "corrupt.yaml"),
        "id: [unclosed\n",
      );

      const result = await repo.deleteByMethodLifetime(
        new Date(Date.now() - DAY_MS),
      );

      assertEquals(result.bytesReclaimed, 0);
      assertEquals(await pathExists(orphan), true);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: sweeps the repo-local root when outputs live in a datastore",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(
        dir,
        join(dir, "datastore", "outputs"),
      );
      const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
      const orphan = join(localMethodDir(dir), "orphan-left-by-old-gc.log");
      await writeAgedLog(orphan, tenDaysAgo);
      // An output recorded in the datastore still claims its local log.
      const kept = await makeOutputWithRunLog(
        repo,
        dir,
        new Date(Date.now() - 2 * HOUR_MS),
      );
      await Deno.utime(kept.logPath, tenDaysAgo, tenDaysAgo);

      await repo.deleteByMethodLifetime(new Date(Date.now() - DAY_MS));

      assertEquals(await pathExists(orphan), false);
      assertEquals(await pathExists(kept.logPath), true);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: dry run removes nothing and reports the real byte count",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      // Old enough that the output's own log is also an orphan-sweep
      // candidate, so a double count would show.
      const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
      const { yamlPath, logPath } = await makeOutputWithRunLog(
        repo,
        dir,
        tenDaysAgo,
      );
      const orphan = join(localMethodDir(dir), "orphan-left-by-old-gc.log");
      await writeAgedLog(orphan, tenDaysAgo);
      const cutoff = new Date(Date.now() - DAY_MS);

      const preview = await repo.deleteByMethodLifetime(cutoff, {
        dryRun: true,
      });

      assertEquals(await pathExists(yamlPath), true);
      assertEquals(await pathExists(logPath), true);
      assertEquals(await pathExists(orphan), true);

      const real = await repo.deleteByMethodLifetime(cutoff);
      assertEquals(preview, real);
      assertEquals(await pathExists(logPath), false);
    });
  },
);

Deno.test("YamlOutputRepository.delete removes the output's run log", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const { output, logPath } = await makeOutputWithRunLog(
      repo,
      dir,
      new Date(),
    );

    await repo.delete(registeredType, "run", output.id);

    assertEquals(await pathExists(logPath), false);
    assertEquals(await pathExists(localMethodDir(dir)), false);
  });
});

Deno.test(
  "YamlOutputRepository.delete leaves a workflow run's log",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const workflowLog = workflowRunLogPath(dir);
      const { output } = await makeOutputWithRunLog(repo, dir, new Date(), {
        logPath: workflowLog,
      });

      await repo.delete(registeredType, "run", output.id);

      assertEquals(
        await repo.findById(registeredType, "run", output.id),
        null,
      );
      assertEquals(await pathExists(workflowLog), true);
    });
  },
);

Deno.test("YamlOutputRepository.findAll: outputs with one startedAt come back in file-name order", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const definitionIds = [
      "88888888-8888-4888-8888-888888888888",
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "11111111-1111-4111-8111-111111111111",
    ];
    for (const id of definitionIds) {
      await repo.save(
        testType,
        "create",
        ModelOutput.create({
          definitionId: createDefinitionId(id),
          methodName: "create",
          provenance: defaultProvenance,
          startedAt,
        }),
      );
    }

    assertEquals(
      (await repo.findAll(testType)).map((o) => o.definitionId as string),
      [...definitionIds].sort(),
    );
  });
});

Deno.test(
  "deleteByMethodLifetime: a limit stops early with more, leaves the orphan-log sweep to the final batch, and the next call continues",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
      const made = [];
      for (let i = 0; i < 3; i++) {
        made.push(
          await makeOutputWithRunLog(
            repo,
            dir,
            new Date(tenDaysAgo.getTime() - i * 1000),
          ),
        );
      }
      const orphan = join(localMethodDir(dir), "orphan-left-by-old-gc.log");
      await writeAgedLog(orphan, tenDaysAgo);
      const cutoff = new Date(Date.now() - DAY_MS);

      const preview = await repo.deleteByMethodLifetime(cutoff, {
        dryRun: true,
        limit: 2,
      });
      assertEquals(preview.deleted, 2);
      assertEquals(preview.more, true);
      for (const { yamlPath } of made) {
        assertEquals(await pathExists(yamlPath), true);
      }

      const first = await repo.deleteByMethodLifetime(cutoff, { limit: 2 });
      assertEquals(first.deleted, 2);
      assertEquals(first.more, true);
      const gone = [];
      for (const { yamlPath, logPath } of made) {
        const exists = await pathExists(yamlPath);
        // An output's own log goes with it, even in a batch.
        assertEquals(await pathExists(logPath), exists);
        if (!exists) gone.push(yamlPath);
      }
      assertEquals(gone.length, 2);
      assertEquals(await pathExists(orphan), true);

      const second = await repo.deleteByMethodLifetime(cutoff, { limit: 2 });
      assertEquals(second.deleted, 1);
      assertEquals(second.more, false);
      for (const { yamlPath, logPath } of made) {
        assertEquals(await pathExists(yamlPath), false);
        assertEquals(await pathExists(logPath), false);
      }
      assertEquals(await pathExists(orphan), false);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: without a limit deletes every expired output and reports no more",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
      for (let i = 0; i < 3; i++) {
        await makeOutputWithRunLog(
          repo,
          dir,
          new Date(tenDaysAgo.getTime() - i * 1000),
        );
      }

      const result = await repo.deleteByMethodLifetime(
        new Date(Date.now() - DAY_MS),
      );

      assertEquals(result.deleted, 3);
      assertEquals(result.more, false);
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: an invalid fallback cutoff deletes nothing",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const old = await makeOutputForMethod(
        repo,
        registeredType,
        "run",
        twoDaysAgo,
      );
      const oldPath = repo.getPath(registeredType, "run", old);
      await Deno.utime(oldPath, twoDaysAgo, twoDaysAgo);

      // A retention too long for a date gives an invalid cutoff.
      const result = await repo.deleteByMethodLifetime(new Date(Number.NaN));
      assertEquals(result.deleted, 0);
      assertEquals(
        (await Deno.stat(oldPath)).isFile,
        true,
      );
    });
  },
);

/** An output of `definitionId` started at `startedAt`, not saved. */
function outputAt(definitionId: string, startedAt: string): ModelOutput {
  return ModelOutput.create({
    definitionId: createDefinitionId(definitionId),
    methodName: "create",
    startedAt: new Date(startedAt),
    provenance: defaultProvenance,
  });
}

/** A repository whose lookup holds the given outputs as unreadable. */
function repoWithUnreadable(
  dir: string,
  unreadable: { type: ModelType; method: string; output: ModelOutput }[],
) {
  const paths = unreadable.map(({ type, method, output }) =>
    new YamlOutputRepository(dir).getPath(type, method, output)
  );
  const fake = fakeUnreadableLookup(paths);
  return {
    repo: new YamlOutputRepository(dir, undefined, undefined, fake.lookup),
    paths,
    ...fake,
  };
}

Deno.test("YamlOutputRepository.findLatestByDefinition: fails with the error of an unreadable output that started after the latest readable one, and answers past an older one (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const defId = crypto.randomUUID();
    const older = outputAt(defId, "2023-01-01T00:00:00Z");
    const readable = outputAt(defId, "2023-01-02T00:00:00Z");
    const newer = outputAt(defId, "2023-01-03T00:00:00Z");
    // Another definition's later unreadable output does not count.
    const otherDefinition = outputAt(
      crypto.randomUUID(),
      "2023-01-04T00:00:00Z",
    );
    const { repo, errors, paths } = repoWithUnreadable(dir, [
      { type: testType, method: "create", output: newer },
      { type: testType, method: "create", output: older },
      { type: testType, method: "create", output: otherDefinition },
    ]);
    await repo.save(testType, "create", readable);
    const error = await assertRejects(() =>
      repo.findLatestByDefinition(testType, createDefinitionId(defId))
    );
    assertEquals(error, errors.get(paths[0]));

    // Without the newer one, the readable output is the latest.
    const { repo: olderOnly } = repoWithUnreadable(dir, [
      { type: testType, method: "create", output: older },
    ]);
    assertEquals(
      (await olderOnly.findLatestByDefinition(
        testType,
        createDefinitionId(defId),
      ))?.id,
      readable.id,
    );
    // With no readable output at all, an unreadable one is the latest.
    const lost = crypto.randomUUID();
    const { repo: none, errors: noneErrors, paths: nonePaths } =
      repoWithUnreadable(dir, [
        {
          type: testType,
          method: "update",
          output: outputAt(lost, "2020-01-01T00:00:00Z"),
        },
      ]);
    assertEquals(
      await assertRejects(() =>
        none.findLatestByDefinition(testType, createDefinitionId(lost))
      ),
      noneErrors.get(nonePaths[0]),
    );
  });
});

Deno.test("YamlOutputRepository.findById: a miss where the method has unreadable outputs fails as not found naming them, whether the id is theirs or mistyped; a miss without is null (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const lost = outputAt(crypto.randomUUID(), "2023-01-01T00:00:00Z");
    const { repo, paths } = repoWithUnreadable(dir, [
      { type: testType, method: "create", output: lost },
    ]);
    const kept = outputAt(crypto.randomUUID(), "2023-01-02T00:00:00Z");
    await repo.save(testType, "create", kept);
    assertEquals(
      (await repo.findById(testType, "create", kept.id))?.id,
      kept.id,
    );
    // An output id is not in its file name, so the lookup cannot tell the
    // unreadable output's own id from a mistyped one: both are not found,
    // naming the record that may be it, and neither carries the
    // unreadable-content code, since a mistyped id is no read of it.
    const mistyped = crypto.randomUUID();
    for (const id of [lost.id, mistyped]) {
      const error = await assertRejects(
        () => repo.findById(testType, "create", createModelOutputId(id)),
        UserError,
      );
      assertEquals(error.code, "not_found");
      assert(error.code !== UNREADABLE_CONTENT_CODE);
      assertStringIncludes(error.message, `${id} was not found`);
      assertStringIncludes(error.message, paths[0]);
    }
    // Another method has none: its miss is a miss.
    assertEquals(await repo.findById(testType, "update", lost.id), null);
  });
});

Deno.test("YamlOutputRepository: listings keep their readable outputs and warn naming the unreadable ones in their scope (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const defId = crypto.randomUUID();
    const readable = outputAt(defId, "2023-01-02T00:00:00Z");
    const lostOfDefinition = outputAt(defId, "2023-01-01T00:00:00Z");
    const lostOfOther = outputAt(crypto.randomUUID(), "2023-01-01T00:00:00Z");
    const { repo, paths, stats } = repoWithUnreadable(dir, [
      { type: testType, method: "create", output: lostOfDefinition },
      { type: testType, method: "create", output: lostOfOther },
    ]);
    await repo.save(testType, "create", readable);

    const byDefinition = await captureUnreadableWarnings(async () => {
      assertEquals(
        (await repo.findByDefinition(testType, createDefinitionId(defId)))
          .map((o) => o.id),
        [readable.id],
      );
    });
    assertEquals(byDefinition.length, 1, byDefinition.join("\n"));
    assertStringIncludes(byDefinition[0], paths[0]);
    assert(!byDefinition[0].includes(paths[1]), byDefinition[0]);

    const all = await captureUnreadableWarnings(async () => {
      assertEquals(
        (await repo.findAll(testType)).map((o) => o.id),
        [readable.id],
      );
    });
    // The definition's record was named already in this process.
    assertEquals(all.length, 1, all.join("\n"));
    assertStringIncludes(all[0], paths[1]);
    assertEquals(stats.listings, 2);
  });
});

Deno.test("YamlOutputRepository.findAllGlobalSince: warns only about unreadable outputs whose file name says they started at or after the cutoff (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const { repo, paths, stats } = repoWithUnreadable(dir, [
      {
        type: registeredType,
        method: "run",
        output: outputAt(crypto.randomUUID(), "2020-01-01T00:00:00Z"),
      },
      {
        type: registeredType,
        method: "run",
        output: outputAt(crypto.randomUUID(), "2030-01-01T00:00:00Z"),
      },
    ]);
    const warnings = await captureUnreadableWarnings(async () => {
      await repo.findAllGlobalSince(new Date("2025-01-01T00:00:00Z"));
      await repo.findAllGlobal();
    });
    assertEquals(warnings.length, 2, warnings.join("\n"));
    assertStringIncludes(warnings[0], paths[1]);
    assert(!warnings[0].includes(paths[0]), warnings[0]);
    // The whole-repository listing names the older one too, once.
    assertStringIncludes(warnings[1], paths[0]);
    assertEquals(stats.listings, 2);
  });
});

// --- deleteByMethodLifetime phase telemetry (swamp-club#4004) ---

/** Saves a `command/shell` output with the given status, aged as given. */
async function saveRetentionFixture(
  repo: YamlOutputRepository,
  options: { startedAt: Date; mtime: Date; terminal: boolean },
): Promise<string> {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "execute",
    status: "running",
    startedAt: options.startedAt,
    provenance: defaultProvenance,
  });
  if (options.terminal) output.markSucceeded();
  await repo.save(registeredType, "execute", output);
  const path = repo.getPath(registeredType, "execute", output);
  await Deno.utime(path, options.mtime, options.mtime);
  return path;
}

/** Saves `count` expired outputs. */
async function saveExpiredOutputs(
  repo: YamlOutputRepository,
  count: number,
): Promise<string[]> {
  const old = new Date(Date.now() - 10 * DAY_MS);
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    paths.push(
      await saveRetentionFixture(repo, {
        startedAt: old,
        mtime: old,
        terminal: true,
      }),
    );
  }
  return paths;
}

/** The one finished `swamp.diagnostic.<phase>` span's attributes. */
function phaseAttributes(
  spans: readonly ReadableSpan[],
  phase: string,
): ReadableSpan["attributes"] {
  return findSpan(spans, `swamp.diagnostic.${phase}`).attributes;
}

Deno.test(
  "deleteByMethodLifetime: output retention phases count eligible, protected and unexpired outputs",
  async () => {
    await withTempDir(async (dir) => {
      await withObservedSpans(async (spans) => {
        const repo = new YamlOutputRepository(dir);
        const old = new Date(Date.now() - 10 * DAY_MS);
        const recent = new Date(Date.now() - HOUR_MS);
        await saveExpiredOutputs(repo, 3);
        await saveRetentionFixture(repo, {
          startedAt: old,
          mtime: old,
          terminal: false,
        });
        await saveRetentionFixture(repo, {
          startedAt: recent,
          mtime: recent,
          terminal: true,
        });
        // Touched long ago, but started inside the window.
        await saveRetentionFixture(repo, {
          startedAt: recent,
          mtime: old,
          terminal: true,
        });

        const result = await withDiagnosticArea(
          "output_retention",
          () => repo.deleteByMethodLifetime(new Date(Date.now() - DAY_MS)),
        );

        assertEquals(result.deleted, 3);
        const enumeration = phaseAttributes(spans, "candidate_enumeration");
        assertEquals(enumeration["swamp.diagnostic.files"], 6);
        assertEquals(
          enumeration["swamp.diagnostic.scan_strategy"],
          "full_listing",
        );
        const scan = phaseAttributes(spans, "candidate_scan");
        assertEquals(scan["swamp.outcome"], "ok");
        assertEquals(scan["swamp.diagnostic.dry_run"], false);
        assertEquals(scan["swamp.diagnostic.considered"], 6);
        assertEquals(scan["swamp.diagnostic.eligible"], 3);
        assertEquals(scan["swamp.diagnostic.delete_attempted"], 3);
        assertEquals(scan["swamp.diagnostic.deleted"], 3);
        assertEquals(scan["swamp.diagnostic.failed"], 0);
        assertEquals(scan["swamp.diagnostic.protected_not_terminal"], 1);
        assertEquals(scan["swamp.diagnostic.skipped_recent_mtime"], 1);
        assertEquals(scan["swamp.diagnostic.skipped_not_expired"], 1);
        assertEquals(scan["swamp.diagnostic.stopped_at_limit"], false);
        assertEquals(
          scan["swamp.diagnostic.bytes_reclaimed"],
          result.bytesReclaimed,
        );
        for (
          const work of ["stat", "read", "parse", "remove", "dir_cleanup"]
        ) {
          assertEquals(
            typeof scan[`swamp.diagnostic.${work}_work_ms`],
            "number",
            work,
          );
        }
        assertEquals(diagnosticPhases(spans, "orphan_log_sweep").length, 1);
        // No phase carries a path.
        for (const span of spans) {
          for (const value of Object.values(span.attributes)) {
            assert(!String(value).includes(dir));
          }
        }
      });
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: a batch stopped at its limit reports it and skips the orphan sweep phase",
  async () => {
    await withTempDir(async (dir) => {
      await withObservedSpans(async (spans) => {
        const repo = new YamlOutputRepository(dir);
        await saveExpiredOutputs(repo, 3);
        const result = await withDiagnosticArea(
          "output_retention",
          () =>
            repo.deleteByMethodLifetime(new Date(Date.now() - DAY_MS), {
              limit: 1,
            }),
        );
        assertEquals(result.more, true);
        const scan = phaseAttributes(spans, "candidate_scan");
        assertEquals(scan["swamp.diagnostic.limit"], 1);
        assertEquals(scan["swamp.diagnostic.deleted"], 1);
        // The output that stopped the batch is not counted as eligible.
        assertEquals(scan["swamp.diagnostic.eligible"], 1);
        assertEquals(scan["swamp.diagnostic.considered"], 2);
        assertEquals(scan["swamp.diagnostic.stopped_at_limit"], true);
        assertEquals(diagnosticPhases(spans, "orphan_log_sweep").length, 0);
      });
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: an empty batch exports zero counts",
  async () => {
    await withTempDir(async (dir) => {
      await withObservedSpans(async (spans) => {
        const repo = new YamlOutputRepository(dir);
        await withDiagnosticArea(
          "output_retention",
          () => repo.deleteByMethodLifetime(new Date(Date.now() - DAY_MS)),
        );
        assertEquals(
          phaseAttributes(spans, "candidate_enumeration")[
            "swamp.diagnostic.files"
          ],
          0,
        );
        const scan = phaseAttributes(spans, "candidate_scan");
        for (const key of ["considered", "eligible", "deleted", "failed"]) {
          assertEquals(scan[`swamp.diagnostic.${key}`], 0, key);
        }
        assertEquals(scan["swamp.diagnostic.stat_work_ms"], undefined);
        const sweep = phaseAttributes(spans, "orphan_log_sweep");
        assertEquals(sweep["swamp.diagnostic.logs_listed"], 0);
      });
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: a batch that fails partway keeps the deletions that landed",
  async () => {
    await withTempDir(async (dir) => {
      await withObservedSpans(async (spans) => {
        const signalled = new Set<string>();
        let armed = false;
        const markDirty = (path?: string): Promise<void> => {
          if (armed && path?.endsWith(".yaml")) {
            signalled.add(path);
            if (signalled.size === 3) {
              return Promise.reject(new Error("datastore unavailable"));
            }
          }
          return Promise.resolve();
        };
        const repo = new YamlOutputRepository(dir, undefined, markDirty);
        await saveExpiredOutputs(repo, 4);
        armed = true;

        await assertRejects(
          () =>
            withDiagnosticArea(
              "output_retention",
              () => repo.deleteByMethodLifetime(new Date(Date.now() - DAY_MS)),
            ),
          Error,
          "datastore unavailable",
        );

        const scan = phaseAttributes(spans, "candidate_scan");
        assertEquals(scan["swamp.outcome"], "error");
        assertEquals(scan["swamp.diagnostic.delete_attempted"], 3);
        assertEquals(scan["swamp.diagnostic.deleted"], 2);
        assertEquals(scan["swamp.diagnostic.failed"], 1);
        assertEquals(diagnosticPhases(spans, "orphan_log_sweep").length, 0);
      });
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: a dry run counts what it would delete and removes nothing",
  async () => {
    await withTempDir(async (dir) => {
      await withObservedSpans(async (spans) => {
        const repo = new YamlOutputRepository(dir);
        const paths = await saveExpiredOutputs(repo, 2);
        await withDiagnosticArea(
          "output_retention",
          () =>
            repo.deleteByMethodLifetime(new Date(Date.now() - DAY_MS), {
              dryRun: true,
            }),
        );
        const scan = phaseAttributes(spans, "candidate_scan");
        assertEquals(scan["swamp.diagnostic.dry_run"], true);
        assertEquals(scan["swamp.diagnostic.deleted"], 2);
        assertEquals(scan["swamp.diagnostic.tombstone_work_ms"], undefined);
        for (const path of paths) assertEquals(await pathExists(path), true);
      });
    });
  },
);

Deno.test(
  "deleteByMethodLifetime: outside output retention it exports no phases",
  async () => {
    await withTempDir(async (dir) => {
      await withObservedSpans(async (spans) => {
        const repo = new YamlOutputRepository(dir);
        await saveExpiredOutputs(repo, 2);
        const result = await repo.deleteByMethodLifetime(
          new Date(Date.now() - DAY_MS),
        );
        assertEquals(result.deleted, 2);
        assertEquals(spans.length, 0);
      });
    });
  },
);

Deno.test("YamlOutputRepository: discovery and delete count their reads and measure removal into the running phase", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const definitionId = createDefinitionId(crypto.randomUUID());
    // One method each: records of one definition and method started in the
    // same millisecond would share a file name.
    const methods = ["create", "update", "sync"];
    const outputs = methods.map((methodName) =>
      ModelOutput.create({
        definitionId,
        methodName,
        provenance: defaultProvenance,
      })
    );
    for (const [i, output] of outputs.entries()) {
      await repo.save(testType, methods[i], output);
    }
    // Another definition's record of the same type is read too.
    await repo.save(
      testType,
      "create",
      ModelOutput.create({
        definitionId: createDefinitionId(crypto.randomUUID()),
        methodName: "create",
        provenance: defaultProvenance,
      }),
    );

    await withObservedSpans(async (spans) => {
      await withDiagnosticArea("worker_delete", async () => {
        const found = await observeDiagnosticPhase(
          "output_discovery",
          {},
          () => repo.findByDefinition(testType, definitionId),
        );
        assertEquals(found.length, 3);
        await observeDiagnosticPhase(
          "output_removal",
          {},
          () => repo.delete(testType, "create", outputs[0].id),
        );
      });
      const discovery = findSpan(spans, "swamp.diagnostic.output_discovery");
      assertEquals(discovery.attributes["swamp.diagnostic.files_read"], 4);
      assert(
        (discovery.attributes["swamp.diagnostic.bytes_read"] as number) > 0,
      );
      for (const work of ["read", "parse"]) {
        assertEquals(
          typeof discovery.attributes[`swamp.diagnostic.${work}_work_ms`],
          "number",
          work,
        );
      }
      const removal = findSpan(spans, "swamp.diagnostic.output_removal");
      // The create directory holds this record and the other definition's.
      const searched = removal.attributes[
        "swamp.diagnostic.search_files_read"
      ] as number;
      assert(searched >= 1 && searched <= 2);
      for (const work of ["search", "remove", "dir_cleanup", "tombstone"]) {
        assertEquals(
          typeof removal.attributes[`swamp.diagnostic.${work}_work_ms`],
          "number",
          work,
        );
      }
    });
    assertEquals(await repo.findById(testType, "create", outputs[0].id), null);
  });
});

Deno.test("YamlOutputRepository: reads outside a diagnostic area export nothing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "create",
      provenance: defaultProvenance,
    });
    await repo.save(testType, "create", output);
    await withObservedSpans(async (spans) => {
      await repo.findByDefinition(testType, output.definitionId);
      await repo.delete(testType, "create", output.id);
      assertEquals(spans.length, 0);
    });
  });
});

// --- Bounded history reads (swamp-club#4056) ---

/**
 * Runs `fn` counting the files it stats and reads. Patches the globals as
 * {@link withPhantomReadDirEntry} does: the walkers call them directly.
 */
async function countFileOps<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stats: string[]; reads: string[] }> {
  const stat = Deno.stat;
  const readTextFile = Deno.readTextFile;
  const stats: string[] = [];
  const reads: string[] = [];
  (Deno as { stat: typeof Deno.stat }).stat = (path) => {
    stats.push(String(path));
    return stat(path);
  };
  (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile = (
    path,
    options,
  ) => {
    reads.push(String(path));
    return readTextFile(path, options);
  };
  try {
    return { result: await fn(), stats, reads };
  } finally {
    (Deno as { stat: typeof Deno.stat }).stat = stat;
    (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
      readTextFile;
  }
}

/** Writes `output`'s record under `name` in its method directory. */
async function writeRecordAs(
  repo: YamlOutputRepository,
  output: ModelOutput,
  name: string,
): Promise<string> {
  const path = join(dirname(repo.getPath(registeredType, "run", output)), name);
  await ensureDir(dirname(path));
  await Deno.writeTextFile(
    path,
    stringifyYaml(JSON.parse(JSON.stringify(output.toData()))),
  );
  return path;
}

Deno.test(
  "findAllGlobalSince: skips a file named before the cutoff without a stat or read, however fresh its mtime",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      // Saved just now, so its mtime is fresh, as after a v3 replay.
      await makeOutput(repo, new Date(Date.now() - 7 * DAY_MS));
      const fresh = await makeOutput(repo, new Date());

      const { result, stats, reads } = await countFileOps(() =>
        repo.findAllGlobalSince(new Date(Date.now() - HOUR_MS))
      );

      assertEquals(result.map((r) => r.output.id), [fresh.id]);
      assertEquals(stats, []);
      assertEquals(reads, [repo.getPath(registeredType, "run", fresh)]);
    });
  },
);

Deno.test(
  "findAllGlobalSince: includes a record started exactly at the cutoff",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const cutoff = new Date(Date.now() - HOUR_MS);
      const atCutoff = await makeOutput(repo, cutoff);
      await makeOutput(repo, new Date(cutoff.getTime() - 1));

      const found = await repo.findAllGlobalSince(cutoff);

      assertEquals(found.map((r) => r.output.id), [atCutoff.id]);
    });
  },
);

Deno.test(
  "findAllGlobalSince: a name not in the output form falls back to its mtime, then its startedAt",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const old = new Date(Date.now() - 7 * DAY_MS);
      const cutoff = new Date(Date.now() - HOUR_MS);
      const record = (startedAt: Date) =>
        ModelOutput.create({
          definitionId: createDefinitionId(crypto.randomUUID()),
          methodName: "run",
          status: "succeeded",
          startedAt,
          provenance: defaultProvenance,
        });
      const oldMtime = await writeRecordAs(repo, record(old), "a.yaml");
      await Deno.utime(oldMtime, old, old);
      // Fresh mtime, old startedAt: read, then left out.
      await writeRecordAs(repo, record(old), "b.yaml");
      const recent = record(new Date());
      await writeRecordAs(repo, recent, "c.yaml");

      const { result, stats, reads } = await countFileOps(() =>
        repo.findAllGlobalSince(cutoff)
      );

      assertEquals(result.map((r) => r.output.id), [recent.id]);
      assertEquals(stats.length, 3);
      assertEquals(reads.length, 2);
    });
  },
);

Deno.test(
  "findAllGlobalSince: a record whose name is recent but whose startedAt is older than the cutoff is left out",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const old = ModelOutput.create({
        definitionId: createDefinitionId(crypto.randomUUID()),
        methodName: "run",
        status: "succeeded",
        startedAt: new Date(Date.now() - 7 * DAY_MS),
        provenance: defaultProvenance,
      });
      const recentName = basename(
        repo.getPath(
          registeredType,
          "run",
          ModelOutput.create({
            definitionId: old.definitionId,
            methodName: "run",
            startedAt: new Date(),
            provenance: defaultProvenance,
          }),
        ),
      );
      await writeRecordAs(repo, old, recentName);

      const found = await repo.findAllGlobalSince(
        new Date(Date.now() - HOUR_MS),
      );

      assertEquals(found, []);
    });
  },
);

Deno.test(
  "findAllGlobalSince: a cutoff outside years 0000-9999 skips no file by name",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const output = await makeOutput(repo, new Date());

      for (
        const [cutoff, expected] of [
          [new Date(Date.UTC(10000, 0, 1)), []],
          [new Date(Date.UTC(-1, 0, 1)), [output.id]],
        ] as const
      ) {
        const { result, reads } = await countFileOps(() =>
          repo.findAllGlobalSince(cutoff)
        );
        assertEquals(result.map((r) => r.output.id), [...expected]);
        assertEquals(reads.length, 1);
      }
    });
  },
);

Deno.test(
  "findAllGlobalSince: counts the scan into the running output_search phase, with no paths",
  async () => {
    await withTempDir(async (dir) => {
      await withObservedSpans(async (spans) => {
        const repo = new YamlOutputRepository(dir);
        await makeOutput(repo, new Date(Date.now() - 7 * DAY_MS));
        await makeOutput(repo, new Date(Date.now() - 8 * DAY_MS));
        await makeOutput(repo, new Date());

        await withDiagnosticArea(
          "output_search",
          () =>
            observeDiagnosticPhase(
              "candidate_scan",
              {},
              () => repo.findAllGlobalSince(new Date(Date.now() - DAY_MS)),
            ),
        );

        const scan = phaseAttributes(spans, "candidate_scan");
        assertEquals(scan["swamp.diagnostic.area"], "output_search");
        assertEquals(scan["swamp.diagnostic.entries"], 3);
        assertEquals(scan["swamp.diagnostic.skipped_by_name"], 2);
        assertEquals(scan["swamp.diagnostic.files_read"], 1);
        assertEquals(scan["swamp.diagnostic.stats"], undefined);
        assertEquals(scan["swamp.diagnostic.method_dirs"], 1);
        assert(Number(scan["swamp.diagnostic.type_dirs"]) >= 1);
        assert(Number(scan["swamp.diagnostic.bytes_read"]) > 0);
        for (const span of spans) {
          for (const value of Object.values(span.attributes)) {
            assert(!String(value).includes(dir));
          }
        }
      });
    });
  },
);

Deno.test(
  "findHistoryByDefinition: reads only files named for the definition, and names not in the output form",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const definitionId = createDefinitionId(crypto.randomUUID());
      const mine = (startedAt: Date) =>
        ModelOutput.create({
          definitionId,
          methodName: "run",
          status: "succeeded",
          startedAt,
          provenance: defaultProvenance,
        });
      const first = mine(new Date(Date.now() - DAY_MS));
      const second = mine(new Date());
      await repo.save(registeredType, "run", first);
      await repo.save(registeredType, "run", second);
      const other = await makeOutput(repo, new Date());
      const unnamed = mine(new Date(Date.now() - HOUR_MS));
      await writeRecordAs(repo, unnamed, "unnamed.yaml");

      const { result, reads } = await countFileOps(() =>
        repo.findHistoryByDefinition(registeredType, definitionId)
      );

      assertEquals(
        result.map((o) => o.id).sort(),
        [first.id, second.id, unnamed.id].sort(),
      );
      assertEquals(reads.length, 3);
      assert(!reads.includes(repo.getPath(registeredType, "run", other)));
    });
  },
);

Deno.test(
  "findByDefinition: still finds a record whose file is named for another definition",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const definitionId = createDefinitionId(crypto.randomUUID());
      const output = ModelOutput.create({
        definitionId,
        methodName: "run",
        status: "succeeded",
        startedAt: new Date(),
        provenance: defaultProvenance,
      });
      const misnamed = basename(repo.getPath(registeredType, "run", output))
        .replace(definitionId, crypto.randomUUID());
      await writeRecordAs(repo, output, misnamed);

      const all = await repo.findByDefinition(registeredType, definitionId);
      const history = await repo.findHistoryByDefinition(
        registeredType,
        definitionId,
      );

      // Deleting a model reads its outputs this way, so it still finds this.
      assertEquals(all.map((o) => o.id), [output.id]);
      assertEquals(history, []);
    });
  },
);

/** An output of `definitionId` started at `startedAt`, not saved. */
function historyOutput(
  definitionId: DefinitionId,
  startedAt: Date,
): ModelOutput {
  return ModelOutput.create({
    definitionId,
    methodName: "run",
    status: "succeeded",
    startedAt,
    provenance: defaultProvenance,
  });
}

Deno.test(
  "findHistoryByDefinition: with since, skips a file named before it without a stat or read, and keeps one started exactly at it",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const definitionId = createDefinitionId(crypto.randomUUID());
      const since = new Date(Date.now() - HOUR_MS);
      const before = historyOutput(
        definitionId,
        new Date(since.getTime() - 1),
      );
      const atSince = historyOutput(definitionId, since);
      const recent = historyOutput(definitionId, new Date());
      // Saved just now, so every mtime is fresh, as after a v3 replay.
      for (const output of [before, atSince, recent]) {
        await repo.save(registeredType, "run", output);
      }

      const { result, stats, reads } = await countFileOps(() =>
        repo.findHistoryByDefinition(registeredType, definitionId, { since })
      );

      assertEquals(
        result.map((o) => o.id).sort(),
        [atSince.id, recent.id].sort(),
      );
      assertEquals(stats, []);
      assertEquals(reads.length, 2);
      assert(!reads.includes(repo.getPath(registeredType, "run", before)));
    });
  },
);

Deno.test(
  "findHistoryByDefinition: with until, skips a file named at or after it without a read, and keeps one started just before it",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const definitionId = createDefinitionId(crypto.randomUUID());
      const until = new Date(Date.now() - HOUR_MS);
      const justBefore = historyOutput(
        definitionId,
        new Date(until.getTime() - 1),
      );
      const atUntil = historyOutput(definitionId, until);
      const recent = historyOutput(definitionId, new Date());
      const old = historyOutput(
        definitionId,
        new Date(Date.now() - 7 * DAY_MS),
      );
      for (const output of [justBefore, atUntil, recent, old]) {
        await repo.save(registeredType, "run", output);
      }
      const since = new Date(Date.now() - 2 * HOUR_MS);

      const untilOnly = await countFileOps(() =>
        repo.findHistoryByDefinition(registeredType, definitionId, { until })
      );
      const both = await countFileOps(() =>
        repo.findHistoryByDefinition(registeredType, definitionId, {
          since,
          until,
        })
      );

      assertEquals(
        untilOnly.result.map((o) => o.id).sort(),
        [justBefore.id, old.id].sort(),
      );
      assertEquals(untilOnly.reads.length, 2);
      assertEquals(both.result.map((o) => o.id), [justBefore.id]);
      assertEquals(both.reads, [
        repo.getPath(registeredType, "run", justBefore),
      ]);
    });
  },
);

Deno.test(
  "findHistoryByDefinition: with a window, a name not in the output form falls back to its mtime for since, and is read for until",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const definitionId = createDefinitionId(crypto.randomUUID());
      const old = new Date(Date.now() - 7 * DAY_MS);
      const since = new Date(Date.now() - HOUR_MS);
      const oldMtime = await writeRecordAs(
        repo,
        historyOutput(definitionId, old),
        "a.yaml",
      );
      await Deno.utime(oldMtime, old, old);
      // Fresh mtime, old startedAt: read, then left out.
      await writeRecordAs(repo, historyOutput(definitionId, old), "b.yaml");
      const recent = historyOutput(definitionId, new Date());
      await writeRecordAs(repo, recent, "c.yaml");

      const withSince = await countFileOps(() =>
        repo.findHistoryByDefinition(registeredType, definitionId, { since })
      );
      const withUntil = await countFileOps(() =>
        repo.findHistoryByDefinition(registeredType, definitionId, {
          until: since,
        })
      );

      assertEquals(withSince.result.map((o) => o.id), [recent.id]);
      assertEquals(withSince.stats.length, 3);
      assertEquals(withSince.reads.length, 2);
      // An mtime says nothing about until: every such file is read.
      assertEquals(withUntil.result.length, 2);
      assertEquals(withUntil.stats, []);
      assertEquals(withUntil.reads.length, 3);
    });
  },
);

Deno.test(
  "findHistoryByDefinition: a window bound outside years 0000-9999 skips no file by name",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const definitionId = createDefinitionId(crypto.randomUUID());
      const output = historyOutput(definitionId, new Date());
      await repo.save(registeredType, "run", output);

      for (
        const [window, expected] of [
          [{ until: new Date(Date.UTC(10000, 0, 1)) }, [output.id]],
          [{ since: new Date(Date.UTC(-1, 0, 1)) }, [output.id]],
          [{ since: new Date(Date.UTC(10000, 0, 1)) }, []],
        ] as const
      ) {
        const { result, reads } = await countFileOps(() =>
          repo.findHistoryByDefinition(registeredType, definitionId, window)
        );
        assertEquals(result.map((o) => o.id), [...expected]);
        assertEquals(reads.length, 1);
      }
    });
  },
);

Deno.test(
  "findHistoryByDefinition: with a window, warns only about the definition's unreadable outputs named inside it",
  async () => {
    await withTempDir(async (dir) => {
      const definitionId = crypto.randomUUID();
      const { repo, paths } = repoWithUnreadable(dir, [
        {
          type: registeredType,
          method: "run",
          output: outputAt(definitionId, "2020-01-01T00:00:00Z"),
        },
        {
          type: registeredType,
          method: "run",
          output: outputAt(definitionId, "2025-06-01T00:00:00Z"),
        },
        {
          type: registeredType,
          method: "run",
          output: outputAt(definitionId, "2030-01-01T00:00:00Z"),
        },
        {
          type: registeredType,
          method: "run",
          output: outputAt(crypto.randomUUID(), "2025-06-01T00:00:00Z"),
        },
      ]);

      const warnings = await captureUnreadableWarnings(async () => {
        await repo.findHistoryByDefinition(
          registeredType,
          createDefinitionId(definitionId),
          {
            since: new Date("2025-01-01T00:00:00Z"),
            until: new Date("2026-01-01T00:00:00Z"),
          },
        );
      });

      assertEquals(warnings.length, 1, warnings.join("\n"));
      assertStringIncludes(warnings[0], paths[1]);
      for (const leftOut of [paths[0], paths[2], paths[3]]) {
        assert(!warnings[0].includes(leftOut), warnings[0]);
      }
    });
  },
);

/** Runs `fn` tracking the most reads of `Deno.readTextFile` in flight at once. */
async function trackReads<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; maxInFlight: number }> {
  const readTextFile = Deno.readTextFile;
  let inFlight = 0;
  let maxInFlight = 0;
  (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile = async (
    path,
    options,
  ) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // A macrotask, so concurrent reads overlap even on a fast disk.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return await readTextFile(path, options);
    } finally {
      inFlight--;
    }
  };
  try {
    return { result: await fn(), maxInFlight };
  } finally {
    (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
      readTextFile;
  }
}

Deno.test(
  "findAllGlobalSince: reads at most 16 records at once and returns them in walk order",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const startedAt = new Date();
      for (const method of ["c", "a", "b"]) {
        for (let i = 0; i < 20; i++) {
          const output = ModelOutput.create({
            definitionId: createDefinitionId(crypto.randomUUID()),
            methodName: method,
            status: "succeeded",
            startedAt: new Date(startedAt.getTime() - i),
            provenance: defaultProvenance,
          });
          await repo.save(registeredType, method, output);
        }
      }
      // A sequential walk: methods, then file names, each sorted.
      const expected: string[] = [];
      for (const method of ["a", "b", "c"]) {
        const methodDir = join(
          dir,
          ".swamp",
          "outputs",
          registeredType.normalized,
          method,
        );
        const names = [...Deno.readDirSync(methodDir)].map((e) => e.name)
          .sort();
        for (const name of names) {
          const data = parseYaml(
            await Deno.readTextFile(join(methodDir, name)),
          ) as ModelOutputData;
          expected.push(data.id);
        }
      }

      const { result, maxInFlight } = await trackReads(() =>
        repo.findAllGlobalSince(new Date(startedAt.getTime() - HOUR_MS))
      );

      assertEquals(result.map((r) => r.output.id), expected);
      // Bounded, and concurrent: how many overlap depends on timing.
      assert(maxInFlight <= 16, `${maxInFlight} reads in flight`);
      assert(maxInFlight > 1, `${maxInFlight} reads in flight`);
    });
  },
);

Deno.test(
  "findAllGlobalSince: an I/O error on one read fails the scan once every started read has settled",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      for (let i = 0; i < 40; i++) {
        await makeOutput(repo, new Date(Date.now() - i));
      }
      const methodDir = join(
        dir,
        ".swamp",
        "outputs",
        registeredType.normalized,
        "run",
      );
      // The first file the walk reads.
      const failing = join(
        methodDir,
        [...Deno.readDirSync(methodDir)].map((e) => e.name).sort()[0],
      );
      const readTextFile = Deno.readTextFile;
      let started = 0;
      let inFlight = 0;
      (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
        async (path, options) => {
          started++;
          inFlight++;
          try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (String(path) === failing) {
              throw Object.assign(
                new Error("Permission denied (os error 13)"),
                { code: "EACCES" },
              );
            }
            return await readTextFile(path, options);
          } finally {
            inFlight--;
          }
        };
      try {
        await assertRejects(
          () => repo.findAllGlobalSince(new Date(Date.now() - HOUR_MS)),
          Error,
          "Permission denied",
        );
        assertEquals(inFlight, 0);
        // The reads started with it, and none after it failed.
        assert(started <= 16, `${started} reads started`);
      } finally {
        (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
          readTextFile;
      }
    });
  },
);

Deno.test(
  "findAll: reads at most 16 records at once and returns them in walk order",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const startedAt = new Date();
      for (const method of ["c", "a", "b"]) {
        for (let i = 0; i < 20; i++) {
          await repo.save(
            registeredType,
            method,
            ModelOutput.create({
              definitionId: createDefinitionId(crypto.randomUUID()),
              methodName: method,
              status: "succeeded",
              startedAt: new Date(startedAt.getTime() - i),
              provenance: defaultProvenance,
            }),
          );
        }
      }
      // A sequential walk: methods, then file names, each sorted.
      const expected: string[] = [];
      for (const method of ["a", "b", "c"]) {
        const methodDir = join(
          dir,
          ".swamp",
          "outputs",
          registeredType.normalized,
          method,
        );
        const names = [...Deno.readDirSync(methodDir)].map((e) => e.name)
          .sort();
        for (const name of names) {
          const data = parseYaml(
            await Deno.readTextFile(join(methodDir, name)),
          ) as ModelOutputData;
          expected.push(data.id);
        }
      }

      const { result, maxInFlight } = await trackReads(() =>
        repo.findAll(registeredType)
      );

      assertEquals(result.map((o) => o.id), expected);
      // Bounded, and concurrent: how many overlap depends on timing.
      assert(maxInFlight <= 16, `${maxInFlight} reads in flight`);
      assert(maxInFlight > 1, `${maxInFlight} reads in flight`);
    });
  },
);

Deno.test(
  "per-type listings: an I/O error on one read fails findAll, findByDefinition and findHistoryByDefinition once every started read has settled",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const definitionId = createDefinitionId(crypto.randomUUID());
      for (let i = 0; i < 40; i++) {
        await repo.save(
          registeredType,
          "run",
          historyOutput(definitionId, new Date(Date.now() - i)),
        );
      }
      const methodDir = join(
        dir,
        ".swamp",
        "outputs",
        registeredType.normalized,
        "run",
      );
      // The first file the walk reads.
      const failing = join(
        methodDir,
        [...Deno.readDirSync(methodDir)].map((e) => e.name).sort()[0],
      );
      const readTextFile = Deno.readTextFile;
      let started = 0;
      let inFlight = 0;
      (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
        async (path, options) => {
          started++;
          inFlight++;
          try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (String(path) === failing) {
              throw Object.assign(
                new Error("Permission denied (os error 13)"),
                { code: "EACCES" },
              );
            }
            return await readTextFile(path, options);
          } finally {
            inFlight--;
          }
        };
      try {
        for (
          const [name, list] of [
            ["findAll", () => repo.findAll(registeredType)],
            [
              "findByDefinition",
              () => repo.findByDefinition(registeredType, definitionId),
            ],
            [
              "findHistoryByDefinition",
              () => repo.findHistoryByDefinition(registeredType, definitionId),
            ],
          ] as const
        ) {
          started = 0;
          await assertRejects(list, Error, "Permission denied");
          assertEquals(inFlight, 0, name);
          // The reads started with it, and none after it failed.
          assert(started <= 16, `${name}: ${started} reads started`);
        }
      } finally {
        (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
          readTextFile;
      }
    });
  },
);

Deno.test(
  "per-type listings: an I/O error listing one method directory fails findAll, findByDefinition and findHistoryByDefinition",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const definitionId = createDefinitionId(crypto.randomUUID());
      for (let i = 0; i < 20; i++) {
        await repo.save(
          registeredType,
          `m${String(i).padStart(2, "0")}`,
          historyOutput(definitionId, new Date(Date.now() - i)),
        );
      }
      const failing = join(
        dir,
        ".swamp",
        "outputs",
        registeredType.normalized,
        "m03",
      );
      const readDir = Deno.readDir;
      (Deno as { readDir: typeof Deno.readDir }).readDir = (path) => {
        if (String(path) !== failing) return readDir(path);
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.reject(
                Object.assign(
                  new Error("Permission denied (os error 13)"),
                  { code: "EACCES" },
                ),
              ),
          }),
        };
      };
      try {
        for (
          const list of [
            () => repo.findAll(registeredType),
            () => repo.findByDefinition(registeredType, definitionId),
            () => repo.findHistoryByDefinition(registeredType, definitionId),
          ]
        ) {
          await assertRejects(list, Error, "Permission denied");
        }
      } finally {
        (Deno as { readDir: typeof Deno.readDir }).readDir = readDir;
      }
    });
  },
);

Deno.test(
  "scans running at once keep at most 16 directories and files open between them",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const definitionId = createDefinitionId(crypto.randomUUID());
      for (const method of ["a", "b", "c"]) {
        for (let i = 0; i < 40; i++) {
          await repo.save(
            registeredType,
            method,
            historyOutput(definitionId, new Date(Date.now() - i)),
          );
        }
      }
      const readTextFile = Deno.readTextFile;
      const readDir = Deno.readDir;
      let open = 0;
      let peak = 0;
      const opened = () => {
        open++;
        peak = Math.max(peak, open);
      };
      (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
        async (path, options) => {
          if (!String(path).startsWith(dir)) {
            return await readTextFile(path, options);
          }
          opened();
          try {
            // A macrotask, so concurrent reads overlap even on a fast disk.
            await new Promise((resolve) => setTimeout(resolve, 0));
            return await readTextFile(path, options);
          } finally {
            open--;
          }
        };
      (Deno as { readDir: typeof Deno.readDir }).readDir = (path) => {
        if (!String(path).startsWith(dir)) return readDir(path);
        return (async function* () {
          opened();
          try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            yield* readDir(path);
          } finally {
            open--;
          }
        })();
      };
      const since = new Date(Date.now() - HOUR_MS);
      try {
        await Promise.all([
          ...Array.from(
            { length: 4 },
            () => repo.findHistoryByDefinition(registeredType, definitionId),
          ),
          ...Array.from(
            { length: 4 },
            () =>
              repo.findHistoryByDefinition(registeredType, definitionId, {
                since,
              }),
          ),
          repo.findAllGlobalSince(since),
          repo.findAllGlobalSince(since),
          repo.findAll(registeredType),
          repo.findByDefinition(registeredType, definitionId),
        ]);
      } finally {
        (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
          readTextFile;
        (Deno as { readDir: typeof Deno.readDir }).readDir = readDir;
      }
      assertEquals(open, 0);
      // Bounded across the scans, and concurrent: how many overlap depends
      // on timing (192 were open at once with a bound per scan).
      assert(peak <= 16, `${peak} open at once`);
      assert(peak > 1, `${peak} open at once`);
    });
  },
);

/** Saves `count` outputs of `definitionId`, a millisecond apart. */
async function saveHistory(
  repo: YamlOutputRepository,
  definitionId: DefinitionId,
  count: number,
): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    await repo.save(
      registeredType,
      "run",
      historyOutput(definitionId, new Date(now - i)),
    );
  }
}

/** Reads of `Deno.readTextFile` that {@link withHeldReads} controls. */
interface HeldReads {
  /** Reads started so far, held or not. */
  readonly started: number;
  /** Reads started and not yet settled. */
  readonly inFlight: number;
  /** Reads started so far of a file under `dir`. */
  startedUnder(dir: string): number;
  /** Holds every read started from now on until the next release. */
  hold(): void;
  /** Settles every held read, and lets reads started after it through. */
  release(): void;
}

/**
 * Runs `fn` with `Deno.readTextFile` replaced by one that holds reads open
 * while told to, so a test decides which scans hold the shared scan permits
 * (swamp-club#4070). Reads pass through until `hold`. Every held read is
 * released, and the original restored, however `fn` ends, so no permit
 * outlives the test.
 */
async function withHeldReads<T>(
  fn: (reads: HeldReads) => Promise<T>,
): Promise<T> {
  const readTextFile = Deno.readTextFile;
  let holding = false;
  let gate = Promise.withResolvers<void>();
  const paths: string[] = [];
  let inFlight = 0;
  const reads: HeldReads = {
    get started() {
      return paths.length;
    },
    get inFlight() {
      return inFlight;
    },
    startedUnder: (dir) =>
      paths.filter((path) => path.startsWith(dir + SEPARATOR)).length,
    hold: () => {
      holding = true;
      gate = Promise.withResolvers<void>();
    },
    release: () => {
      holding = false;
      gate.resolve();
    },
  };
  (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile = async (
    path,
    options,
  ) => {
    paths.push(String(path));
    inFlight++;
    try {
      if (holding) await gate.promise;
      return await readTextFile(path, options);
    } finally {
      inFlight--;
    }
  };
  try {
    return await fn(reads);
  } finally {
    reads.release();
    (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
      readTextFile;
  }
}

/**
 * Asserts every shared scan permit is free: a scan of 16 records gets all 16
 * of its reads in flight at once. A permit a scan kept would leave it at 15.
 */
async function assertScanPermitsFree(reads: HeldReads): Promise<void> {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const definitionId = createDefinitionId(crypto.randomUUID());
    await saveHistory(repo, definitionId, 16);
    reads.hold();
    const scan = repo.findHistoryByDefinition(registeredType, definitionId);
    let found: ModelOutput[];
    try {
      await waitFor(() => reads.inFlight === 16, "16 reads in flight");
    } finally {
      reads.release();
      found = await scan;
    }
    assertEquals(found.length, 16);
  });
}

/** Runs `fn` and returns the warnings the output repository logged. */
async function captureOutputRepoWarnings(
  fn: () => Promise<void>,
): Promise<string[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["output-repo"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records.map((record) => record.message.map(String).join(""));
}

Deno.test(
  "findHistoryByDefinition: a scan aborted while it waits for a permit rejects with the reason and reads nothing, and the scan queued behind it gets its permits",
  async () => {
    await withTempDir(async (dir) => {
      const holder = new YamlOutputRepository(join(dir, "holder"));
      const aborted = new YamlOutputRepository(join(dir, "aborted"));
      const behind = new YamlOutputRepository(join(dir, "behind"));
      const holderId = createDefinitionId(crypto.randomUUID());
      const abortedId = createDefinitionId(crypto.randomUUID());
      const behindId = createDefinitionId(crypto.randomUUID());
      await saveHistory(holder, holderId, 16);
      await saveHistory(aborted, abortedId, 3);
      await saveHistory(behind, behindId, 3);

      await withHeldReads(async (reads) => {
        reads.hold();
        const holding = holder.findHistoryByDefinition(
          registeredType,
          holderId,
        );
        await waitFor(() => reads.inFlight === 16, "the holder's 16 reads");

        const controller = new AbortController();
        const reason = new DOMException("request cancelled", "AbortError");
        // Each joins the permit queue before its call returns: the history
        // scan asks for its first listing's permit without awaiting first.
        const abortedScan = aborted.findHistoryByDefinition(
          registeredType,
          abortedId,
          undefined,
          controller.signal,
        );
        const behindScan = behind.findHistoryByDefinition(
          registeredType,
          behindId,
        );
        let settled = false;
        const abortedOutcome = assertRejects(() => abortedScan).finally(() => {
          settled = true;
        });
        controller.abort(reason);
        // While every permit is still held: a scan that stayed in the queue
        // would only settle once one is released.
        await waitFor(() => settled, "the aborted scan to reject");
        assertEquals(await abortedOutcome, reason);

        reads.release();
        assertEquals((await holding).length, 16);
        assertEquals((await behindScan).length, 3);
        assertEquals(reads.startedUnder(join(dir, "aborted")), 0);
        await assertScanPermitsFree(reads);
      });
    });
  },
);

Deno.test(
  "findAllGlobalSince: a scan aborted while it holds permits gives them back, starts no read after the abort, and logs no unreadable record",
  async () => {
    await withTempDir(async (dir) => {
      const holder = new YamlOutputRepository(join(dir, "holder"));
      const scanned = new YamlOutputRepository(join(dir, "scanned"));
      const holderId = createDefinitionId(crypto.randomUUID());
      await saveHistory(holder, holderId, 8);
      await saveHistory(
        scanned,
        createDefinitionId(crypto.randomUUID()),
        20,
      );

      await withHeldReads(async (reads) => {
        const warnings = await captureOutputRepoWarnings(async () => {
          reads.hold();
          const holding = holder.findHistoryByDefinition(
            registeredType,
            holderId,
          );
          await waitFor(() => reads.inFlight === 8, "the holder's 8 reads");

          const controller = new AbortController();
          const reason = new DOMException("request cancelled", "AbortError");
          const scan = scanned.findAllGlobalSince(
            new Date(Date.now() - HOUR_MS),
            controller.signal,
          );
          // Eight of its reads hold the other permits; the rest of its
          // reads wait for one.
          await waitFor(() => reads.inFlight === 16, "the scan's 8 reads");
          const startedAtAbort = reads.started;
          controller.abort(reason);

          reads.release();
          assertEquals(await assertRejects(() => scan), reason);
          assertEquals((await holding).length, 8);
          assertEquals(reads.started, startedAtAbort);
          assertEquals(reads.inFlight, 0);
        });
        assertEquals(
          warnings.filter((warning) =>
            warning.includes("Skipping unreadable output record")
          ),
          [],
        );
        await assertScanPermitsFree(reads);
      });
    });
  },
);

Deno.test(
  "findHistoryByDefinition: a scan aborted after it took a free permit, before it used it, gives the permit back",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      const definitionId = createDefinitionId(crypto.randomUUID());
      await saveHistory(repo, definitionId, 3);

      await withHeldReads(async (reads) => {
        const controller = new AbortController();
        const reason = new DOMException("request cancelled", "AbortError");
        // The scan takes a free permit for its first listing before this
        // call returns, and the abort lands before that permit is used.
        const scan = repo.findHistoryByDefinition(
          registeredType,
          definitionId,
          undefined,
          controller.signal,
        );
        controller.abort(reason);
        assertEquals(await assertRejects(() => scan), reason);
        assertEquals(reads.started, 0);
        await assertScanPermitsFree(reads);
      });
    });
  },
);

Deno.test(
  "findAllGlobal: a cancelled scan rejects with the reason and reads nothing",
  async () => {
    await withTempDir(async (dir) => {
      const repo = new YamlOutputRepository(dir);
      await saveHistory(repo, createDefinitionId(crypto.randomUUID()), 3);

      await withHeldReads(async (reads) => {
        const controller = new AbortController();
        const reason = new DOMException("request cancelled", "AbortError");
        controller.abort(reason);
        assertEquals(
          await assertRejects(() => repo.findAllGlobal(controller.signal)),
          reason,
        );
        assertEquals(reads.started, 0);
        await assertScanPermitsFree(reads);
      });
    });
  },
);
