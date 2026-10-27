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

// A client machine for serve_upstream_lock_test.ts (swamp-club#3985): a
// serve-mode checkout in a Worker of its own, so two of them write one
// datastore through serve at once as two machines would, each with its own
// process state (v3 handles, leases, serve-upstream bindings). Each command
// takes the behavior's lock as `model method run` does
// (`acquireModelLocks`), saves one data version in a root unit, and releases
// the lock once the root has committed.

import "../src/domain/models/models.ts";
import { z } from "zod";
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { runCommandInRootUnit } from "../src/cli/command_root_unit.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  dataOf,
  endCommand,
  json,
  withClientEnv,
} from "./serve_upstream_fixtures.ts";

export type ClientWorkerRequest = {
  readonly kind: "run";
  readonly configDir: string;
  readonly repoDir: string;
  readonly env: Record<string, string | undefined>;
  readonly modelType: string;
  readonly modelId: string;
  /** The data name and id every save writes a version of. */
  readonly dataName: string;
  readonly dataId: string;
  /** How many commands to run, one after another. */
  readonly count: number;
  /** Names this client in the content it saves. */
  readonly label: string;
};

export type ClientWorkerMessage =
  | { readonly kind: "loaded" }
  | {
    readonly kind: "done";
    /** The version each command saved, in order. */
    readonly versions: readonly number[];
    /** Each command's failure, if any. */
    readonly errors: readonly string[];
  }
  | { readonly kind: "failed"; readonly error: string };

declare const self: Worker;

const logging = initializeLogging({});

async function run(request: ClientWorkerRequest): Promise<void> {
  await logging;
  const type = ModelType.create(request.modelType);
  if (!modelRegistry.has(type)) {
    modelRegistry.register({
      type,
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
  }
  const versions: number[] = [];
  const errors: string[] = [];
  for (let i = 0; i < request.count; i++) {
    try {
      const version = await withClientEnv(
        { configDir: request.configDir },
        request.env,
        ["model", "method"],
        async () => {
          try {
            const ctx = await requireInitializedRepoUnlocked({
              repoDir: request.repoDir,
              outputMode: "json",
            });
            const locks = await acquireModelLocks(
              ctx.datastoreConfig,
              [{ modelType: type.normalized, modelId: request.modelId }],
              request.repoDir,
              ctx.syncService,
              ctx.repoContext.catalogStore,
              () => {},
              { repoContext: ctx.repoContext },
            );
            return await runCommandInRootUnit(
              ctx.repoContext,
              { push: undefined, release: locks.release },
              async () =>
                (await ctx.repoContext.unifiedDataRepo.save(
                  type,
                  request.modelId,
                  dataOf(request.dataName, request.dataId),
                  json({ by: request.label, i }),
                )).version,
            );
          } finally {
            await endCommand();
          }
        },
      );
      versions.push(version);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  self.postMessage(
    { kind: "done", versions, errors } satisfies ClientWorkerMessage,
  );
}

self.onmessage = (event: MessageEvent<ClientWorkerRequest>) => {
  run(event.data).catch((error) =>
    self.postMessage(
      {
        kind: "failed",
        error: error instanceof Error
          ? error.stack ?? error.message
          : String(error),
      } satisfies ClientWorkerMessage,
    )
  );
};

self.postMessage({ kind: "loaded" } satisfies ClientWorkerMessage);
