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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { AuditQueryService } from "../src/domain/serve_audit/audit_query_service.ts";
import { AuditChainState } from "../src/domain/serve_audit/audit_chain.ts";
import { AuditWal } from "../src/domain/serve_audit/audit_wal.ts";
import { buildAuditEvent } from "../src/domain/serve_audit/audit_event_builder.ts";
import { initializeLocalEngineAudit } from "../src/serve/local_engine_audit.ts";
import { authenticateServerToken } from "../src/serve/token_auth.ts";
import { serverTokenSecretFingerprint } from "../src/domain/models/access/server_token_model.ts";
import type { ServeConfigFile } from "../src/serve/serve_config.ts";
import { createServeCtx, withServeRepo } from "./serve_request_harness.ts";

await initializeLogging({});

const config: ServeConfigFile = {
  audit: { stores: [{ target: "local" }], "fail-open": false },
};

Deno.test("local engine audit: authentication records and chain continue across idle shutdown", async () => {
  await withServeRepo(async (repo) => {
    const canary = "credential-value-must-never-be-audited";
    const secretFingerprint = await serverTokenSecretFingerprint(canary);
    const first = createServeCtx(repo);
    const closeFirst = await initializeLocalEngineAudit(first, config);
    try {
      const result = await authenticateServerToken(
        `audit-test.${canary}`,
        repo.repoDir,
        repo.repoContext,
        {
          emitter: first.auditEmitter,
          instanceId: "first",
          sourceIp: "127.0.0.1",
        },
        {
          readToken: () =>
            Promise.resolve({
              name: "audit-test",
              state: "active",
              principalId: "user:auditor",
              principalEmail: "auditor@example.com",
              collectives: [],
              groups: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
              vaultName: "local",
              secretKey: "audit-test",
              secretFingerprint,
            }),
          readSecret: () => Promise.resolve(canary),
        },
      );
      assertEquals(result.ok, true);
    } finally {
      await closeFirst();
    }
    const position = first.auditEmitter!.chainState.sequence;
    const second = createServeCtx(repo);
    const closeSecond = await initializeLocalEngineAudit(second, config);
    await closeSecond();
    await closeSecond();
    const service = new AuditQueryService(second.auditStores![0]);
    const result = await service.query({});
    assert(result.events.length > position);
    assertEquals((await service.verify()).valid, true);
    assertEquals(
      new Set(result.events.map((e) => e.sequence)).size,
      result.events.length,
    );
    assertEquals(
      result.events.filter((e) => e.action === "auth.token.used").length,
      1,
    );
    assertEquals(JSON.stringify(result.events).includes(canary), false);
    assertEquals(second.auditWal!.segmentCount, 0);
    assertEquals(
      await second.auditWal!.loadChainState(),
      second.auditEmitter!.chainState.snapshot(),
    );
  });
});

Deno.test("local engine audit: replays an unfinished WAL before continuing its chain", async () => {
  await withServeRepo(async (repo) => {
    const wal = new AuditWal({
      dir: join(repo.repoDir, ".swamp", "audit-wal"),
    });
    await wal.initialize();
    const event = await new AuditChainState().chain(buildAuditEvent({
      instanceId: "previous",
      category: "system",
      stage: "response",
      outcome: "success",
      action: "instance.start",
      resourceKind: "server",
      resourceName: "*",
      principalKind: "system",
      principalId: "system",
      initiatedBy: "system",
      sourceIp: "local",
      requestId: crypto.randomUUID(),
    }));
    await wal.append([event]);
    const ctx = createServeCtx(repo);
    const close = await initializeLocalEngineAudit(ctx, config);
    await close();
    const service = new AuditQueryService(ctx.auditStores![0]);
    const result = await service.query({});
    assertEquals(result.events.length, 3);
    assertEquals((await service.verify()).valid, true);
    assertEquals(
      result.events.some((candidate) => candidate.digest === event.digest),
      true,
    );
    assertEquals(ctx.auditWal!.segmentCount, 0);

    // Loss of only the checkpoint is recoverable from the stored events.
    await Deno.remove(join(wal.dir, "chain-state.json"));
    const fresh = createServeCtx(repo);
    const closeFresh = await initializeLocalEngineAudit(fresh, config);
    await closeFresh();
    const recovered = new AuditQueryService(fresh.auditStores![0]);
    assertEquals((await recovered.query({})).events.length, 5);
    assertEquals((await recovered.verify()).valid, true);
  });
});
