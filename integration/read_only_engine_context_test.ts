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
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  EngineReadOnlyFallback,
  EngineWorkspaceUntrustedError,
} from "../src/engine/profile.ts";
import {
  createLocalEngineContext,
  createReadOnlyEngineContext,
} from "../src/serve/local_engine_context.ts";
import type { ReadOnlyRepoOpener } from "../src/serve/local/read_only_dashboard.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  errorFrame,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

function opener(repo: ServeRepo, calls: string[]): ReadOnlyRepoOpener {
  return (repoDir, { extensions }) => {
    calls.push(`open ${extensions}`);
    assertEquals(repoDir, repo.repoDir);
    return Promise.resolve({
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
      datastoreConfig: repo.datastoreConfig,
      datastoreResolver: repo.datastoreResolver,
      vaultsDir: join(repo.repoDir, "vaults"),
      dispose: () => {
        calls.push("dispose");
        return Promise.resolve();
      },
    });
  };
}

Deno.test("createLocalEngineContext: a refusal before the first write offers a read-only fallback", async () => {
  await withServeRepo(async (repo) => {
    await Deno.writeTextFile(
      join(repo.repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\ndatastore:\n  type: '@example/bucket'\n  config: {}\n",
    );
    await withMockedEnv({ SWAMP_DATASTORE: undefined }, async () => {
      await assertRejects(
        () => createLocalEngineContext(repo.repoDir),
        EngineReadOnlyFallback,
        "filesystem datastore",
      );
    });
    await assertRejects(
      () => Deno.stat(join(repo.repoDir, ".swamp", "_extension_catalog.db")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("createReadOnlyEngineContext: serves the dashboard child's composition with auth mode none", async () => {
  await withServeRepo(async (repo) => {
    const calls: string[] = [];
    const composed = await createReadOnlyEngineContext(
      repo.repoDir,
      opener(repo, calls),
      { extensions: true },
    );
    try {
      assertEquals(composed.mode, "read-only");
      assertEquals(composed.extensions, true);
      assertEquals(composed.context.authConfig.mode, "none");
      assertEquals(composed.page.context, composed.context);
      const snapshot = await composed.health(AbortSignal.timeout(10_000)) as {
        activeRuns: unknown[];
      };
      assertEquals(snapshot.activeRuns, []);
    } finally {
      await composed.dispose();
    }
    assertEquals(calls, ["open true", "dispose"]);
  });
});

Deno.test("createReadOnlyEngineContext: an untrusted workspace with an extension datastore opens nothing", async () => {
  await withServeRepo(async (repo) => {
    await Deno.writeTextFile(
      join(repo.repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\ndatastore:\n  type: '@example/bucket'\n  config: {}\n",
    );
    const calls: string[] = [];
    await withMockedEnv({ SWAMP_DATASTORE: undefined }, async () => {
      await assertRejects(
        () =>
          createReadOnlyEngineContext(repo.repoDir, opener(repo, calls), {
            extensions: false,
          }),
        EngineWorkspaceUntrustedError,
      );
    });
    assertEquals(calls, []);
    // A filesystem datastore needs no extension code, so it opens.
    await Deno.writeTextFile(
      join(repo.repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    const composed = await withMockedEnv(
      { SWAMP_DATASTORE: undefined },
      () =>
        createReadOnlyEngineContext(repo.repoDir, opener(repo, calls), {
          extensions: false,
        }),
    );
    assertEquals(composed.extensions, false);
    await composed.dispose();
    assertEquals(calls, ["open false", "dispose"]);
  });
});

Deno.test("createReadOnlyEngineContext: an untrusted workspace refuses to read an extension type it cannot redact", async () => {
  await withServeRepo(async (repo) => {
    const definition = Definition.create({
      name: "bucket",
      globalArguments: { apiKey: "plain-secret-value" },
    });
    await repo.repoContext.definitionRepo.save(
      ModelType.create(`@example/bucket-${crypto.randomUUID()}`),
      definition,
    );
    const request = {
      type: "model.get",
      id: "get-1",
      payload: { modelIdOrName: "bucket" },
    };
    for (const extensions of [false, true]) {
      const composed = await withMockedEnv(
        { SWAMP_DATASTORE: undefined },
        () =>
          createReadOnlyEngineContext(repo.repoDir, opener(repo, []), {
            extensions,
          }),
      );
      try {
        const frames = await sendRequest(composed.context, request, null);
        const error = errorFrame(frames) as
          | { error: { code: string } }
          | undefined;
        if (extensions) {
          assertEquals(error, undefined);
        } else {
          assertEquals(error?.error.code, "workspace_untrusted");
          assert(!JSON.stringify(frames).includes("plain-secret-value"));
        }
      } finally {
        await composed.dispose();
      }
    }
  });
});
