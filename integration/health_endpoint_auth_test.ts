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

/**
 * Wires a real minted server token through the HTTP auth guards the health
 * endpoints use: any valid token reads health, narrowed to what it may read,
 * while admin routes still need admin on access:* (swamp-club#2504).
 */

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
import type { AccessDecisionService } from "../src/domain/access/access_decision_service.ts";
import type { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import {
  type AdminAuthDeps,
  authenticateAdmin,
  authenticateToken,
  createReadAuthorizer,
} from "../src/serve/admin_auth.ts";
import type { HealthSnapshot } from "../src/serve/health_collector.ts";
import { healthSnapshotFor } from "../src/serve/health_snapshot_view.ts";
import { readServerTokenRecord } from "../src/serve/token_auth.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

/** A policy with no grants: nothing is allowed, admin included. */
function denyAll(): PolicySnapshotLoader {
  const service: AccessDecisionService = {
    decide: () => null,
    explain: () => [],
    hasAnyGrantForKind: () => false,
  };
  return { decisionService: service } as unknown as PolicySnapshotLoader;
}

Deno.test("health endpoint auth: a valid token without grants reads health with nothing it may not read, and no admin routes", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-health-auth-" });
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

    const name = `operator-${crypto.randomUUID()}`;
    const mintEvents = await collect(
      serverTokenCreate(
        libCtx,
        await createServerTokenCreateDeps(libCtx, repoDir, repoContext),
        {
          name,
          principalId: "user:operator",
          principalEmail: "operator@example.com",
          durationMs: 60_000,
          vaultName: "local",
        },
      ),
    );
    const mint = mintEvents.find((event) => event.kind === "completed");
    assertExists(mint);
    if (mint.kind !== "completed") return;
    const secret = await VaultService.fromRepository(repoDir).then((vault) =>
      vault.get(
        mint.data.vaultRef.vaultName,
        mint.data.vaultRef.secretKey,
        "test:health-endpoint-auth",
      )
    );

    const deps: AdminAuthDeps = {
      authMode: "token",
      repoDir,
      repoContext,
      policySnapshotLoader: denyAll(),
      trustProxy: false,
    };
    const request = (path: string) =>
      new Request(`http://localhost${path}`, {
        headers: { authorization: `Bearer ${name}.${secret}` },
      });

    const health = await authenticateToken(
      request("/api/v1/health/stream"),
      "192.0.2.30",
      deps,
    );
    assertEquals(health.ok, true);
    if (!health.ok) return;
    assertEquals(health.authResult.principalId, "user:operator");
    assertEquals(health.token, {
      name,
      createdAt: (await readServerTokenRecord(repoContext, name)).createdAt,
    });
    assertEquals(health.clientAddr, "192.0.2.30");

    const view = healthSnapshotFor(
      {
        instanceId: "instance-1",
        deploymentMode: "local",
        remoteOnly: false,
        uptimeMs: 1,
        ready: true,
        activeRuns: [{
          runId: "r1",
          kind: "workflow-run",
          resourceName: "nightly",
          durationMs: 1,
          principalId: "user:admin",
        }],
        metrics: {
          windowMs: 1,
          completions: 0,
          failures: 0,
          cancellations: 0,
          throughputPerMinute: 0,
          latency: null,
        },
        workers: [],
        scheduling: {
          enabled: true,
          schedules: [{
            workflowId: "1",
            workflowName: "nightly",
            cronExpression: "0 3 * * *",
            nextRun: null,
            running: false,
          }],
        },
        webhooks: [{ route: "/hooks/n", workflow: "nightly", scheme: "hmac" }],
        components: [{
          name: "datastore",
          healthy: true,
          message: "ok",
          latencyMs: 1,
        }],
      } satisfies HealthSnapshot,
      createReadAuthorizer(health.authResult, deps),
    );
    assertEquals(view.activeRuns, []);
    assertEquals(view.scheduling.schedules, []);
    assertEquals(view.webhooks, []);
    assertEquals(view.components, []);

    const admin = await authenticateAdmin(
      request("/api/v1/serve/config"),
      "192.0.2.30",
      deps,
    );
    assertEquals(admin.ok, false);
    if (!admin.ok) assertEquals(admin.response.status, 403);
  } finally {
    repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
