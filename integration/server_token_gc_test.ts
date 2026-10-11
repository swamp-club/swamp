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

import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { collect } from "../src/libswamp/testing.ts";
import {
  createLibSwampContext,
  type LibSwampContext,
} from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createServerTokenCreateDeps,
  serverTokenCreate,
} from "../src/libswamp/access/token_create.ts";
import {
  createServerTokenRevokeDeps,
  serverTokenRevoke,
} from "../src/libswamp/access/token_revoke.ts";
import {
  createVaultCreateDeps,
  vaultCreate,
} from "../src/libswamp/vaults/create.ts";
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
import {
  SERVER_TOKEN_MODEL_TYPE,
  serverTokenModel,
  serverTokenSecretKey,
} from "../src/domain/models/access/server_token_model.ts";
import { createResourceWriter } from "../src/domain/models/data_writer.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { authenticateServerToken } from "../src/serve/token_auth.ts";
import {
  createServerTokenGcDeps,
  createServerTokenGcRepos,
} from "../src/serve/server_token_gc_deps.ts";
import { ServerTokenGcService } from "../src/serve/server_token_gc_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withServerTokenLock } from "../src/infrastructure/persistence/server_token_lock.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  type DatastoreConfig,
  LOCK_TIMEOUT_ENV_VAR,
} from "../src/domain/datastore/datastore_config.ts";

await initializeLogging({});

const ONE_HOUR = 60 * 60 * 1000;

async function mint(
  libCtx: LibSwampContext,
  repoDir: string,
  repoContext: RepositoryContext,
  name: string,
  durationMs: number,
): Promise<{ credential: string; expiresAt: string }> {
  const events = await collect(
    serverTokenCreate(
      libCtx,
      await createServerTokenCreateDeps(libCtx, repoDir, repoContext),
      {
        name,
        principalId: `user:${name}`,
        principalEmail: `${name}@example.com`,
        durationMs,
        vaultName: TOKEN_SECRETS_VAULT_NAME,
      },
    ),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertExists(completed, JSON.stringify(events));
  if (completed.kind !== "completed") throw new Error("unreachable");
  const secret = await (await VaultService.fromRepository(repoDir)).get(
    completed.data.vaultRef.vaultName,
    completed.data.vaultRef.secretKey,
    "test:server-token-gc",
  );
  return {
    credential: `${name}.${secret}`,
    expiresAt: completed.data.expiresAt,
  };
}

async function tokenMain(
  repoContext: RepositoryContext,
  name: string,
): Promise<Record<string, unknown> | null> {
  const definition = await repoContext.definitionRepo.findByName(
    SERVER_TOKEN_MODEL_TYPE,
    name,
  );
  if (!definition) return null;
  const content = await repoContext.unifiedDataRepo.getContent(
    SERVER_TOKEN_MODEL_TYPE,
    definition.id,
    "token-main",
  );
  return content ? JSON.parse(new TextDecoder().decode(content)) : null;
}

/** Names declared by the server-token files in the auto-definitions dir. */
async function tokenDefinitionFiles(
  repoContext: RepositoryContext,
): Promise<string[]> {
  const dir = join(
    repoContext.autoDefinitionsDir,
    SERVER_TOKEN_MODEL_TYPE.toDirectoryPath(),
  );
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
    const data = parseYaml(await Deno.readTextFile(join(dir, entry.name))) as {
      name: string;
    };
    names.push(data.name);
  }
  return names.sort();
}

/** The filesystem datastore serve runs on without a remote datastore. */
function filesystemDatastore(repoDir: string): DatastoreConfig {
  return { type: "filesystem", path: swampPath(repoDir) } as DatastoreConfig;
}

function gcService(
  repoDir: string,
  repoContext: RepositoryContext,
  libCtx: LibSwampContext,
  vaultService: VaultService,
  gracePeriodMs: number,
  pullChanged?: () => Promise<void>,
): ServerTokenGcService {
  const datastoreConfig = filesystemDatastore(repoDir);
  return new ServerTokenGcService(
    createServerTokenGcDeps({
      intervalMs: ONE_HOUR,
      gracePeriodMs,
      dataQueryService: repoContext.dataQueryService,
      // The same repositories serve builds.
      ...createServerTokenGcRepos(repoDir, repoContext),
      vaultService,
      libCtx,
      // The same lock serve passes.
      withTokenLock: (name, fn) =>
        withServerTokenLock(datastoreConfig, name, fn),
      pullChanged,
    }),
  );
}

/** Initializes a repo and registers the control-plane vault, as serve's boot does. */
async function initTokenRepo(
  repoDir: string,
  libCtx: LibSwampContext,
): Promise<void> {
  const version = "20260101.120000.0";
  const initEvents = await collect(
    repoInit(libCtx, createRepoInitDeps(version), {
      path: repoDir,
      force: false,
      version,
      tools: [],
    }),
  );
  assertEquals(initEvents.some((e) => e.kind === "error"), false);
  const provider = new ControlPlaneVaultProvider(
    new FileSystemControlPlaneStore(swampPath(repoDir)),
  );
  await provider.initialize();
  VaultService.registerGlobalProvider(
    TOKEN_SECRETS_VAULT_NAME,
    "control_plane",
    provider,
  );
}

Deno.test("server token GC: collects revoked and past-grace expired tokens across secret, data and definition, and nothing else", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-server-token-gc-" });
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
    assertEquals(initEvents.some((e) => e.kind === "error"), false);
    const vaultEvents = await collect(
      vaultCreate(libCtx, await createVaultCreateDeps(repoDir), {
        vaultType: "local_encryption",
        name: "local",
        config: { auto_generate: true, base_dir: repoDir },
        repoDir,
      }),
    );
    assertEquals(vaultEvents.some((e) => e.kind === "error"), false);

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

    const active = await mint(
      libCtx,
      repoDir,
      repoContext,
      "active-tok",
      ONE_HOUR,
    );
    const revoked = await mint(
      libCtx,
      repoDir,
      repoContext,
      "revoked-tok",
      ONE_HOUR,
    );
    const tampered = await mint(
      libCtx,
      repoDir,
      repoContext,
      "tampered-tok",
      ONE_HOUR,
    );
    await mint(libCtx, repoDir, repoContext, "reused-tok", ONE_HOUR);
    const expired = await mint(libCtx, repoDir, repoContext, "expired-tok", 1);
    await waitFor(
      () => Date.now() > Date.parse(expired.expiresAt),
      "expired-tok to expire",
    );

    for (const name of ["revoked-tok", "tampered-tok", "reused-tok"]) {
      const revokeEvents = await collect(
        serverTokenRevoke(
          libCtx,
          await createServerTokenRevokeDeps(libCtx, repoDir, repoContext),
          { name },
        ),
      );
      assertEquals(
        revokeEvents.some((e) => e.kind === "error"),
        false,
        JSON.stringify(revokeEvents),
      );
    }

    // A user secret, and a revoked token record tampered to point at it.
    const vaultService = await VaultService.fromRepository(repoDir);
    await vaultService.put("local", "prod-db-password", "hunter2");
    const tamperedDef = await repoContext.definitionRepo.findByName(
      SERVER_TOKEN_MODEL_TYPE,
      "tampered-tok",
    );
    assertExists(tamperedDef);
    const { writeResource } = createResourceWriter(
      repoContext.unifiedDataRepo,
      SERVER_TOKEN_MODEL_TYPE,
      tamperedDef.id,
      serverTokenModel.resources!,
      undefined,
      undefined,
      undefined,
      undefined,
      "tampered-tok",
    );
    await writeResource("token", "token-main", {
      ...(await tokenMain(repoContext, "tampered-tok")),
      vaultName: "local",
      secretKey: "prod-db-password",
    });

    // A user model that shares a collected token's name, used by a workflow.
    // modelDelete's workflow check matches by name.
    const userType = ModelType.create("command/shell");
    await repoContext.definitionRepo.save(
      userType,
      Definition.create({ name: "revoked-tok", version: 1 }),
    );
    await repoContext.workflowRepo.save(Workflow.create({
      name: "deploy-flow",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "run",
          task: StepTask.model("revoked-tok", "execute", {}),
        })],
      })],
    }));

    // reused-tok's definition file is lost while its revoked record stays,
    // then the name is minted again: the orphaned record and the live token
    // share the name, and with it the secret key.
    const orphanDef = await repoContext.definitionRepo.findByName(
      SERVER_TOKEN_MODEL_TYPE,
      "reused-tok",
    );
    assertExists(orphanDef);
    await Deno.remove(
      join(
        repoContext.autoDefinitionsDir,
        SERVER_TOKEN_MODEL_TYPE.toDirectoryPath(),
        "reused-tok.yaml",
      ),
    );
    const reused = await mint(
      libCtx,
      repoDir,
      repoContext,
      "reused-tok",
      ONE_HOUR,
    );
    const liveDef = await repoContext.definitionRepo.findByName(
      SERVER_TOKEN_MODEL_TYPE,
      "reused-tok",
    );
    assertExists(liveDef);
    assertNotEquals(liveDef.id, orphanDef.id);

    // With the default grace period the just-expired token is kept.
    const firstCount = await gcService(
      repoDir,
      repoContext,
      libCtx,
      vaultService,
      ONE_HOUR,
    ).runOnce();
    assertEquals(firstCount, 3);
    assertExists(await tokenMain(repoContext, "expired-tok"));

    assertEquals(await tokenDefinitionFiles(repoContext), [
      "active-tok",
      "expired-tok",
      "reused-tok",
    ]);

    // The orphaned record is gone, and the re-minted token kept its secret.
    assertEquals(
      await repoContext.unifiedDataRepo.getContent(
        SERVER_TOKEN_MODEL_TYPE,
        orphanDef.id,
        "token-main",
      ),
      null,
    );
    assertEquals(
      (await authenticateServerToken(reused.credential, repoDir, repoContext))
        .ok,
      true,
    );
    for (const name of ["revoked-tok", "tampered-tok"]) {
      assertEquals(
        await repoContext.definitionRepo.findByName(
          SERVER_TOKEN_MODEL_TYPE,
          name,
        ),
        null,
        `${name} definition should be gone`,
      );
      await assertRejects(() =>
        vaultService.get(
          TOKEN_SECRETS_VAULT_NAME,
          serverTokenSecretKey(name),
          "test:server-token-gc",
        )
      );
    }
    const revokedAuth = await authenticateServerToken(
      revoked.credential,
      repoDir,
      repoContext,
    );
    assertEquals(revokedAuth.ok, false);
    const tamperedAuth = await authenticateServerToken(
      tampered.credential,
      repoDir,
      repoContext,
    );
    assertEquals(tamperedAuth.ok, false);

    // Nothing outside the collected tokens was touched.
    assertExists(
      await repoContext.definitionRepo.findByName(userType, "revoked-tok"),
    );
    assertEquals(
      await vaultService.get(
        "local",
        "prod-db-password",
        "test:server-token-gc",
      ),
      "hunter2",
    );
    const activeAuth = await authenticateServerToken(
      active.credential,
      repoDir,
      repoContext,
    );
    assertEquals(activeAuth.ok, true);

    // With no grace period the expired token goes too.
    const secondCount = await gcService(
      repoDir,
      repoContext,
      libCtx,
      vaultService,
      0,
    ).runOnce();
    assertEquals(secondCount, 1);
    assertEquals(await tokenMain(repoContext, "expired-tok"), null);
    assertEquals(await tokenDefinitionFiles(repoContext), [
      "active-tok",
      "reused-tok",
    ]);
    assertEquals(
      (await authenticateServerToken(active.credential, repoDir, repoContext))
        .ok,
      true,
    );
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

Deno.test("server token GC: on a filesystem datastore, waits for a writer holding the token's name lock (swamp-club#2534)", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-server-token-gc-" });
  const repoContext = createRepositoryContext({ repoDir });
  try {
    const libCtx = createLibSwampContext();
    await initTokenRepo(repoDir, libCtx);
    const vaultService = await VaultService.fromRepository(repoDir);

    const token = await mint(libCtx, repoDir, repoContext, "ci", ONE_HOUR);
    const revokeEvents = await collect(
      serverTokenRevoke(
        libCtx,
        await createServerTokenRevokeDeps(libCtx, repoDir, repoContext),
        { name: "ci" },
      ),
    );
    assertEquals(
      revokeEvents.some((e) => e.kind === "error"),
      false,
      JSON.stringify(revokeEvents),
    );

    // No sync service and no sync gate, as serve runs without a remote
    // datastore. A writer (a rotation, say) holds the token's name lock for
    // the whole sweep; the short lock timeout ends the GC's wait.
    const gc = gcService(repoDir, repoContext, libCtx, vaultService, ONE_HOUR);
    await withMockedEnv({ [LOCK_TIMEOUT_ENV_VAR]: "200" }, async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holderEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        holderEntered = resolve;
      });
      const holder = withServerTokenLock(
        filesystemDatastore(repoDir),
        "ci",
        async () => {
          holderEntered();
          await held;
        },
      );
      await entered;
      try {
        assertEquals(await gc.runOnce(), 0);
      } finally {
        release();
        await holder;
      }
    });

    // The writer's token was left alone: its record and secret are intact.
    assertEquals((await tokenMain(repoContext, "ci"))?.state, "revoked");
    assertExists(
      await vaultService.get(
        TOKEN_SECRETS_VAULT_NAME,
        serverTokenSecretKey("ci"),
        "test:server-token-gc",
      ),
    );

    // Once the lock is free the next sweep collects it.
    assertEquals(await gc.runOnce(), 1);
    assertEquals(await tokenMain(repoContext, "ci"), null);
    assertEquals(
      (await authenticateServerToken(token.credential, repoDir, repoContext))
        .ok,
      false,
    );
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

Deno.test("server token GC: pulls before it re-reads, so a rotation another replica pushed is not collected (swamp-club#2534)", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-server-token-gc-" });
  const repoContext = createRepositoryContext({ repoDir });
  try {
    const libCtx = createLibSwampContext();
    await initTokenRepo(repoDir, libCtx);
    const vaultService = await VaultService.fromRepository(repoDir);

    await mint(libCtx, repoDir, repoContext, "ci", ONE_HOUR);
    const revokeEvents = await collect(
      serverTokenRevoke(
        libCtx,
        await createServerTokenRevokeDeps(libCtx, repoDir, repoContext),
        { name: "ci" },
      ),
    );
    assertEquals(
      revokeEvents.some((e) => e.kind === "error"),
      false,
      JSON.stringify(revokeEvents),
    );
    const definition = await repoContext.definitionRepo.findByName(
      SERVER_TOKEN_MODEL_TYPE,
      "ci",
    );
    assertExists(definition);
    const revokedRecord = await tokenMain(repoContext, "ci");
    assertExists(revokedRecord);

    // This replica's local copy still holds the revoked record. Another
    // replica has since rotated the token and pushed an active record and a
    // new secret; this replica's pull brings the record in.
    const { writeResource } = createResourceWriter(
      repoContext.unifiedDataRepo,
      SERVER_TOKEN_MODEL_TYPE,
      definition.id,
      serverTokenModel.resources!,
      undefined,
      undefined,
      undefined,
      undefined,
      "ci",
    );
    let pulls = 0;
    const pullChanged = async () => {
      pulls++;
      await writeResource("token", "token-main", {
        ...revokedRecord,
        state: "active",
        expiresAt: new Date(Date.now() + ONE_HOUR).toISOString(),
        revokedAt: undefined,
      });
    };

    const gc = gcService(
      repoDir,
      repoContext,
      libCtx,
      vaultService,
      ONE_HOUR,
      pullChanged,
    );
    assertEquals(await gc.runOnce(), 0);
    assertEquals(pulls, 1);

    // The rotated token survives: its record and its secret.
    assertEquals((await tokenMain(repoContext, "ci"))?.state, "active");
    assertExists(
      await vaultService.get(
        TOKEN_SECRETS_VAULT_NAME,
        serverTokenSecretKey("ci"),
        "test:server-token-gc",
      ),
    );
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
