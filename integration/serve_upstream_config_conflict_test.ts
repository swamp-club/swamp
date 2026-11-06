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
import { AsyncResource } from "node:async_hooks";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Definition } from "../src/domain/definitions/definition.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { configEditConflictOf } from "../src/domain/datastore_v3/config_edit_conflict.ts";
import { runAsUserConfigEdit } from "../src/infrastructure/datastore_v3/config_edit_scope.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { requireInitializedRepo } from "../src/cli/repo_context.ts";
import { runManagedConfigMutation } from "../src/cli/managed_config_sync.ts";
import { startConfigEdit } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  type Client,
  endCommand,
  MEMBER,
  readCommand,
  type Scratch,
  serveEnv,
  withClientEnv,
  withScratch,
  writeCommand,
  writeInOpenCommand,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

const API_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a11";

function api(by: string): Definition {
  return Definition.create({
    id: API_ID,
    name: "api",
    globalArguments: {},
    tags: { by },
  });
}

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

function userEdit(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  fn: (repos: RepositoryContext) => Promise<unknown>,
): Promise<unknown> {
  return runAsUserConfigEdit(() => writeCommand(scratch, client, env, fn));
}

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

/**
 * B's edit races A's through serve the way an edit command runs: a result is
 * printed before the root commits, and serve refuses the commit
 */
async function racedEditOutput(
  outputOnlyOnSuccess: boolean,
): Promise<{ error: unknown; stdout: string[] }> {
  const stdout: string[] = [];
  let error: unknown;
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
    const outside = AsyncResource.bind(
      <T>(fn: () => Promise<T>): Promise<T> => fn(),
    ) as <T>(fn: () => Promise<T>) => Promise<T>;
    const log = console.log;
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    try {
      await runAsUserConfigEdit(() =>
        withClientEnv(scratch, env, ["model", "edit"], async () => {
          try {
            const ctx = await requireInitializedRepo({
              repoDir: b.repoDir,
              outputMode: "json",
            });
            await runManagedConfigMutation(
              ctx.repoContext,
              undefined,
              // read only to publish through a v2 sync service; there is none
              { type: "filesystem", path: b.repoDir },
              null,
              "model edit",
              async () => {
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
                await ctx.repoContext.definitionRepo.save(type, api("B"));
                console.log(JSON.stringify({ status: "updated" }));
              },
              { outputOnlyOnSuccess },
            );
          } finally {
            await endCommand();
          }
        })
      );
    } catch (thrown) {
      error = thrown;
    } finally {
      console.log = log;
    }
    assertEquals(await editedBy(scratch, a, env, type), "A");
  });
  return { error, stdout };
}

Deno.test({
  name:
    "serve upstream config conflict: an edit serve refuses at its commit prints no result",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { error, stdout } = await racedEditOutput(true);
    assertConflict(error);
    assertEquals(stdout, []);
  },
});

Deno.test({
  name:
    "serve upstream config conflict: without the edit option the held result is still printed before the refusal",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { error, stdout } = await racedEditOutput(false);
    assertConflict(error);
    assertEquals(stdout, [JSON.stringify({ status: "updated" })]);
  },
});

Deno.test({
  name:
    "serve upstream config conflict: a member without write gets forbidden for an edit of a stale version, never the conflict, once the command reached serve",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        managedConfig: true,
        grants: [
          ...MEMBER,
          { user: "bob", actions: ["read"], kind: "model", pattern: "*" },
        ],
      });
      const bucket = scratch.bucket();
      const a = await scratch.client("a", { bucket, managedConfig: true });
      const b = await scratch.client("b", { bucket, managedConfig: true });
      const alice = serveEnv(serve, "alice-token");
      const bob = serveEnv(serve, "bob-token");
      const type = serve.modelType;

      await userEdit(
        scratch,
        a,
        alice,
        (repos) => repos.definitionRepo.save(type, api("seed")),
      );
      assertEquals(await editedBy(scratch, b, bob, type), "seed");
      await userEdit(
        scratch,
        a,
        alice,
        (repos) => repos.definitionRepo.save(type, api("A")),
      );
      // what model edit does with content prepared before the command
      const error = await assertRejects(() =>
        userEdit(scratch, b, bob, async (repos) => {
          await startConfigEdit(repos, "model", "api", false, {
            mayRename: false,
          });
          await repos.definitionRepo.save(type, api("B"));
        })
      );
      assertEquals(configEditConflictOf(error), undefined, String(error));
      assert(String(error).includes("Not authorized"), String(error));
      assertEquals(await editedBy(scratch, a, alice, type), "A");
    });
  },
});

Deno.test({
  name:
    "serve upstream config conflict: a member with write still gets the conflict for a stale version, decided at serve",
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
      await userEdit(
        scratch,
        a,
        env,
        (repos) => repos.definitionRepo.save(type, api("A")),
      );
      const error = await assertRejects(() =>
        userEdit(scratch, b, env, async (repos) => {
          await startConfigEdit(repos, "model", "api", false, {
            mayRename: false,
          });
          await repos.definitionRepo.save(type, api("B"));
        })
      );
      assertConflict(error);
      assertEquals(await editedBy(scratch, a, env, type), "A");
    });
  },
});

Deno.test({
  name:
    "serve upstream config conflict: a stale edit that may rename is still refused before anything commits, so its new name is never created",
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
      await userEdit(
        scratch,
        a,
        env,
        (repos) => repos.definitionRepo.save(type, api("A")),
      );
      const renamed = Definition.create({
        id: API_ID,
        name: "api2",
        globalArguments: {},
        tags: { by: "B" },
      });
      const error = await assertRejects(() =>
        userEdit(scratch, b, env, async (repos) => {
          await startConfigEdit(repos, "model", "api", false);
          await repos.definitionRepo.save(type, renamed);
        })
      );
      assertConflict(error);
      assertEquals(
        await readCommand(
          scratch,
          a,
          env,
          async (repos) =>
            (await repos.definitionRepo.findByName(type, "api2")) === null,
        ),
        true,
      );
    });
  },
});
