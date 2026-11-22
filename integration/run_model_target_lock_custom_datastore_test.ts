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
import { assertEquals } from "@std/assert";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  acquireModelLocks,
  runUnderModelLocks,
} from "../src/cli/repo_context.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  createModelMethodRunDeps,
  createStepLockHook,
} from "../src/serve/deps.ts";
import { withHarness } from "./concurrent_sync_harness.ts";

await initializeLogging({});

Deno.test("runModel: in a custom datastore the target's writes are published under its lock before the caller resumes", async () => {
  await withHarness(async (h) => {
    const counterType = ModelType.create(`test/pub-ctr-${crypto.randomUUID()}`);
    const callerType = ModelType.create(`test/pub-clr-${crypto.randomUUID()}`);
    const repo = h.context.repoContext;
    const ctr = Definition.create({
      name: "pub-ctr",
      type: counterType.normalized,
    });
    const clr = Definition.create({
      name: "pub-clr",
      type: callerType.normalized,
    });
    const remoteRaw = () =>
      h.remote.files().get(
        `data/${counterType.normalized}/${ctr.id}/state/1/raw`,
      ) !== undefined;
    let publishedWhenResumed: boolean | undefined;
    modelRegistry.register({
      type: counterType,
      version: "2026.11.22.1",
      resources: {
        state: {
          description: "counter",
          schema: z.object({ count: z.number() }),
          lifetime: "infinite",
          garbageCollection: 20,
        },
      },
      methods: {
        bump: {
          description: "write count 1",
          arguments: z.object({}),
          execute: async (_args, context) => ({
            dataHandles: [
              await context.writeResource!("state", "state", { count: 1 }),
            ],
          }),
        },
      },
    });
    modelRegistry.register({
      type: callerType,
      version: "2026.11.22.1",
      methods: {
        go: {
          description: "bump the counter through runModel",
          arguments: z.object({}),
          execute: async (_args, context) => {
            const result = await context.runModel!({
              definition: "pub-ctr",
              method: "bump",
            });
            if (!result.ok) throw new Error(result.error.message);
            publishedWhenResumed = remoteRaw();
            return { dataHandles: [] };
          },
        },
      },
    });
    try {
      await repo.definitionRepo.save(counterType, ctr);
      await repo.definitionRepo.save(callerType, clr);
      const locks = await acquireModelLocks(
        h.context.datastoreConfig,
        [{ modelType: callerType.normalized, modelId: clr.id }],
        h.repoDir,
        h.context.syncService,
        repo.catalogStore,
        () => {},
        { repoContext: repo },
      );
      try {
        const deps = await createModelMethodRunDeps(h.repoDir, repo, {});
        const events = await runUnderModelLocks(locks, () =>
          collect(
            modelMethodRun(createLibSwampContext(), {
              ...deps,
              nestedRunLock: createStepLockHook(
                h.repoDir,
                repo,
                h.context.datastoreConfig,
                h.context.syncService,
                undefined,
              ),
            }, {
              modelIdOrName: "pub-clr",
              methodName: "go",
              inputs: {},
              lastEvaluated: false,
            }),
          ));
        assertEquals(
          events.at(-1)?.kind,
          "completed",
          JSON.stringify(events.at(-1)),
        );
      } finally {
        await locks.release();
      }
      assertEquals(publishedWhenResumed, true);
    } finally {
      modelRegistry.invalidateType(counterType);
      modelRegistry.invalidateType(callerType);
    }
  });
});
