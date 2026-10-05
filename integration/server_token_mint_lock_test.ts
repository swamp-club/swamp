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

// Server token writers against a real repository on disk: the name lock that
// serialises them and the secret fingerprint that catches a record left
// beside another mint's secret (swamp-club#2482).

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  collect,
  createLibSwampContext,
  createRepoInitDeps,
  createServerTokenRevealDeps,
  repoInit,
  serverTokenReveal,
} from "../src/libswamp/mod.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "../src/domain/vaults/control_plane_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../src/domain/datastore/datastore_sync_service.ts";
import {
  serverTokenSecretFingerprint,
  serverTokenSecretKey,
} from "../src/domain/models/access/server_token_model.ts";
import { createServerTokenLock } from "../src/infrastructure/persistence/server_token_lock.ts";
import {
  handleAccessTokenMint,
  handleAccessTokenRotate,
  withServerTokenWriteLock,
} from "../src/serve/handlers/access_handlers.ts";
import {
  authenticateServerToken,
  readServerTokenRecord,
} from "../src/serve/token_auth.ts";
import { createTokenMigrationLockDeps } from "../src/serve/token_secret_migration.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

function createMockSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
    close() {},
  } as unknown as WebSocket & { sent: string[] };
}

interface Fixture {
  repoDir: string;
  repoContext: RepositoryContext;
  ctx: ConnectionContext;
  vault: VaultService;
}

/** An initialized repo with serve's control-plane vault registered. */
async function withServeRepo(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-token-lock-" });
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

    const provider = new ControlPlaneVaultProvider(
      new FileSystemControlPlaneStore(swampPath(repoDir)),
    );
    await provider.initialize();
    VaultService.registerGlobalProvider(
      TOKEN_SECRETS_VAULT_NAME,
      "control_plane",
      provider,
    );

    const ctx = {
      repoDir,
      repoContext,
      datastoreConfig: { type: "filesystem", path: swampPath(repoDir) },
      datastoreResolver: {},
      authConfig: { mode: "none" },
    } as unknown as ConnectionContext;
    await fn({
      repoDir,
      repoContext,
      ctx,
      vault: await VaultService.fromRepository(repoDir),
    });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** The mint handler alone, for a caller that already holds the name lock. */
async function mintUnlocked(
  ctx: ConnectionContext,
  name: string,
  principalId: string,
  socket = createMockSocket(),
): Promise<{ type: string }> {
  await handleAccessTokenMint(
    socket,
    ctx,
    "req",
    {
      name,
      principalId,
      principalEmail: `${principalId}@example.com`,
      durationMs: 15 * 60_000,
    },
    new AbortController(),
    null,
  );
  assertEquals(socket.sent.length, 1);
  return JSON.parse(socket.sent[0]);
}

/** A mint as serve's dispatch runs it: under the token's name lock. */
async function mintOverServe(
  ctx: ConnectionContext,
  name: string,
  principalId: string,
): Promise<{ type: string }> {
  const socket = createMockSocket();
  let reply: { type: string } | undefined;
  await withServerTokenWriteLock(socket, ctx, "req", null, name, async () => {
    reply = await mintUnlocked(ctx, name, principalId, socket);
  });
  return reply!;
}

function readSecret(vault: VaultService, name: string): Promise<string> {
  return vault.get(
    TOKEN_SECRETS_VAULT_NAME,
    serverTokenSecretKey(name),
    "test:server-token-lock",
  );
}

Deno.test("server token name lock: a mint waits for the writer holding the name, then sees its token", async () => {
  await withServeRepo(async ({ repoDir, repoContext, ctx, vault }) => {
    const name = "raced";
    const holder = await createServerTokenLock(ctx.datastoreConfig, name);

    // Bob's mint starts first but the name is held, as it is while another
    // process mints. Alice's mint is that other writer: it runs to completion
    // before the lock is released. Unserialised, bob would have won.
    await holder.acquire();
    let bob: Promise<{ type: string }>;
    let alice: { type: string };
    try {
      bob = mintOverServe(ctx, name, "user:bob");
      alice = await mintUnlocked(ctx, name, "user:alice");
    } finally {
      await holder.release();
    }

    assertEquals(alice.type, "access.token.mint");
    assertEquals((await bob).type, "error");

    const record = await readServerTokenRecord(repoContext, name);
    const secret = await readSecret(vault, name);
    assertEquals(record.principalId, "user:alice");
    assertEquals(
      record.secretFingerprint,
      await serverTokenSecretFingerprint(secret),
    );

    const auth = await authenticateServerToken(
      `${name}.${secret}`,
      repoDir,
      repoContext,
    );
    assertEquals(auth.ok, true);
    if (auth.ok) assertEquals(auth.principalId, "user:alice");
  });
});

Deno.test("server token name lock: the lock is free once a mint has replied", async () => {
  await withServeRepo(async ({ ctx }) => {
    await mintOverServe(ctx, "released", "user:alice");
    const lock = await createServerTokenLock(ctx.datastoreConfig, "released");
    assertEquals(await lock.inspect(), null);
  });
});

Deno.test("server token fingerprint: a record beside another mint's secret is rejected, revealed as inconsistent, and repaired by rotate", async () => {
  await withServeRepo(async ({ repoDir, repoContext, ctx, vault }) => {
    const name = "mispaired";
    await mintOverServe(ctx, name, "user:alice");

    // Another mint's secret lands in the vault while alice's record stays:
    // the state an unserialised race leaves behind.
    const otherSecret = "f".repeat(64);
    await vault.put(
      TOKEN_SECRETS_VAULT_NAME,
      serverTokenSecretKey(name),
      otherSecret,
    );

    const auth = await authenticateServerToken(
      `${name}.${otherSecret}`,
      repoDir,
      repoContext,
    );
    assertEquals(auth.ok, false);
    if (!auth.ok) assertEquals(auth.reason, "mispaired-secret");

    const libCtx = createLibSwampContext();
    const revealDeps = createServerTokenRevealDeps(
      repoContext.dataQueryService,
      vault,
    );
    const refused = await collect(serverTokenReveal(libCtx, revealDeps, name));
    const refusal = refused.at(-1)!;
    assertEquals(refusal.kind, "error");
    if (refusal.kind === "error") {
      assertEquals(refusal.error.code, "token_inconsistent");
    }

    const socket = createMockSocket();
    await withServerTokenWriteLock(
      socket,
      ctx,
      "req",
      null,
      name,
      () =>
        handleAccessTokenRotate(
          socket,
          ctx,
          "req",
          { name },
          new AbortController(),
          null,
        ),
    );
    assertEquals(JSON.parse(socket.sent[0]).type, "access.token.rotate");

    const rotatedSecret = await readSecret(vault, name);
    assertNotEquals(rotatedSecret, otherSecret);
    const repaired = await authenticateServerToken(
      `${name}.${rotatedSecret}`,
      repoDir,
      repoContext,
    );
    assertEquals(repaired.ok, true);
    if (repaired.ok) assertEquals(repaired.principalId, "user:alice");
  });
});

Deno.test("createTokenMigrationLockDeps: pulls, runs and pushes while holding the token's name lock, and re-reads the stored record", async () => {
  await withServeRepo(async ({ repoContext, ctx }) => {
    const name = "legacy";
    await mintOverServe(ctx, name, "user:alice");

    const observer = await createServerTokenLock(ctx.datastoreConfig, name);
    const events: string[] = [];
    const held = async (what: string) => {
      events.push(`${what}:${(await observer.inspect()) !== null}`);
    };
    const syncService: DatastoreSyncService = {
      async pullChanged(_options?: DatastoreSyncOptions) {
        await held("pull");
        return 0;
      },
      async pushChanged(_options?: DatastoreSyncOptions) {
        await held("push");
        return 0;
      },
      markDirty: () => Promise.resolve(),
    };
    const deps = createTokenMigrationLockDeps({
      datastoreConfig: ctx.datastoreConfig,
      repoContext,
      syncService,
      syncGate: undefined,
    });

    const stored = await deps.withTokenLock(name, async () => {
      await held("body");
      return await deps.readTokenRecord(name);
    });

    assertEquals(events, ["pull:true", "body:true", "push:true"]);
    assertEquals(await observer.inspect(), null);
    assert(stored !== null);
    assertEquals(stored.principalId, "user:alice");
    assertEquals(await deps.readTokenRecord("never-minted"), null);
  });
});
