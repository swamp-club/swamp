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
 * W3 cold-start performance benchmark. Generates a repo with 50 local
 * extensions × 1 source each, runs ReconcileFromDisk, and measures
 * wall time. Run with:
 *
 *   deno bench --unstable-bundle --allow-all src/libswamp/extensions/reconcile_from_disk_bench.ts
 *
 * Pre-committed threshold: ≤ 1.2x of pre-W3 cold-start baseline.
 * If blown, optimize (fingerprint caching, mtime fast-path) before shipping.
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { ReconcileFromDiskService } from "./reconcile_from_disk_service.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";

import "../../domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
};

const MINIMAL_MODEL = (typeId: string) => `
import { z } from "npm:zod@4";
export const model = {
  type: "${typeId}",
  version: "2026.05.05.1",
  globalArguments: z.object({}),
  resources: {
    "data": {
      description: "x",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

const EXTENSION_COUNT = 50;

async function setupBenchRepo(): Promise<{
  repoDir: string;
  cleanup: () => Promise<void>;
}> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_reconcile_bench_" });
  await ensureDir(join(repoDir, ".swamp"));
  const modelsDir = join(repoDir, "extensions", "models");
  await ensureDir(modelsDir);
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  await Deno.writeTextFile(lockfilePath, "{}");

  for (let i = 0; i < EXTENSION_COUNT; i++) {
    await Deno.writeTextFile(
      join(modelsDir, `model_${i}.ts`),
      MINIMAL_MODEL(`@bench/model-${i}`),
    );
  }

  return {
    repoDir,
    cleanup: async () => {
      if (Deno.build.os === "windows") {
        await Deno.remove(repoDir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(repoDir, { recursive: true });
      }
    },
  };
}

Deno.bench(
  `ReconcileFromDisk cold-start: ${EXTENSION_COUNT} local models`,
  { group: "reconcile-cold-start", baseline: true },
  async (b) => {
    const { repoDir, cleanup } = await setupBenchRepo();
    try {
      const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
      const lockfilePath = join(
        repoDir,
        "extensions",
        "models",
        "upstream_extensions.json",
      );

      b.start();
      const catalog = new ExtensionCatalogStore(dbPath);
      const lockfileRepository = await LockfileRepository.create(
        lockfilePath,
      );
      const repository = new ExtensionRepository({
        catalog,
        lockfileRepository,
        repoRoot: repoDir,
      });
      const service = new ReconcileFromDiskService({
        denoRuntime: testDenoRuntime,
        repository,
        lockfileRepository,
        repoDir,
      });
      const result = await service.execute();
      b.end();

      if (result.transitions.length === 0) {
        throw new Error("Expected transitions from cold-start reconcile");
      }
      catalog.close();
    } finally {
      await cleanup();
    }
  },
);

Deno.bench(
  `ReconcileFromDisk warm-start (no-op): ${EXTENSION_COUNT} local models`,
  { group: "reconcile-warm-start" },
  async (b) => {
    const { repoDir, cleanup } = await setupBenchRepo();
    try {
      const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
      const lockfilePath = join(
        repoDir,
        "extensions",
        "models",
        "upstream_extensions.json",
      );

      const catalog = new ExtensionCatalogStore(dbPath);
      const lockfileRepository = await LockfileRepository.create(
        lockfilePath,
      );
      const repository = new ExtensionRepository({
        catalog,
        lockfileRepository,
        repoRoot: repoDir,
      });
      const service = new ReconcileFromDiskService({
        denoRuntime: testDenoRuntime,
        repository,
        lockfileRepository,
        repoDir,
      });

      // Warm up: run reconcile once to populate catalog.
      await service.execute();

      b.start();
      const result = await service.execute();
      b.end();

      if (result.transitions.length !== 0) {
        throw new Error("Warm-start should produce zero transitions");
      }
      catalog.close();
    } finally {
      await cleanup();
    }
  },
);
