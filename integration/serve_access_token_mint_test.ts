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

import { assertArrayIncludes, assertEquals, assertExists } from "@std/assert";
import {
  collect,
  createLibSwampContext,
  createRepoInitDeps,
  createVaultCreateDeps,
  repoInit,
  vaultCreate,
} from "../src/libswamp/mod.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "../src/domain/vaults/control_plane_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { handleAccessTokenMint } from "../src/serve/handlers/access_handlers.ts";
import { authenticateServerToken } from "../src/serve/token_auth.ts";
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

// swamp-club#2466 / #2473: serve always registers the reserved
// _token-secrets vault, so a repo with one user vault has two. The mint
// handler must target the control-plane vault rather than ask the remote
// caller for a --vault flag it cannot send.
Deno.test("handleAccessTokenMint: mints into the control-plane vault when a user vault is also configured, usable without restart", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-serve-token-mint-",
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
        name: "local",
        config: { auto_generate: true, base_dir: repoDir },
        repoDir,
      }),
    );
    assertEquals(vaultEvents.some((event) => event.kind === "error"), false);

    // Mirror serve's boot: register the control-plane vault globally.
    const provider = new ControlPlaneVaultProvider(
      new FileSystemControlPlaneStore(swampPath(repoDir)),
    );
    await provider.initialize();
    VaultService.registerGlobalProvider(
      TOKEN_SECRETS_VAULT_NAME,
      "control_plane",
      provider,
    );
    const vaultNames = (await VaultService.fromRepository(repoDir))
      .getVaultNames();
    assertArrayIncludes(vaultNames, ["local", TOKEN_SECRETS_VAULT_NAME]);

    const socket = createMockSocket();
    const ctx = {
      repoDir,
      repoContext,
      datastoreConfig: { type: "filesystem" },
      datastoreResolver: {},
      authConfig: { mode: "none" },
    } as unknown as ConnectionContext;

    await handleAccessTokenMint(
      socket,
      ctx,
      "req-1",
      {
        name: "remote-minted",
        principalId: "user:probe",
        principalEmail: "probe@example.com",
        durationMs: 15 * 60_000,
      },
      new AbortController(),
      null,
    );

    assertEquals(socket.sent.length, 1);
    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "access.token.mint", socket.sent[0]);
    const vaultRef = response.payload.data.vaultRef;
    assertExists(vaultRef);
    assertEquals(vaultRef.vaultName, TOKEN_SECRETS_VAULT_NAME);

    // The running server authenticates the token straight away, with no
    // restart: the mint wrote into this process's own repo and vault.
    const secret = await (await VaultService.fromRepository(repoDir)).get(
      vaultRef.vaultName,
      vaultRef.secretKey,
      "test:serve-token-mint",
    );
    const auth = await authenticateServerToken(
      `remote-minted.${secret}`,
      repoDir,
      repoContext,
    );
    assertEquals(auth.ok, true);
    if (auth.ok) assertEquals(auth.principalId, "user:probe");
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
