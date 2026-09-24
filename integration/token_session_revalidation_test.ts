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
 * Wires the real server token model, repository reads, connection registry and
 * audit emitter together to check that a token losing its authority ends the
 * WebSocket sessions already open with it (swamp-club#2454).
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  collect,
  createLibSwampContext,
  createRepoInitDeps,
  createServerTokenCreateDeps,
  createServerTokenRevokeDeps,
  createServerTokenRotateDeps,
  repoInit,
  serverTokenCreate,
  serverTokenRevoke,
  serverTokenRotate,
} from "../src/libswamp/mod.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { initializeControlPlaneVault } from "../src/domain/vaults/control_plane_vault_init.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../src/domain/vaults/control_plane_vault_provider.ts";
import { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../src/domain/serve_audit/audit_sink.ts";
import type { AccessDecisionService } from "../src/domain/access/access_decision_service.ts";
import type { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import { readServerTokenRecord } from "../src/serve/token_auth.ts";
import {
  type ConnectionContext,
  listTokenSessions,
  removeConnection,
  setConnectionCollectives,
  setConnectionSourceIp,
  setConnectionToken,
  terminateTokenSessions,
} from "../src/serve/handlers/shared.ts";
import {
  handleAccessTokenRevoke,
  handleAccessTokenRotate,
} from "../src/serve/handlers/access_handlers.ts";
import {
  DEFAULT_TOKEN_SESSION_REVALIDATION_MS,
  TokenSessionRevalidationService,
} from "../src/serve/token_session_revalidation_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

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

interface FakeSession {
  socket: WebSocket;
  sent: string[];
  closes: { code?: number; reason?: string }[];
}

/**
 * A socket bound the way the WebSocket upgrade binds one. `log` records sends
 * and closes in order across sockets.
 */
function openSession(
  name: string,
  createdAt: string,
  principalId: string,
  log: string[] = [],
): FakeSession {
  const sent: string[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      sent.push(data);
      log.push(`send:${name}`);
    },
    close: (code?: number, reason?: string) => {
      closes.push({ code, reason });
      log.push(`close:${name}`);
      removeConnection(socket);
    },
  } as unknown as WebSocket;
  setConnectionCollectives(socket, [], [], principalId);
  setConnectionToken(socket, { name, createdAt, principalId });
  setConnectionSourceIp(socket, "192.0.2.44");
  return { socket, sent, closes };
}

function allowAll(): AccessDecisionService {
  return {
    decide: () => ({
      effect: "allow",
      grantId: "test-grant",
      subject: { kind: "user" as const, name: "admin" },
    }),
    explain: () => [],
    hasAnyGrantForKind: () => true,
  };
}

interface Repo {
  repoDir: string;
  repoContext: RepositoryContext;
  mint(name: string, principalId: string, durationMs?: number): Promise<string>;
  createdAt(name: string): Promise<string>;
  ctx(emitter: AuditEmitter): ConnectionContext;
}

async function withRepo(fn: (repo: Repo) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-token-sessions-" });
  const repoContext = createRepositoryContext({ repoDir });
  const libCtx = createLibSwampContext();
  try {
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
    await initializeControlPlaneVault(
      new FileSystemControlPlaneStore(swampPath(repoDir)),
      false,
    );

    const repo: Repo = {
      repoDir,
      repoContext,
      async mint(name, principalId, durationMs = 60 * 60 * 1000) {
        const events = await collect(
          serverTokenCreate(
            libCtx,
            await createServerTokenCreateDeps(libCtx, repoDir, repoContext),
            {
              name,
              principalId,
              principalEmail: `${name}@example.com`,
              durationMs,
              vaultName: TOKEN_SECRETS_VAULT_NAME,
            },
          ),
        );
        const done = events.find((event) => event.kind === "completed");
        assertExists(done, `mint ${name}: ${JSON.stringify(events)}`);
        return await repo.createdAt(name);
      },
      async createdAt(name) {
        return (await readServerTokenRecord(repoContext, name)).createdAt;
      },
      ctx(emitter) {
        return {
          repoDir,
          repoContext,
          datastoreConfig: {
            type: "filesystem",
          } as ConnectionContext["datastoreConfig"],
          datastoreResolver: {} as ConnectionContext["datastoreResolver"],
          policySnapshotLoader: {
            decisionService: allowAll(),
          } as unknown as PolicySnapshotLoader,
          authConfig: {
            mode: "token",
            admins: [],
            allowedCollectives: [],
            allowedUsers: [],
            oauthProvider: "",
            groupsField: "groups",
            restrictedModelTypes: [],
            restrictedCommands: [],
            approveRequiresExplicitGrant: false,
          },
          auditEmitter: emitter,
          instanceId: "instance-1",
        };
      },
    };
    await fn(repo);
  } finally {
    repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

const ADMIN: Principal = { kind: "user", id: "admin" };

function terminated(sink: CollectorSink): AuditEvent[] {
  return sink.events.filter((e) => e.action === "auth.session.terminated");
}

Deno.test("revoke handler: ends the revoked token's sessions, after replying, and audits each", async () => {
  await withRepo(async (repo) => {
    const victim = `victim-${crypto.randomUUID()}`;
    const other = `other-${crypto.randomUUID()}`;
    const victimMint = await repo.mint(victim, "user:alice");
    const otherMint = await repo.mint(other, "user:alice");
    const sink = new CollectorSink();
    const emitter = new AuditEmitter({ sinks: [sink] });
    const log: string[] = [];

    // The caller revokes the very token their own session is open with.
    const caller = openSession(victim, victimMint, "user:alice", log);
    const second = openSession(victim, victimMint, "user:alice");
    const survivor = openSession(other, otherMint, "user:alice");

    await handleAccessTokenRevoke(
      caller.socket,
      repo.ctx(emitter),
      "req-revoke",
      { name: victim },
      new AbortController(),
      ADMIN,
    );
    await emitter.flush();

    assertEquals(JSON.parse(caller.sent[0]).type, "access.token.revoke");
    assertEquals(log, [`send:${victim}`, `close:${victim}`]);
    assertEquals(caller.closes, [{
      code: 4003,
      reason: "Session revoked: token revoked",
    }]);
    assertEquals(second.closes, [{
      code: 4003,
      reason: "Session revoked: token revoked",
    }]);
    assertEquals(survivor.closes, []);

    const events = terminated(sink);
    assertEquals(events.length, 2);
    for (const event of events) {
      assertEquals(event.category, "auth");
      assertEquals(event.resourceName, victim);
      assertEquals(event.principalId, "alice");
      assertEquals(event.initiatedBy, "user:admin");
      assertEquals(event.sourceIp, "192.0.2.44");
      assertEquals(event.requestId, "req-revoke");
      assertEquals(event.detail, "revoked");
    }
    terminateTokenSessions(other, {
      code: 1000,
      reason: "test cleanup",
      cause: "revoked",
      initiatedBy: "system",
    });
  });
});

Deno.test("revoke handler: a revoke that completes after cancellation still ends the sessions", async () => {
  await withRepo(async (repo) => {
    const name = `cancelled-${crypto.randomUUID()}`;
    const mint = await repo.mint(name, "user:alice");
    const session = openSession(name, mint, "user:alice");
    const caller = openSession(
      `admin-${crypto.randomUUID()}`,
      mint,
      "user:admin",
    );
    const controller = new AbortController();
    controller.abort();

    await handleAccessTokenRevoke(
      caller.socket,
      repo.ctx(new AuditEmitter({ sinks: [] })),
      "req-cancelled",
      { name },
      controller,
      ADMIN,
    );

    // The revoke itself is not cancellable once running, so it persisted.
    assertEquals(
      (await readServerTokenRecord(repo.repoContext, name)).state,
      "revoked",
    );
    assertEquals(JSON.parse(caller.sent[0]).error.code, "cancelled");
    assertEquals(session.closes.map((c) => c.code), [4003]);
  });
});

Deno.test("rotate handler: ends sessions on the old credential and rotation rewrites createdAt", async () => {
  await withRepo(async (repo) => {
    const name = `rot-${crypto.randomUUID()}`;
    const oldMint = await repo.mint(name, "user:alice");
    const sink = new CollectorSink();
    const emitter = new AuditEmitter({ sinks: [sink] });
    const oldSession = openSession(name, oldMint, "user:alice");
    const callerToken = `admin-${crypto.randomUUID()}`;
    const caller = openSession(callerToken, oldMint, "user:admin");

    // createdAt has millisecond resolution; make sure the rotation's clock has
    // moved on from the mint's, as it always has outside a test.
    await waitFor(
      () => Date.now() > Date.parse(oldMint),
      "the clock to pass the mint",
    );
    await handleAccessTokenRotate(
      caller.socket,
      repo.ctx(emitter),
      "req-rotate",
      { name },
      new AbortController(),
      ADMIN,
    );
    await emitter.flush();

    assertEquals(JSON.parse(caller.sent[0]).type, "access.token.rotate");
    const newMint = await repo.createdAt(name);
    assert(
      newMint !== oldMint,
      "rotation must rewrite createdAt, or rotated sessions cannot be told apart",
    );
    assertEquals(oldSession.closes.length, 1);
    assertEquals(oldSession.closes[0].code, 4003);
    assertEquals(caller.closes, []);

    const events = terminated(sink);
    assertEquals(events.length, 1);
    assertEquals(events[0].detail, "rotated");
    assertEquals(events[0].initiatedBy, "user:admin");
    terminateTokenSessions(callerToken, {
      code: 1000,
      reason: "test cleanup",
      cause: "revoked",
      initiatedBy: "system",
    });
  });
});

Deno.test("revalidation: ends sessions revoked, rotated or expired outside this instance", async () => {
  await withRepo(async (repo) => {
    const libCtx = createLibSwampContext();
    const revoked = `revoked-${crypto.randomUUID()}`;
    const rotated = `rotated-${crypto.randomUUID()}`;
    const expiring = `expiring-${crypto.randomUUID()}`;
    const healthy = `healthy-${crypto.randomUUID()}`;
    const revokedMint = await repo.mint(revoked, "user:alice");
    const rotatedMint = await repo.mint(rotated, "user:bob");
    const expiringMint = await repo.mint(expiring, "user:carol", 1);
    const healthyMint = await repo.mint(healthy, "user:alice");

    const revokedSession = openSession(revoked, revokedMint, "user:alice");
    const rotatedSession = openSession(rotated, rotatedMint, "user:bob");
    const expiringSession = openSession(expiring, expiringMint, "user:carol");
    const healthySession = openSession(healthy, healthyMint, "user:alice");

    // Changes made straight against the repository, as the CLI or an HA peer
    // (via the datastore poller) would make them — no handler is involved.
    await collect(
      serverTokenRevoke(
        libCtx,
        await createServerTokenRevokeDeps(
          libCtx,
          repo.repoDir,
          repo.repoContext,
        ),
        { name: revoked },
      ),
    );
    await waitFor(
      () => Date.now() > Date.parse(rotatedMint),
      "the clock to pass the mint",
    );
    await collect(
      serverTokenRotate(
        libCtx,
        await createServerTokenRotateDeps(
          libCtx,
          repo.repoDir,
          repo.repoContext,
        ),
        { name: rotated },
      ),
    );
    const rotatedNewMint = await repo.createdAt(rotated);
    const reconnected = openSession(rotated, rotatedNewMint, "user:bob");
    const expiresAt = (await readServerTokenRecord(repo.repoContext, expiring))
      .expiresAt;
    await waitFor(
      () => Date.now() > Date.parse(expiresAt),
      "the short-lived token to expire",
    );

    const sink = new CollectorSink();
    const emitter = new AuditEmitter({ sinks: [sink] });
    // The connection registry is process-wide; only look at this test's tokens.
    const mine = new Set([revoked, rotated, expiring, healthy]);
    const service = new TokenSessionRevalidationService({
      intervalMs: DEFAULT_TOKEN_SESSION_REVALIDATION_MS,
      listTokenSessions: () =>
        listTokenSessions().filter((s) => mine.has(s.name)),
      readToken: (name) => readServerTokenRecord(repo.repoContext, name),
      terminateSessions: (name, options) =>
        terminateTokenSessions(name, {
          ...options,
          initiatedBy: "system",
          audit: { emitter, instanceId: "instance-1" },
        }),
    });

    await service.runOnce();
    await emitter.flush();

    assertEquals(revokedSession.closes.map((c) => c.code), [4003]);
    assertEquals(rotatedSession.closes.map((c) => c.code), [4003]);
    assertEquals(expiringSession.closes.map((c) => c.code), [4002]);
    assertEquals(healthySession.closes, []);
    assertEquals(reconnected.closes, []);

    const byToken = new Map(
      terminated(sink).map((e) => [e.resourceName, e]),
    );
    assertEquals(byToken.size, 3);
    assertEquals(byToken.get(revoked)?.detail, "revoked");
    assertEquals(byToken.get(rotated)?.detail, "rotated");
    assertEquals(byToken.get(expiring)?.detail, "expired");
    for (const event of byToken.values()) {
      assertEquals(event.initiatedBy, "system");
    }

    for (const name of [healthy, rotated]) {
      terminateTokenSessions(name, {
        code: 1000,
        reason: "test cleanup",
        cause: "revoked",
        initiatedBy: "system",
      });
    }
  });
});
