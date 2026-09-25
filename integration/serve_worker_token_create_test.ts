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

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import {
  collect,
  createDoctorVaultsDeps,
  createLibSwampContext,
  createRepoInitDeps,
  createVaultCreateDeps,
  createWorkerModelRunDeps,
  modelMethodRun,
  repoInit,
  vaultCreate,
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
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "../src/domain/models/worker/enrollment_token_model.ts";
import { handleWorkerTokenCreate } from "../src/serve/handlers/admin_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { WorkerTokenCreatePayload } from "../src/serve/protocol.ts";
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

async function removeRepo(repoDir: string): Promise<void> {
  // The control-plane vault is registered process-wide and points into this
  // repo, so drop it before the repo goes away.
  VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
  if (Deno.build.os === "windows") {
    // Best-effort: EBUSY can fire when V8 hasn't GC'd native
    // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(repoDir, { recursive: true });
  }
}

/**
 * Initializes a repo, optionally with one local_encryption user vault, and
 * registers the control-plane vault globally the way serve boot does.
 */
async function createServeRepo(
  userVault: string | undefined,
): Promise<{ repoDir: string; repoContext: RepositoryContext }> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-serve-worker-token-",
  });
  const repoContext = createRepositoryContext({ repoDir });
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

  if (userVault !== undefined) {
    const vaultEvents = await collect(
      vaultCreate(libCtx, await createVaultCreateDeps(repoDir), {
        vaultType: "local_encryption",
        name: userVault,
        config: { auto_generate: true, base_dir: repoDir },
        repoDir,
      }),
    );
    assertEquals(vaultEvents.some((event) => event.kind === "error"), false);
  }

  const provider = new ControlPlaneVaultProvider(
    new FileSystemControlPlaneStore(swampPath(repoDir)),
  );
  await provider.initialize();
  VaultService.registerGlobalProvider(
    TOKEN_SECRETS_VAULT_NAME,
    "control_plane",
    provider,
  );
  return { repoDir, repoContext };
}

async function createWorkerToken(
  repoDir: string,
  repoContext: RepositoryContext,
  payload: WorkerTokenCreatePayload,
): Promise<Record<string, unknown>> {
  const socket = createMockSocket();
  const ctx = {
    repoDir,
    repoContext,
    datastoreConfig: { type: "filesystem" },
    datastoreResolver: {},
    authConfig: { mode: "none" },
  } as unknown as ConnectionContext;
  await handleWorkerTokenCreate(
    socket,
    ctx,
    "req-1",
    payload,
    new AbortController(),
    null,
  );
  assertEquals(socket.sent.length, 1);
  return JSON.parse(socket.sent[0]);
}

async function redeem(
  repoDir: string,
  repoContext: RepositoryContext,
  name: string,
  presentedToken: string,
) {
  const libCtx = createLibSwampContext();
  return await collect(
    modelMethodRun(
      libCtx,
      await createWorkerModelRunDeps(repoDir, repoContext),
      {
        modelIdOrName: name,
        methodName: "redeem",
        inputs: { presentedToken, machineId: "machine-1" },
        lastEvaluated: false,
        typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
        definitionName: name,
      },
    ),
  );
}

// swamp-club#2422: serve always registers the reserved _token-secrets vault,
// so a repo with one user vault has two. Without --vault the handler must
// pick the control-plane vault instead of failing with "Multiple vaults are
// configured"; an explicit --vault must still be honoured.
Deno.test("handleWorkerTokenCreate: stores the secret in the control-plane vault when --vault is omitted", async () => {
  const { repoDir, repoContext } = await createServeRepo("local");
  try {
    const response = await createWorkerToken(repoDir, repoContext, {
      name: "w-default",
      durationMs: 60 * 60_000,
    });
    assertEquals(
      response.type,
      "worker.token.create",
      JSON.stringify(response),
    );
    const data = (response.payload as { data: Record<string, unknown> }).data;
    const vaultRef = data.vaultRef as { vaultName: string; secretKey: string };
    assertEquals(vaultRef.vaultName, TOKEN_SECRETS_VAULT_NAME);

    const secret = await (await VaultService.fromRepository(repoDir)).get(
      vaultRef.vaultName,
      vaultRef.secretKey,
      "test:serve-worker-token",
    );
    assertEquals(data.token, `w-default.${secret}`);
  } finally {
    await removeRepo(repoDir);
  }
});

Deno.test("handleWorkerTokenCreate: an explicit --vault stores the secret in that vault, and the token still redeems", async () => {
  const { repoDir, repoContext } = await createServeRepo("local");
  try {
    const response = await createWorkerToken(repoDir, repoContext, {
      name: "w-user-vault",
      durationMs: 60 * 60_000,
      vaultName: "local",
    });
    assertEquals(
      response.type,
      "worker.token.create",
      JSON.stringify(response),
    );
    const data = (response.payload as { data: Record<string, unknown> }).data;
    const vaultRef = data.vaultRef as { vaultName: string; secretKey: string };
    assertEquals(vaultRef.vaultName, "local");

    const secret = await (await VaultService.fromRepository(repoDir)).get(
      "local",
      vaultRef.secretKey,
      "test:serve-worker-token",
    );
    assertExists(secret);

    // Redeem reads the secret from the vault recorded on the token, so a
    // token kept in a user vault enrolls. A wrong secret is still refused.
    const wrong = await redeem(repoDir, repoContext, "w-user-vault", "nope");
    assertEquals(wrong.some((event) => event.kind === "error"), true);
    const events = await redeem(repoDir, repoContext, "w-user-vault", secret);
    assertEquals(
      events.filter((event) => event.kind === "error"),
      [],
    );
  } finally {
    await removeRepo(repoDir);
  }
});

Deno.test("handleWorkerTokenCreate: an unknown --vault is rejected, not replaced by the default", async () => {
  const { repoDir, repoContext } = await createServeRepo("local");
  try {
    const response = await createWorkerToken(repoDir, repoContext, {
      name: "w-typo",
      durationMs: 60 * 60_000,
      vaultName: "no-such-vault",
    });
    assertEquals(response.type, "error", JSON.stringify(response));
    const error = response.error as { code: string; message: string };
    assertEquals(error.code, "worker_token_create_failed");
    assertStringIncludes(error.message, "'no-such-vault' is not configured");
  } finally {
    await removeRepo(repoDir);
  }
});

// The same miscount made `doctor vaults` on serve report a vault when the
// only one registered was the reserved control-plane vault.
Deno.test("createDoctorVaultsDeps: hasVault ignores the control-plane vault serve registers", async () => {
  const bare = await createServeRepo(undefined);
  try {
    assertEquals(
      (await VaultService.fromRepository(bare.repoDir)).getVaultNames(),
      [TOKEN_SECRETS_VAULT_NAME],
    );
    assertEquals(
      await (await createDoctorVaultsDeps(bare.repoDir)).hasVault(),
      false,
    );
  } finally {
    await removeRepo(bare.repoDir);
  }

  const withVault = await createServeRepo("local");
  try {
    assertEquals(
      await (await createDoctorVaultsDeps(withVault.repoDir)).hasVault(),
      true,
    );

    // The teardown in removeRepo leaves no control-plane vault behind.
    VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
    assertEquals(
      (await VaultService.fromRepository(withVault.repoDir)).getVaultNames(),
      ["local"],
    );
  } finally {
    await removeRepo(withVault.repoDir);
  }
});
