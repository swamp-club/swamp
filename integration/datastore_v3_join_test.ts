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
 * Joining a v3 datastore through `.swamp.yaml` (swamp-club#3690): a
 * checkout whose `.swamp/` holds v2 records is refused at its first v3 open,
 * writing nothing, and `swamp doctor datastores --repair` moves the records
 * aside so it catches up to exactly the datastore's records.
 */

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import { copy, walk } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import {
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { resolveConfigTierPath } from "../src/cli/resolve_datastore.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createDatastoreSetupDeps,
  type DatastoreSetupEvent,
  datastoreSetupFilesystem,
} from "../src/libswamp/datastores/setup.ts";
import { collect } from "../src/libswamp/testing.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  hasV3CheckoutState,
  PRE_V3_RECORDS_DIR,
  V3_CHECKOUT_HOLDS_RECORDS_CODE,
  V3CheckoutHoldsRecordsError,
} from "../src/infrastructure/datastore_v3/v3_checkout_join.ts";
import { UserError } from "../src/domain/errors.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import { Data } from "../src/domain/data/data.ts";
import { saveModel, type ServeRepo } from "./serve_request_harness.ts";
import { runCli, runCliRejecting, UNSET_ENV } from "./usecase_sync_fixtures.ts";

await initializeLogging({});

async function initRepo(repoDir: string): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
}

/** Every file under `root`, by path, with its bytes as text. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  try {
    for await (const entry of walk(root, { includeDirs: false })) {
      files[entry.path.slice(root.length)] = await Deno.readTextFile(
        entry.path,
      ).catch(() => "<binary>");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return files;
}

/** Saves one version of `dataName` owned by `model`, holding `content`. */
async function saveVersion(
  repo: ServeRepo,
  model: Definition,
  dataName: string,
  content: string,
): Promise<void> {
  const data = Data.create({
    name: dataName,
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: model.name },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${repo.modelType.normalized}:${model.id}`,
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    model.id,
    data,
    new TextEncoder().encode(content),
  );
}

interface JoinRepos {
  repoA: string;
  repoB: string;
  datastorePath: string;
  modelType: ModelType;
  model: Definition;
}

/**
 * Checkout A sets up a v3 datastore and commits versions 1 and 2 of `log`
 * for `m1`. Checkout B, still on v2, holds its own versions 1 to 3 of the
 * same record, then pulls A's `.swamp.yaml`: the issue's adoption path.
 */
async function withJoiningCheckout(
  fn: (repos: JoinRepos) => Promise<void>,
  options: { readonly bHoldsRecords?: boolean } = {},
): Promise<void> {
  const modelType = ModelType.create(
    `test/join-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type: modelType,
    version: "2026.01.01.1",
    methods: {
      noop: {
        description: "does nothing",
        kind: "read",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  });
  // The CLI resolves --repo-dir through a symlink (swamp-club#3552), and
  // the macOS temp dir is one.
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-v3-join-" }),
  );
  try {
    const repoA = join(dir, "a");
    const repoB = join(dir, "b");
    const datastorePath = join(dir, "datastore");
    await initRepo(repoA);
    const setup = await collect<DatastoreSetupEvent>(
      datastoreSetupFilesystem(
        createLibSwampContext(),
        createDatastoreSetupDeps(repoA, resolveConfigTierPath, {
          swampVersion: "test-version",
        }),
        { datastorePath, repoDir: repoA, skipMigration: false, format: 3 },
      ),
    );
    assertEquals(setup.at(-1)?.kind, "completed");

    const a = await requireInitializedRepoUnlocked({
      repoDir: repoA,
      outputMode: "json",
    });
    const repoOfA: ServeRepo = {
      repoDir: a.repoDir,
      repoContext: a.repoContext,
      datastoreConfig: a.datastoreConfig,
      datastoreResolver: a.datastoreResolver as ServeRepo["datastoreResolver"],
      modelType,
    };
    const model = await runInRootUnitOfWork(
      a.repoContext,
      { flush: undefined },
      async () => {
        const saved = await saveModel(repoOfA, "m1");
        await saveVersion(repoOfA, saved, "log", "A-v3-1");
        await saveVersion(repoOfA, saved, "log", "A-v3-2");
        return saved;
      },
    );
    await closeV3Datastores();

    // B is a clone from before the move to v3, with the same model, and has
    // written three versions of its own under v2.
    await initRepo(repoB);
    await copy(join(repoA, "models"), join(repoB, "models"), {
      overwrite: true,
    });
    const b = await requireInitializedRepoUnlocked({
      repoDir: repoB,
      outputMode: "json",
    });
    const repoOfB: ServeRepo = {
      repoDir: b.repoDir,
      repoContext: b.repoContext,
      datastoreConfig: b.datastoreConfig,
      datastoreResolver: b.datastoreResolver as ServeRepo["datastoreResolver"],
      modelType,
    };
    if (options.bHoldsRecords !== false) {
      for (let i = 1; i <= 3; i++) {
        await saveVersion(repoOfB, model, "log", `B-pre-join-${i}`);
      }
      assertEquals(
        await b.repoContext.unifiedDataRepo.listVersions(
          modelType,
          model.id,
          "log",
        ),
        [1, 2, 3],
      );
    }
    // Repo-local and always-local files are never records.
    for (const local of ["logs", "telemetry", "secrets"]) {
      await Deno.mkdir(swampPath(repoB, local), { recursive: true });
      await Deno.writeTextFile(swampPath(repoB, local, "local.json"), "{}");
    }

    // B pulls the commit that moves the repo to v3.
    await Deno.copyFile(
      join(repoA, ".swamp.yaml"),
      join(repoB, ".swamp.yaml"),
    );
    await fn({ repoA, repoB, datastorePath, modelType, model });
  } finally {
    await closeV3Datastores();
    modelRegistry.invalidateType(modelType);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test({
  name:
    "v3 join: a checkout holding v2 records is refused at its first v3 open, writing nothing (swamp-club#3690)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withJoiningCheckout(async ({ repoB, datastorePath }) => {
      const checkoutBefore = await snapshot(swampPath(repoB));
      const datastoreBefore = await snapshot(datastorePath);
      for (
        const open of [
          requireInitializedRepoReadOnly,
          requireInitializedRepoUnlocked,
        ]
      ) {
        const error = await assertRejects(
          () => open({ repoDir: repoB, outputMode: "json" }),
          V3CheckoutHoldsRecordsError,
        );
        assertEquals(error.code, V3_CHECKOUT_HOLDS_RECORDS_CODE);
        assert(error.recordDirs.includes("data"), String(error.recordDirs));
      }
      assertEquals(await snapshot(swampPath(repoB)), checkoutBefore);
      assertEquals(await snapshot(datastorePath), datastoreBefore);
      assertEquals(await hasV3CheckoutState(repoB), false);
    });
  },
});

Deno.test({
  name:
    "v3 join: doctor datastores --repair moves the records aside, and the checkout then holds exactly the datastore's (swamp-club#3690)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withJoiningCheckout(
      async ({ repoA, repoB, modelType, model }) => {
        await withMockedEnv(UNSET_ENV, async () => {
          const json = ["--repo-dir", repoB, "--json"];
          // Without --repair the check names the refusal.
          const refused = await runCliRejecting({
            args: ["doctor", "datastores", ...json],
          });
          assertInstanceOf(refused, UserError);
          assertEquals(refused.code, V3_CHECKOUT_HOLDS_RECORDS_CODE);

          const before = await snapshot(swampPath(repoB, "data"));
          const preview = JSON.parse(
            (await runCli({
              args: ["doctor", "datastores", "--repair", ...json],
            })).join("\n"),
          );
          assertEquals(preview.status, "pre_v3_records_preview");
          assert(preview.recordDirs.includes("data"));
          // A preview moves nothing.
          assertEquals(await snapshot(swampPath(repoB, "data")), before);

          const moved = JSON.parse(
            (await runCli({
              args: ["doctor", "datastores", "--repair", "--yes", ...json],
            })).join("\n"),
          );
          assertEquals(moved.status, "pre_v3_records_moved");
          assert(
            moved.destination.startsWith(swampPath(repoB, PRE_V3_RECORDS_DIR)),
            moved.destination,
          );
          // B's v2 records are where the repair said, as they were.
          assertEquals(
            await snapshot(join(moved.destination, "data")),
            before,
          );
        });

        const versionsIn = async (repoDir: string) => {
          const opened = await requireInitializedRepoReadOnly({
            repoDir,
            outputMode: "json",
          });
          const repo = opened.repoContext.unifiedDataRepo;
          const versions = await repo.listVersions(modelType, model.id, "log");
          const contents: string[] = [];
          for (const version of versions) {
            const bytes = await repo.getContent(
              modelType,
              model.id,
              "log",
              version,
            );
            contents.push(new TextDecoder().decode(bytes ?? undefined));
          }
          await closeV3Datastores();
          return { versions, contents };
        };
        const inA = await versionsIn(repoA);
        assertEquals(inA, { versions: [1, 2], contents: ["A-v3-1", "A-v3-2"] });
        // B catches up to exactly A's records.
        assertEquals(await versionsIn(repoB), inA);
      },
    );
  },
});

Deno.test({
  name:
    "v3 join: a checkout holding only repo-local files joins as before and lists the datastore's records (swamp-club#3690)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withJoiningCheckout(async ({ repoB, modelType, model }) => {
      const opened = await requireInitializedRepoReadOnly({
        repoDir: repoB,
        outputMode: "json",
      });
      assertEquals(
        await opened.repoContext.unifiedDataRepo.listVersions(
          modelType,
          model.id,
          "log",
        ),
        [1, 2],
      );
      await closeV3Datastores();
      // A later open, with v3 state, is not checked again.
      await requireInitializedRepoUnlocked({
        repoDir: repoB,
        outputMode: "json",
      });
    }, { bHoldsRecords: false });
  },
});
