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

import "../src/domain/models/models.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { configure, type LogRecord } from "@logtape/logtape";
import { createRecordingSyncService } from "@swamp-club/swamp-testing";
import { buildMarkDirtyHook } from "../src/cli/repo_context.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  createLibSwampContext,
  createModelDeleteDeps,
  modelDelete,
} from "../src/libswamp/mod.ts";
import type { LibSwampContext } from "../src/libswamp/mod.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { repoUnitOfWorkFactory } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { signalChange } from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import {
  unscopedWriterKey,
  withUnscopedWriteGuard,
} from "./unscoped_write_guard.ts";

await initializeLogging({});

const TYPE = ModelType.create("command/shell");

interface Fixture {
  repoDir: string;
  datastoreResolver: DefaultDatastorePathResolver;
  repoContext: RepositoryContext;
  marks: Array<string | undefined>;
}

/** A repository context over a recording hook, with one saved model. */
async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  const repoDir = join(dir, "repo");
  const cacheRoot = join(dir, "cache");
  await ensureDir(repoDir);
  await ensureDir(cacheRoot);
  const { service, marks } = createRecordingSyncService();
  const datastoreResolver = new DefaultDatastorePathResolver(repoDir, {
    type: "@test/remote",
    config: {},
    datastorePath: join(dir, "remote"),
    cachePath: cacheRoot,
  });
  const repoContext = createRepositoryContext({
    repoDir,
    enableIndexing: false,
    datastoreResolver,
    markDirty: buildMarkDirtyHook(service, cacheRoot, repoDir),
  });
  try {
    await repoContext.definitionRepo.save(
      TYPE,
      Definition.create({ name: "guard-probe", globalArguments: {} }),
    );
    await fn({ repoDir, datastoreResolver, repoContext, marks });
  } finally {
    repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/**
 * Deletes the probe model through the modelDelete use case, returning the
 * error message its stream yielded, if any. The use case catches a thrown
 * write error and yields it, as production does.
 */
async function deleteProbe(
  fx: Fixture,
  ctx: LibSwampContext,
): Promise<string | undefined> {
  const deps = createModelDeleteDeps(
    fx.repoDir,
    fx.datastoreResolver,
    fx.repoContext.unifiedDataRepo,
    fx.repoContext.markDirty,
    fx.repoContext.definitionRepo,
  );
  for await (
    const event of modelDelete(ctx, deps, {
      modelIdOrName: "guard-probe",
      force: true,
    })
  ) {
    if (event.kind === "error") return event.error.message;
  }
  return undefined;
}

Deno.test("withUnscopedWriteGuard: ignores route-2 writes made from test code", async () => {
  const marks: Array<string | undefined> = [];
  await withUnscopedWriteGuard(async () => {
    await signalChange((path) => {
      marks.push(path);
      return Promise.resolve();
    }, { kind: "write", path: "data/a" });
  });
  assertEquals(marks, ["data/a"]);
});

Deno.test("withUnscopedWriteGuard: fails on a route-2 write from production code, even when the error is caught and yielded", async () => {
  await withFixture(async (fx) => {
    const error = await assertRejects(() =>
      withUnscopedWriteGuard(async () => {
        // A context without a unit factory: the use case's unit binds to
        // nothing, so its writes take route 2.
        const yielded = await deleteProbe(fx, createLibSwampContext());
        assertStringIncludes(yielded ?? "", "route 2");
      })
    );
    assertStringIncludes(String(error), "src/libswamp/models/delete.ts");
  });
});

Deno.test("withUnscopedWriteGuard: passes when the production write runs in a unit bound to the hook", async () => {
  await withFixture(async (fx) => {
    await withUnscopedWriteGuard(async () => {
      const ctx = createLibSwampContext({
        openUnitOfWork: repoUnitOfWorkFactory(fx.repoContext),
      });
      assertEquals(await deleteProbe(fx, ctx), undefined);
    });
  });
});

Deno.test("withUnscopedWriteGuard: an inner guard runs inside the outer one", async () => {
  assertEquals(
    await withUnscopedWriteGuard(() =>
      withUnscopedWriteGuard(() => Promise.resolve(7))
    ),
    7,
  );
});

Deno.test("unscopedWriterKey: keys production callers by file and function only", () => {
  assertEquals(
    unscopedWriterKey({
      file: "src/serve/bookkeeping_gc.ts",
      line: 256,
      fn: "reapBatch",
    }),
    "src/serve/bookkeeping_gc.ts: reapBatch",
  );
  assertEquals(
    unscopedWriterKey({ file: "src/cli/x.ts", line: 1, fn: undefined }),
    "src/cli/x.ts: <anonymous>",
  );
  assertEquals(
    unscopedWriterKey({ file: "integration/x.ts", line: 1, fn: "save" }),
    undefined,
  );
  assertEquals(
    unscopedWriterKey({ file: "src/serve/x_test.ts", line: 1, fn: "f" }),
    undefined,
  );
  assertEquals(unscopedWriterKey(undefined), undefined);
});

/** Every warning logged while `fn` runs, rendered. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [
      { category: [], lowestLevel: "warning", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await initializeLogging({ _reset: true });
  }
  return captured.map((record) =>
    record.message.map((part) => String(part)).join("")
  );
}

Deno.test("signalChange: in production, route 2 warns once per call site and names the caller", async () => {
  const marks: Array<string | undefined> = [];
  const hook = (path?: string) => {
    marks.push(path);
    return Promise.resolve();
  };
  const warnings = await captureWarnings(async () => {
    for (const path of ["data/a", "data/b"]) {
      await signalChange(hook, { kind: "write", path });
    }
    await signalChange(hook, { kind: "remove", path: "data/c" });
  });
  assertEquals(marks, ["data/a", "data/b", "data/c"]);
  assertEquals(warnings.length, 2);
  for (const warning of warnings) {
    assertStringIncludes(warning, "integration/unscoped_write_guard_test.ts:");
    assertStringIncludes(warning, "outside a unit of work");
  }
  assertStringIncludes(warnings[0], "data/a");
  assertStringIncludes(warnings[1], "remove");
});
