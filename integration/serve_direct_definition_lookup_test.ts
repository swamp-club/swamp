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
 * Serve's direct-type steps resolved through the real wiring: a repository
 * answering global names through the definition index serve keeps
 * (swamp-club#4037), serve's lookup and save deps, and
 * resolveOrCreateDefinition's creation lock. Concurrent new names create
 * one definition each without reading a stored definition again, and the
 * global lookup's semantics hold: a definition shadows an auto-definition,
 * a name taken by another type is refused, and other writers are seen.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { z } from "zod";
import type { DefinitionId } from "../src/domain/definitions/definition.ts";
import type { ModelDefinition } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { findDefinitionByIdOrName } from "../src/domain/models/model_lookup.ts";
import {
  type DirectExecutionResult,
  resolveOrCreateDefinition,
} from "../src/libswamp/models/direct_execution.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import {
  type DefinitionFileSource,
  DefinitionIdIndex,
} from "../src/infrastructure/persistence/definition_id_index.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

const STORED = 200;
const RUNNER = ModelType.create("test/runner");
const OLD = new Date(Date.UTC(2020, 0, 1));

const runnerModel = {
  type: RUNNER.normalized,
  version: "2026.01.01.1",
  globalArguments: undefined,
  methods: {
    run: {
      description: "Test method",
      arguments: z.object({}),
      execute: () => Promise.resolve({ dataHandles: [] }),
    },
  },
} as unknown as ModelDefinition;

/** Writes a definition as another writer would: a new file renamed in. */
async function writeDefinition(
  path: string,
  name: string,
  type: string,
  id: string = crypto.randomUUID(),
): Promise<string> {
  await ensureDir(join(path, ".."));
  await Deno.writeTextFile(
    `${path}.tmp`,
    `type: ${type}\nid: ${id}\nname: ${name}\nversion: 1\ntags: {}\nglobalArguments: {}\nmethods: {}\n`,
  );
  await Deno.rename(`${path}.tmp`, path);
  return id;
}

/** Dates every file and directory under `dir` long ago. */
async function settle(dir: string): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) await settle(path);
    await Deno.utime(path, OLD, OLD);
  }
  await Deno.utime(dir, OLD, OLD);
}

/**
 * Serve's wiring of a direct-type step over `ctx` (src/serve/deps.ts), with
 * the definition index serve attaches as it starts, reading files through a
 * source that records each path read.
 */
function serveWiring(
  repoDir: string,
  ctx: RepositoryContext,
  clockAheadMs: number,
) {
  const reads: string[] = [];
  const repo = ctx.definitionRepo;
  const source: DefinitionFileSource = {
    definitionRoots: () => repo.definitionRoots(),
    readDefinitionFile: (path, segments, isSymlink) => {
      reads.push(path);
      return repo.readDefinitionFile(path, segments, isSymlink);
    },
  };
  repo.useNameIndex(
    new DefinitionIdIndex(source, { now: () => Date.now() + clockAheadMs }),
  );
  const autoDefRepo = new YamlDefinitionRepository(
    repoDir,
    ctx.eventBus,
    ctx.autoDefinitionsDir,
    false,
    ctx.markDirty,
  );
  const deps = {
    lookupDefinition: (name: string) => findDefinitionByIdOrName(repo, name),
    getModelDef: () => runnerModel,
    saveDefinition: (
      type: ModelType,
      def: Parameters<typeof autoDefRepo.save>[1],
    ) => autoDefRepo.save(type, def),
    getDefinitionPath: (type: ModelType, id: string) =>
      autoDefRepo.getPath(type, id as DefinitionId),
  };
  const resolve = (name: string): Promise<DirectExecutionResult> =>
    resolveOrCreateDefinition(
      deps,
      RUNNER.normalized,
      name,
      "run",
      {},
      RUNNER,
      runnerModel,
      undefined,
      ctx.autoDefinitionsDir,
    );
  return { resolve, reads };
}

/**
 * Runs `fn` over a fresh repository wired as serve wires it. With
 * `clockAheadMs`, the index's clock runs that far ahead, so files the test
 * dated long ago count as settled although their ctime is when the test
 * wrote them; on a server, stored definitions have long settled.
 */
async function withServeRepo(
  clockAheadMs: number,
  fn: (
    ctx: RepositoryContext,
    wiring: ReturnType<typeof serveWiring>,
    repoDir: string,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-direct-lookup-" });
  try {
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
    });
    await fn(ctx, serveWiring(dir, ctx, clockAheadMs), dir);
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

Deno.test("integration: concurrent direct-type steps with new names each create one definition without reading a stored definition again (swamp-club#4037)", async () => {
  await withServeRepo(60_000, async (ctx, { resolve, reads }, repoDir) => {
    const runnerDir = join(ctx.autoDefinitionsDir, RUNNER.toDirectoryPath());
    const stored = new Set<string>();
    for (let i = 0; i < STORED; i++) {
      const path = join(runnerDir, `stored-${i}.yaml`);
      await writeDefinition(path, `stored-${i}`, RUNNER.normalized);
      stored.add(path);
    }
    const primaryDir = join(repoDir, "models", "other", "type");
    for (let i = 0; i < 20; i++) {
      const path = join(primaryDir, `kept-${i}.yaml`);
      await writeDefinition(path, `kept-${i}`, "other/type");
      stored.add(path);
    }
    await settle(ctx.autoDefinitionsDir);
    await settle(join(repoDir, "models"));

    // The first lookup in a serve process builds the index: one read each.
    const cold = await resolve("first-new");
    assertEquals(cold.ok && cold.created, true);
    assertEquals(reads.filter((path) => stored.has(path)).length, stored.size);
    reads.length = 0;

    const names = Array.from({ length: 36 }, (_, i) => `shard-${i}`);
    const results = await Promise.all(names.map((name) => resolve(name)));
    for (const result of results) {
      assertEquals(result.ok && result.created, true);
    }
    const files = [...Deno.readDirSync(runnerDir)].map((e) => e.name);
    for (const name of names) assert(files.includes(`${name}.yaml`), name);
    // Initial lookups and locked rechecks read only definitions created
    // since: the stored ones, settled, are never read again.
    assertEquals(reads.filter((path) => stored.has(path)), []);

    // Each name now resolves to the definition it created.
    for (const [i, name] of names.entries()) {
      const again = await resolve(name);
      assertEquals(again.ok && !again.created, true);
      assertEquals(
        again.ok && again.definition.id,
        results[i].ok && results[i].definition.id,
      );
    }
  });
});

Deno.test("integration: concurrent direct-type steps of one new name through the definition index converge on one definition", async () => {
  await withServeRepo(0, async (_ctx, { resolve }) => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolve("shared")),
    );
    assertEquals(results.filter((r) => r.ok && r.created).length, 1);
    assertEquals(
      new Set(results.map((r) => r.ok ? r.definition.id : "")).size,
      1,
    );
  });
});

Deno.test("integration: through the definition index a direct-type step adopts a definition shadowing an auto-definition, and refuses a name another type holds", async () => {
  await withServeRepo(0, async (ctx, { resolve }, repoDir) => {
    const runnerPath = RUNNER.toDirectoryPath();
    await writeDefinition(
      join(ctx.autoDefinitionsDir, runnerPath, "shadowed.yaml"),
      "shadowed",
      RUNNER.normalized,
    );
    const primaryId = await writeDefinition(
      join(repoDir, "models", runnerPath, "shadowed.yaml"),
      "shadowed",
      RUNNER.normalized,
    );
    await writeDefinition(
      join(repoDir, "models", "other", "type", "taken.yaml"),
      "taken",
      "other/type",
    );

    const shadowed = await resolve("shadowed");
    assertEquals(shadowed.ok && !shadowed.created, true);
    assertEquals(shadowed.ok && (shadowed.definition.id as string), primaryId);

    const taken = await resolve("taken");
    assertEquals(taken.ok, false);
    assertStringIncludes(
      taken.ok ? "" : taken.error.message,
      "exists with type 'other/type'",
    );
  });
});

Deno.test("integration: through the definition index a direct-type step sees definitions another writer adds, renames and removes", async () => {
  await withServeRepo(0, async (ctx, { resolve }) => {
    const runnerDir = join(ctx.autoDefinitionsDir, RUNNER.toDirectoryPath());
    assertEquals((await resolve("warm")).ok, true);

    const addedId = await writeDefinition(
      join(runnerDir, "by-hand.yaml"),
      "external",
      RUNNER.normalized,
    );
    const added = await resolve("external");
    assertEquals(added.ok && !added.created, true);
    assertEquals(added.ok && (added.definition.id as string), addedId);

    // Renamed to declare another name, through a rename as editors write.
    await writeDefinition(
      join(runnerDir, "by-hand.yaml"),
      "renamed",
      RUNNER.normalized,
      addedId,
    );
    const renamed = await resolve("renamed");
    assertEquals(renamed.ok && (renamed.definition.id as string), addedId);

    await Deno.remove(join(runnerDir, "by-hand.yaml"));
    const recreated = await resolve("renamed");
    assertEquals(recreated.ok && recreated.created, true);
  });
});

Deno.test({
  name:
    "integration: through the definition index a definition that cannot be read fails the direct-type step instead of being taken for a new name",
  // A file mode cannot deny root, or anyone on Windows, a read.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withServeRepo(0, async (ctx, { resolve }) => {
      const path = join(
        ctx.autoDefinitionsDir,
        RUNNER.toDirectoryPath(),
        "locked.yaml",
      );
      await writeDefinition(path, "locked", RUNNER.normalized);
      await Deno.chmod(path, 0o000);
      try {
        let failed = false;
        try {
          const result = await resolve("locked");
          failed = !result.ok;
        } catch {
          failed = true;
        }
        assert(failed, "an unreadable definition must not be taken for none");
        const files = [
          ...Deno.readDirSync(
            join(ctx.autoDefinitionsDir, RUNNER.toDirectoryPath()),
          ),
        ];
        assertEquals(files.map((e) => e.name), ["locked.yaml"]);
      } finally {
        await Deno.chmod(path, 0o644);
      }
    });
  },
});
