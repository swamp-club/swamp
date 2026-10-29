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
 * A managed-config edit names the version it started from through serve
 * too (swamp-club#4097): two serve-mode checkouts of one datastore load a
 * definition, one forwards an edit, and the other's edit of the version it
 * loaded is refused by serve as `config_edit_conflict`, naming who changed
 * it. Two checkouts racing one edit get exactly one success.
 */

import "../src/domain/models/models.ts";
import { AsyncResource } from "node:async_hooks";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Definition } from "../src/domain/definitions/definition.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { configEditConflictOf } from "../src/domain/datastore_v3/config_edit_conflict.ts";
import { runAsUserConfigEdit } from "../src/infrastructure/datastore_v3/config_edit_scope.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  type Client,
  readCommand,
  type Scratch,
  serveEnv,
  withScratch,
  writeCommand,
  writeInOpenCommand,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

const API_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a11";

/** `api` as `by` last edited it. */
function api(by: string): Definition {
  return Definition.create({
    id: API_ID,
    name: "api",
    globalArguments: {},
    tags: { by },
  });
}

/** Who last edited `api`, as `client` reads it. */
function editedBy(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  type: ModelType,
): Promise<string | undefined> {
  return readCommand(
    scratch,
    client,
    env,
    async (repos) =>
      (await repos.definitionRepo.findByName(type, "api"))?.tags.by,
  );
}

/** A user's edit, as the CLI's edit commands run it. */
function userEdit(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  fn: (repos: RepositoryContext) => Promise<unknown>,
): Promise<unknown> {
  return runAsUserConfigEdit(() => writeCommand(scratch, client, env, fn));
}

/** Asserts `error` is serve's stale-edit refusal of behavior `api`. */
function assertConflict(error: unknown): void {
  const conflict = configEditConflictOf(error);
  assert(conflict !== undefined, `not an edit conflict: ${error}`);
  assertEquals(conflict.code, "config_edit_conflict");
  const [only] = conflict.conflicts;
  assertEquals([only.kind, only.name], ["model", "api"]);
  assert(only.changedBy !== undefined, "serve says who changed it");
  assert(only.changedAt !== undefined, "serve says when");
}

Deno.test({
  name:
    "serve upstream config conflict: B's edit of the version it loaded is refused after A's forwarded edit, and A's edit stands",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ managedConfig: true });
      const bucket = scratch.bucket();
      const a = await scratch.client("a", { bucket, managedConfig: true });
      const b = await scratch.client("b", { bucket, managedConfig: true });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;

      await userEdit(
        scratch,
        a,
        env,
        (repos) => repos.definitionRepo.save(type, api("seed")),
      );
      // Both checkouts load api at the same version.
      assertEquals(await editedBy(scratch, b, env, type), "seed");
      assertEquals(await editedBy(scratch, a, env, type), "seed");

      await userEdit(
        scratch,
        a,
        env,
        (repos) => repos.definitionRepo.save(type, api("A")),
      );
      const error = await assertRejects(() =>
        userEdit(
          scratch,
          b,
          env,
          (repos) => repos.definitionRepo.save(type, api("B")),
        )
      );
      assertConflict(error);

      assertEquals(await editedBy(scratch, a, env, type), "A");
      assertEquals(await editedBy(scratch, b, env, type), "A");
    });
  },
});

Deno.test({
  name:
    "serve upstream config conflict: two checkouts racing one edit through serve get exactly one success",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ managedConfig: true });
      const bucket = scratch.bucket();
      const a = await scratch.client("a", { bucket, managedConfig: true });
      const b = await scratch.client("b", { bucket, managedConfig: true });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;

      await userEdit(
        scratch,
        a,
        env,
        (repos) => repos.definitionRepo.save(type, api("seed")),
      );
      assertEquals(await editedBy(scratch, b, env, type), "seed");

      // B's command is open, caught up to seed, when A's edit lands; then B
      // saves its own.
      const outside = AsyncResource.bind(
        <T>(fn: () => Promise<T>): Promise<T> => fn(),
      ) as <T>(fn: () => Promise<T>) => Promise<T>;
      const error = await assertRejects(() =>
        userEdit(scratch, b, env, async (repos) => {
          await outside(() =>
            runAsUserConfigEdit(() =>
              writeInOpenCommand(
                scratch,
                a,
                env,
                (aRepos) => aRepos.definitionRepo.save(type, api("A")),
              )
            )
          );
          await repos.definitionRepo.save(type, api("B"));
        })
      );
      assertConflict(error);
      assertEquals(await editedBy(scratch, a, env, type), "A");
    });
  },
});
