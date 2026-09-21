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
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../src/domain/models/access/server_token_model.ts";
import { authenticateServerToken } from "../src/serve/token_auth.ts";
import { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../src/domain/serve_audit/audit_sink.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

class CollectorSink implements AuditSink {
  readonly name = "collector";
  readonly durable = false;
  readonly events: AuditEvent[] = [];

  write(events: readonly AuditEvent[]): Promise<void> {
    this.events.push(...events);
    return Promise.resolve();
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("server token auth: direct ingress is read-only and emits a secret-free audit event", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-server-token-auth-",
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

    const name = "integration-token";
    const mintEvents = await collect(
      serverTokenCreate(
        libCtx,
        await createServerTokenCreateDeps(libCtx, repoDir, repoContext),
        {
          name,
          principalId: "user:integration",
          principalEmail: "integration@example.com",
          durationMs: 60_000,
          vaultName: "local",
        },
      ),
    );
    const mint = mintEvents.find((event) => event.kind === "completed");
    assertExists(mint);
    if (mint.kind !== "completed") return;

    const vault = await VaultService.fromRepository(repoDir);
    const secret = await vault.get(
      mint.data.vaultRef.vaultName,
      mint.data.vaultRef.secretKey,
      "test:server-token-auth",
    );
    const definition = await repoContext.definitionRepo.findByName(
      SERVER_TOKEN_MODEL_TYPE,
      name,
    );
    assertExists(definition);
    const versionsBefore = await repoContext.unifiedDataRepo.listVersions(
      SERVER_TOKEN_MODEL_TYPE,
      definition.id,
      "token-main",
    );
    const outputsBefore = await repoContext.outputRepo.findByDefinition(
      SERVER_TOKEN_MODEL_TYPE,
      definition.id,
    );

    const sink = new CollectorSink();
    const emitter = new AuditEmitter({ sinks: [sink] });
    const result = await authenticateServerToken(
      `${name}.${secret}`,
      repoDir,
      repoContext,
      {
        emitter,
        instanceId: "instance-1",
        sourceIp: "192.0.2.10",
        requestId: "request-1",
        ingress: "websocket:bearer",
      },
    );
    await emitter.flush();

    assertEquals(result, {
      ok: true,
      principalId: "user:integration",
      collectives: [],
      groups: [],
    });
    assertEquals(
      await repoContext.unifiedDataRepo.listVersions(
        SERVER_TOKEN_MODEL_TYPE,
        definition.id,
        "token-main",
      ),
      versionsBefore,
    );
    assertEquals(
      await repoContext.outputRepo.findByDefinition(
        SERVER_TOKEN_MODEL_TYPE,
        definition.id,
      ),
      outputsBefore,
    );
    assertEquals(sink.events.length, 1);
    assertEquals(sink.events[0].action, "auth.token.used");
    assertEquals(sink.events[0].resourceName, name);
    assertEquals(sink.events[0].principalId, "user:integration");
    assertEquals(sink.events[0].detail, "websocket:bearer");
    assertEquals(JSON.stringify(sink.events[0]).includes(secret), false);
  } finally {
    repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
