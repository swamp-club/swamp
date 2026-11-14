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
import { assert, assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { withCapturedSpans } from "../src/infrastructure/tracing/span_test_helpers.ts";
import {
  dataOf,
  json,
  latestOf,
  readCommand,
  serveEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

async function countingCompactions(
  fn: () => Promise<unknown>,
): Promise<number> {
  const original = SqliteCommitStore.prototype.compactionStatus;
  let asked = 0;
  SqliteCommitStore.prototype.compactionStatus = function (...args) {
    asked++;
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    SqliteCommitStore.prototype.compactionStatus = original;
  }
  return asked;
}

Deno.test({
  name:
    "v3 checkout move: a member's checkout moved with its serve copy keeps its records, rebuilds nothing, and its exit compacts nothing (swamp-club#4702)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const member = await scratch.client("a");
      const alice = serveEnv(serve, "alice-token");
      const save = (repoDir: string, cidr: string) =>
        writeCommand(
          scratch,
          { repoDir },
          alice,
          (repos) =>
            repos.unifiedDataRepo.save(
              serve.modelType,
              serve.models.web,
              dataOf("vpc"),
              json({ cidr }),
            ),
        );
      await save(member.repoDir, "10.0.0.0/16");

      const moved = join(scratch.dir, "a-moved");
      await Deno.rename(member.repoDir, moved);
      let entries: unknown[] = [];
      let compactions = 0;
      await withCapturedSpans(async (spans) => {
        compactions = await countingCompactions(() =>
          save(moved, "10.1.0.0/16")
        );
        entries = spans
          .filter((span) =>
            span.name === "swamp.datastore.v3.readmodel.recover"
          )
          .map((span) =>
            span.attributes["swamp.datastore.v3.readmodel.recover.entry"]
          );
      });
      assert(!entries.includes("view_change"), JSON.stringify(entries));
      assertEquals(compactions, 0);

      const latest = await readCommand(
        scratch,
        { repoDir: moved },
        alice,
        (repos) => latestOf(repos, serve.modelType, serve.models.web, "vpc"),
      );
      assertEquals(latest?.version, 2);
      assertEquals(latest?.content, JSON.stringify({ cidr: "10.1.0.0/16" }));
    });
  },
});

Deno.test({
  name:
    "v3 checkout move: a solo writer still compacts at its exit, as a serve copy does not (swamp-club#4702)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const solo = await scratch.client("s", { solo: true });
      const compactions = await countingCompactions(() =>
        writeCommand(
          scratch,
          solo,
          {},
          (repos) =>
            repos.unifiedDataRepo.save(
              serve.modelType,
              serve.models.web,
              dataOf("vpc"),
              json({ cidr: "10.0.0.0/16" }),
            ),
        )
      );
      assert(compactions > 0, "the solo writer's exit asks about compaction");
    });
  },
});

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

Deno.test("v3 checkout move: an extension bundled before its repo moved loads and runs at the moved path (swamp-club#4702)", async () => {
  const root = await Deno.makeTempDir({ prefix: "swamp_4702_move_" });
  const type = `@test/move-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const repoDir = join(root, "repo");
    await ensureDir(join(repoDir, "extensions", "models"));
    await ensureDir(join(repoDir, ".swamp"));
    await Deno.writeTextFile(
      join(repoDir, "extensions", "models", "echo.ts"),
      `import { z } from "npm:zod@4";
export const model = {
  type: "${type}",
  version: "2026.11.14.1",
  description: "echo",
  globalArguments: z.object({}),
  resources: {},
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`,
    );
    const loaderAt = (dir: string) => {
      const catalog = new ExtensionCatalogStore(
        join(dir, ".swamp", "_extension_catalog.db"),
      );
      const loader = new ExtensionLoader(
        testDenoRuntime,
        modelKindAdapter,
        dir,
        undefined,
        new ExtensionRepository({
          catalog,
          lockfileRepository: new LockfileRepository(
            join(dir, "upstream_extensions.json"),
          ),
          repoRoot: dir,
        }),
      );
      return { catalog, loader };
    };
    const first = loaderAt(repoDir);
    try {
      await first.loader.buildIndex(join(repoDir, "extensions", "models"));
    } finally {
      first.catalog.close();
    }
    modelRegistry.invalidateType(type);

    const movedDir = join(root, "moved");
    await Deno.rename(repoDir, movedDir);
    const moved = loaderAt(movedDir);
    try {
      const modelsDir = join(movedDir, "extensions", "models");
      await moved.loader.load(modelsDir);
      const model = modelRegistry.get(type);
      assert(model !== undefined, "the moved extension registered");
      const result = await model.methods.noop.execute(
        {} as never,
        {} as never,
      );
      assertEquals(result, { dataHandles: [] });
    } finally {
      moved.catalog.close();
    }
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(root, { recursive: true });
    }
  }
});
