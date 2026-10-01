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

// Wires two repos to one in-memory remote through requireInitializedRepo,
// so the real repository factory, markDirty hook and flush paths run
// against the shared fake. Pins that a data save on one machine reaches
// the other through acquireModelLocks' flush and step-start pull, on both
// the two-phase and the single-phase push path.

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import {
  acquireModelLocks,
  requireInitializedRepo,
  resolveDatastoreForRepo,
} from "../src/cli/repo_context.ts";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import { VERSION } from "../src/cli/commands/version.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-in-memory-remote-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function initRepo(repoDir: string, typeName: string): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  const service = new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  });
  await service.init(RepoPath.create(repoDir), { tools: [] });
  await configureTestDatastore(repoDir, typeName);
}

const modelType = ModelType.create("test/in-memory-remote");
const modelId = crypto.randomUUID();
const models = [{ modelType: modelType.normalized, modelId }];

for (const twoPhaseSync of [true, false]) {
  Deno.test(
    `in-memory remote wiring: a data save reaches a second repo over the ${
      twoPhaseSync ? "two-phase" : "single-phase"
    } flush`,
    async () => {
      const remote = createInMemoryRemote({
        capabilities: twoPhaseSync ? { twoPhaseSync: true } : {},
      });
      const { typeName, dispose } = registerTestDatastoreType(remote);
      try {
        await withTempDir(async (dir) => {
          const repoA = join(dir, "a");
          const repoB = join(dir, "b");
          await initRepo(repoA, typeName);
          await initRepo(repoB, typeName);

          // Machine A: lock (step-start pull), write, flush (push).
          const a = await requireInitializedRepo({
            repoDir: repoA,
            outputMode: "json",
            skipImplicitSync: true,
          });
          const { datastoreConfig: configA } = await resolveDatastoreForRepo(
            repoA,
          );
          const locksA = await acquireModelLocks(configA, models, repoA);
          const data = Data.create({
            name: "shared",
            contentType: "text/plain",
            lifetime: "infinite",
            garbageCollection: 100,
            tags: { type: "test" },
            ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
          });
          await a.repoContext.unifiedDataRepo.save(
            modelType,
            modelId,
            data,
            new TextEncoder().encode("from machine a"),
          );
          await locksA.flush();
          await flushDatastoreSync();

          const pushOps = remote.ops().filter((op) =>
            op.op === (twoPhaseSync ? "commit" : "push") &&
            op.paths.length > 0
          );
          assertEquals(pushOps.length, 1);
          const pushed = pushOps[0].paths;
          assertEquals(
            pushed.some((rel) => rel.endsWith("/raw")),
            true,
            `expected the content file among ${pushed.join(", ")}`,
          );

          // Machine B: the step-start pull brings A's files down.
          const b = await requireInitializedRepo({
            repoDir: repoB,
            outputMode: "json",
            skipImplicitSync: true,
          });
          const { datastoreConfig: configB } = await resolveDatastoreForRepo(
            repoB,
          );
          const locksB = await acquireModelLocks(configB, models, repoB);
          for (const rel of pushed) {
            const local = await Deno.readFile(
              join(repoB, ".test-cache", ...rel.split("/")),
            );
            assertEquals(local, remote.files().get(rel));
          }
          const content = await b.repoContext.unifiedDataRepo.getContent(
            modelType,
            modelId,
            "shared",
          );
          assertEquals(
            content && new TextDecoder().decode(content),
            "from machine a",
          );
          await locksB.flush();
          await flushDatastoreSync();
        });
      } finally {
        dispose();
      }
    },
  );
}
