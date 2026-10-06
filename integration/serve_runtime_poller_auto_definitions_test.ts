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

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { copy, exists } from "@std/fs";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  collect,
  createLibSwampContext,
  createRepoInitDeps,
  createServerTokenCreateDeps,
  createVaultCreateDeps,
  repoInit,
  serverTokenCreate,
  vaultCreate,
} from "../src/libswamp/mod.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../src/domain/datastore/datastore_sync_service.ts";
import {
  readServerTokenRecord,
  ServerTokenNotFoundError,
} from "../src/serve/token_auth.ts";
import { RuntimeDataPoller } from "../src/serve/runtime_data_poller.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const VERSION = "20260101.120000.0";

async function initRepo(prefix: string): Promise<string> {
  const repoDir = await Deno.makeTempDir({ prefix });
  const initEvents = await collect(
    repoInit(createLibSwampContext(), createRepoInitDeps(VERSION), {
      path: repoDir,
      force: false,
      version: VERSION,
      tools: [],
    }),
  );
  assertEquals(initEvents.some((event) => event.kind === "error"), false);
  return repoDir;
}

async function removeRepo(
  repoContext: RepositoryContext,
  repoDir: string,
): Promise<void> {
  repoContext.catalogStore.close();
  if (Deno.build.os === "windows") {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(repoDir, { recursive: true });
  }
}

/**
 * Stands in for a remote datastore a peer replica has pushed to: a pull
 * copies the peer's files into this replica's cache, but only for the
 * subdirectories the caller asked for, as a scoped pull does.
 */
function createPeerSyncService(
  peerRepoDir: string,
  localRepoDir: string,
): DatastoreSyncService & { pulledSubdirs: string[][] } {
  const service = {
    pulledSubdirs: [] as string[][],
    async pullChanged(options?: DatastoreSyncOptions): Promise<number> {
      const subdirs = [...(options?.subdirs ?? [])];
      service.pulledSubdirs.push(subdirs);
      let copied = 0;
      for (const subdir of subdirs) {
        const source = swampPath(peerRepoDir, subdir);
        if (!await exists(source)) continue;
        await copy(source, swampPath(localRepoDir, subdir), {
          overwrite: true,
        });
        copied++;
      }
      return copied;
    },
    pushChanged(): Promise<number> {
      return Promise.resolve(0);
    },
    async markDirty(): Promise<void> {},
  };
  return service;
}

Deno.test("RuntimeDataPoller: a server token minted on a peer replica becomes readable after a poll", async () => {
  const peerDir = await initRepo("swamp-poller-peer-");
  const localDir = await initRepo("swamp-poller-local-");
  const peerContext = createRepositoryContext({ repoDir: peerDir });
  const localContext = createRepositoryContext({ repoDir: localDir });
  try {
    const libCtx = createLibSwampContext();
    const vaultEvents = await collect(
      vaultCreate(libCtx, await createVaultCreateDeps(peerDir), {
        vaultType: "local_encryption",
        name: "local",
        config: { auto_generate: true, base_dir: peerDir },
        repoDir: peerDir,
      }),
    );
    assertEquals(vaultEvents.some((event) => event.kind === "error"), false);

    const name = `peer-token-${crypto.randomUUID()}`;
    const mintEvents = await collect(
      serverTokenCreate(
        libCtx,
        await createServerTokenCreateDeps(libCtx, peerDir, peerContext),
        {
          name,
          principalId: "user:peer",
          principalEmail: "peer@example.com",
          durationMs: 60_000,
          vaultName: "local",
        },
      ),
    );
    assertExists(mintEvents.find((event) => event.kind === "completed"));
    const minted = await readServerTokenRecord(peerContext, name);

    const sync = createPeerSyncService(peerDir, localDir);

    // The scope the poller had before swamp-club#2481: the token's record
    // arrives, its definition does not, and the token cannot be resolved.
    await sync.pullChanged({ subdirs: ["data"] });
    await assertRejects(
      () => readServerTokenRecord(localContext, name),
      ServerTokenNotFoundError,
    );

    const pullsBeforePoller = sync.pulledSubdirs.length;
    const poller = new RuntimeDataPoller({
      syncService: sync,
      catalogInvalidate: () => localContext.catalogStore.invalidate(),
      pollIntervalMs: 20,
    });
    poller.start();
    try {
      await waitFor(
        () => sync.pulledSubdirs.length > pullsBeforePoller,
        "the poller to pull once",
      );
    } finally {
      await poller.stop();
    }

    const resolved = await readServerTokenRecord(localContext, name);
    assertEquals(resolved.principalId, "user:peer");
    assertEquals(resolved.createdAt, minted.createdAt);
  } finally {
    await removeRepo(peerContext, peerDir);
    await removeRepo(localContext, localDir);
  }
});
