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

import { assertEquals, assertExists } from "@std/assert";
import { collect } from "../src/libswamp/testing.ts";
import {
  createLibSwampContext,
  type LibSwampContext,
} from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createVaultCreateDeps,
  vaultCreate,
} from "../src/libswamp/vaults/create.ts";
import {
  createServerTokenCreateDeps,
  serverTokenCreate,
} from "../src/libswamp/access/token_create.ts";
import {
  createServerTokenRevokeDeps,
  serverTokenRevoke,
  type ServerTokenRevokeEvent,
} from "../src/libswamp/access/token_revoke.ts";
import {
  createServerTokenRotateDeps,
  serverTokenRotate,
} from "../src/libswamp/access/token_rotate.ts";
import {
  createWorkerTokenCreateDeps,
  workerTokenCreate,
} from "../src/libswamp/worker/token_create.ts";
import {
  createWorkerTokenRevokeDeps,
  workerTokenRevoke,
  type WorkerTokenRevokeEvent,
} from "../src/libswamp/worker/token_revoke.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../src/domain/models/access/server_token_model.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const VAULT = "local";

interface Fixture {
  libCtx: LibSwampContext;
  repoDir: string;
  repoContext: RepositoryContext;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-token-revoke-type-",
  });
  const repoContext = createRepositoryContext({ repoDir });
  try {
    const libCtx = createLibSwampContext();
    const version = "20260101.120000.0";
    const initEvents = await collect(
      repoInit(libCtx, createRepoInitDeps(version), {
        path: repoDir,
        force: false,
        version,
        tools: [],
      }),
    );
    assertEquals(initEvents.some((event) => event.kind === "error"), false);
    const vaultEvents = await collect(
      vaultCreate(libCtx, await createVaultCreateDeps(repoDir), {
        vaultType: "local_encryption",
        name: VAULT,
        config: { auto_generate: true, base_dir: repoDir },
        repoDir,
      }),
    );
    assertEquals(vaultEvents.some((event) => event.kind === "error"), false);
    await fn({ libCtx, repoDir, repoContext });
  } finally {
    repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function mintServerToken(f: Fixture, name: string): Promise<void> {
  const events = await collect(
    serverTokenCreate(
      f.libCtx,
      await createServerTokenCreateDeps(f.libCtx, f.repoDir, f.repoContext),
      {
        name,
        principalId: "user:alice",
        principalEmail: "alice@example.com",
        durationMs: 60 * 60_000,
        vaultName: VAULT,
      },
    ),
  );
  assertEquals(events.some((event) => event.kind === "error"), false);
}

async function mintWorkerToken(f: Fixture, name: string): Promise<void> {
  const events = await collect(
    workerTokenCreate(
      f.libCtx,
      await createWorkerTokenCreateDeps(f.libCtx, f.repoDir, f.repoContext),
      { name, durationMs: 60 * 60_000, vaultName: VAULT },
    ),
  );
  assertEquals(events.some((event) => event.kind === "error"), false);
}

async function revokeWorkerToken(
  f: Fixture,
  name: string,
): Promise<WorkerTokenRevokeEvent> {
  const events = await collect(
    workerTokenRevoke(
      f.libCtx,
      await createWorkerTokenRevokeDeps(f.libCtx, f.repoDir, f.repoContext),
      { name },
    ),
  );
  return events[events.length - 1];
}

async function revokeServerToken(
  f: Fixture,
  idOrName: string,
): Promise<ServerTokenRevokeEvent> {
  const events = await collect(
    serverTokenRevoke(
      f.libCtx,
      await createServerTokenRevokeDeps(f.libCtx, f.repoDir, f.repoContext),
      { name: idOrName },
    ),
  );
  return events[events.length - 1];
}

function assertRevokedNow(
  event: WorkerTokenRevokeEvent | ServerTokenRevokeEvent,
): void {
  assertEquals(event.kind, "completed", JSON.stringify(event));
  if (event.kind !== "completed") return;
  assertEquals(event.data.alreadyRevoked, false);
  assertEquals(event.data.state, "revoked");
}

function assertNotFound(
  event: WorkerTokenRevokeEvent | ServerTokenRevokeEvent,
): void {
  assertEquals(event.kind, "error", JSON.stringify(event));
  if (event.kind !== "error") return;
  assertEquals(event.error.code, "model_not_found");
}

Deno.test("worker token revoke refuses a server token's name and leaves it active", async () => {
  await withFixture(async (f) => {
    await mintServerToken(f, "srv");

    assertNotFound(await revokeWorkerToken(f, "srv"));

    assertRevokedNow(await revokeServerToken(f, "srv"));
  });
});

Deno.test("access token revoke refuses an enrollment token's name and leaves it unrevoked", async () => {
  await withFixture(async (f) => {
    await mintWorkerToken(f, "ci-runner");

    assertNotFound(await revokeServerToken(f, "ci-runner"));

    assertRevokedNow(await revokeWorkerToken(f, "ci-runner"));
  });
});

Deno.test("access token revoke still accepts a server token's definition id", async () => {
  await withFixture(async (f) => {
    await mintServerToken(f, "by-id");
    const definition = await f.repoContext.definitionRepo.findByName(
      SERVER_TOKEN_MODEL_TYPE,
      "by-id",
    );
    assertExists(definition);

    assertRevokedNow(await revokeServerToken(f, definition.id));
  });
});

Deno.test("access token rotate refuses an enrollment token's name and leaves it unrevoked", async () => {
  await withFixture(async (f) => {
    await mintWorkerToken(f, "wrk-only");

    const events = await collect(
      serverTokenRotate(
        f.libCtx,
        await createServerTokenRotateDeps(f.libCtx, f.repoDir, f.repoContext),
        { name: "wrk-only", vaultName: VAULT },
      ),
    );
    const last = events[events.length - 1];
    assertEquals(last.kind, "error", JSON.stringify(last));
    if (last.kind === "error") {
      assertEquals(last.error.code, "model_not_found");
    }

    assertRevokedNow(await revokeWorkerToken(f, "wrk-only"));
  });
});
