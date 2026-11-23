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

import { assertEquals } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import type { ControlPlaneStore } from "../src/domain/datastore/control_plane_store.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "../src/domain/vaults/control_plane_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { withoutVaultAccess } from "../src/domain/vaults/run_vault_access.ts";
import type { AdmissionLists } from "../src/domain/access/admission.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { handleAccessTokenMint } from "../src/serve/handlers/access_handlers.ts";
import {
  authenticateDashboardSession,
  authenticateServerToken,
  readServerTokenRecord,
  shouldInvalidateDashboardSession,
} from "../src/serve/token_auth.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  cachedUnlessRejected,
  createTokenAdmissionChecker,
  type TokenAdmissionChecker,
} from "../src/serve/token_admission.ts";
import { hasOAuthAccessToken } from "../src/serve/oauth_access_token_lookup.ts";
import {
  createExchangeTokenMinter,
  oauthAccessTokenKey,
} from "../src/serve/device_auth_handler.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const ACCESS_TOKEN_PREFIX = "token-secrets/values/oauth-access-token-";

interface Fixture {
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  readonly store: ControlPlaneStore;
  readonly admission: TokenAdmissionChecker;
  readonly events: AuditEvent[];
  readonly warnings: string[];
  setLists(next: AdmissionLists): void;
  lookups(): number;
  /** reads of OAuth access-token records fail while set */
  setOutage(down: boolean): void;
}

// a real ControlPlaneVaultProvider on a filesystem store, with the checker
// wired as serve wires it in --auth-mode oauth
async function withFixture(
  lists: AdmissionLists,
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-token-admission-" });
  const repoContext = createRepositoryContext({ repoDir });
  const warnings: string[] = [];
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

    let down = false;
    const backing = new FileSystemControlPlaneStore(swampPath(repoDir));
    const store: ControlPlaneStore = {
      put: (key, data) => backing.put(key, data),
      delete: (key) => backing.delete(key),
      list: (prefix) => backing.list(prefix),
      get: (key) =>
        down && key.startsWith(ACCESS_TOKEN_PREFIX)
          ? Promise.reject(new Error("control-plane store unreachable"))
          : backing.get(key),
    };
    const provider = new ControlPlaneVaultProvider(store);
    await provider.initialize();
    VaultService.registerGlobalProvider(
      TOKEN_SECRETS_VAULT_NAME,
      "control_plane",
      provider,
    );

    let current = lists;
    let lookups = 0;
    const vaults = cachedUnlessRejected(() =>
      VaultService.fromRepository(repoDir)
    );
    const admission = createTokenAdmissionChecker({
      lists: () => current,
      hasStoredLogin: (token) =>
        withoutVaultAccess(async () => {
          lookups++;
          return await hasOAuthAccessToken({
            tokenSecrets: provider,
            vaults,
          }, token);
        }),
    });

    await configure({
      sinks: {
        capture: (record: LogRecord) => {
          warnings.push(record.message.map(String).join(""));
        },
      },
      loggers: [
        {
          category: ["serve", "token-admission"],
          lowestLevel: "warning",
          sinks: ["capture"],
        },
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
      ],
      reset: true,
    });

    await fn({
      repoDir,
      repoContext,
      store,
      admission,
      events: [],
      warnings,
      setLists: (next) => current = next,
      lookups: () => lookups,
      setOutage: (value) => down = value,
    });
  } finally {
    await reset();
    await initializeLogging({});
    VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function mintUserToken(
  fixture: Fixture,
  name: string,
  principalId: string,
): Promise<string> {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
    close() {},
  } as unknown as WebSocket;
  await handleAccessTokenMint(
    socket,
    {
      repoDir: fixture.repoDir,
      repoContext: fixture.repoContext,
      datastoreConfig: { type: "filesystem" },
      datastoreResolver: {},
      authConfig: { mode: "none" },
    } as unknown as ConnectionContext,
    "req-1",
    {
      name,
      principalId,
      principalEmail: "operator@example.com",
      durationMs: 15 * 60_000,
    },
    new AbortController(),
    null,
  );
  const vaultRef = JSON.parse(sent[0]).payload.data.vaultRef;
  const secret = await (await VaultService.fromRepository(fixture.repoDir)).get(
    vaultRef.vaultName,
    vaultRef.secretKey,
    "test:token-admission",
  );
  return `${name}.${secret}`;
}

// what an older binary's device login left: a user principal with no
// oauthIdentity, and its OAuth access token in _token-secrets
async function legacyLoginToken(
  fixture: Fixture,
  sub: string,
  collectives: string[],
): Promise<{ token: string; name: string }> {
  const { token } = await createExchangeTokenMinter(
    fixture.repoDir,
    fixture.repoContext,
  )({
    principalId: `user:${sub}`,
    email: `${sub}@example.com`,
    username: sub,
    collectives,
    groups: [],
    notAfter: new Date(Date.now() + 60 * 60_000).toISOString(),
    oauthIdentity: false,
  });
  const name = token.slice(0, token.indexOf("."));
  await (await VaultService.fromRepository(fixture.repoDir)).put(
    TOKEN_SECRETS_VAULT_NAME,
    oauthAccessTokenKey(name),
    "test-oauth-access-token",
  );
  return { token, name };
}

function authenticate(fixture: Fixture, token: string) {
  return authenticateServerToken(
    token,
    fixture.repoDir,
    fixture.repoContext,
    fixture.admission,
    { emitter: { emit: (event) => fixture.events.push(event) } },
  );
}

Deno.test("token admission against the control-plane vault: a minted user token is classified once, with no warning", async () => {
  await withFixture(
    { allowedCollectives: [], allowedUsers: ["sub-bob"] },
    async (fixture) => {
      const token = await mintUserToken(fixture, "ci-runner", "user:sub-ci");
      for (let i = 0; i < 3; i++) {
        assertEquals((await authenticate(fixture, token)).ok, true);
      }
      assertEquals(fixture.lookups(), 1);
      assertEquals(fixture.warnings, []);
    },
  );
});

Deno.test("token admission against the control-plane vault: a legacy login token is refused once its user is removed", async () => {
  await withFixture(
    { allowedCollectives: [], allowedUsers: ["sub-bob"] },
    async (fixture) => {
      const { token } = await legacyLoginToken(fixture, "sub-bob", []);
      assertEquals((await authenticate(fixture, token)).ok, true);

      fixture.setLists({ allowedCollectives: [], allowedUsers: ["sub-alice"] });
      const refused = await authenticate(fixture, token);
      assertEquals(!refused.ok && refused.reason, "not-admitted");
      assertEquals(
        fixture.events.map((e) => e.action).includes("auth.token.not_admitted"),
        true,
      );
      assertEquals(fixture.warnings, []);
    },
  );
});

Deno.test("token admission against the control-plane vault: a legacy login token is refused once its collective is removed", async () => {
  await withFixture(
    { allowedCollectives: ["acme"], allowedUsers: [] },
    async (fixture) => {
      const { token } = await legacyLoginToken(fixture, "sub-bob", ["acme"]);
      assertEquals((await authenticate(fixture, token)).ok, true);

      fixture.setLists({ allowedCollectives: ["other"], allowedUsers: [] });
      const refused = await authenticate(fixture, token);
      assertEquals(!refused.ok && refused.reason, "not-admitted");
    },
  );
});

Deno.test("token admission against the control-plane vault: an access-token entry that no longer decrypts still marks a login", async () => {
  await withFixture(
    { allowedCollectives: [], allowedUsers: ["sub-alice"] },
    async (fixture) => {
      const { token, name } = await legacyLoginToken(fixture, "sub-bob", []);
      await fixture.store.put(
        `${ACCESS_TOKEN_PREFIX}${name}`,
        new TextEncoder().encode("left undecryptable by a key migration"),
      );
      const refused = await authenticate(fixture, token);
      assertEquals(!refused.ok && refused.reason, "not-admitted");
      assertEquals(fixture.warnings, []);
    },
  );
});

Deno.test("token admission against the control-plane vault: an outage refuses bearer and dashboard use, uncached, until the store answers", async () => {
  await withFixture(
    { allowedCollectives: [], allowedUsers: ["sub-bob"] },
    async (fixture) => {
      const token = await mintUserToken(fixture, "ci-runner", "user:sub-ci");
      const record = await readServerTokenRecord(
        fixture.repoContext,
        "ci-runner",
      );
      const dashboard = () =>
        authenticateDashboardSession(
          { tokenName: record.name, tokenCreatedAt: record.createdAt },
          fixture.repoContext,
          fixture.admission,
          { emitter: { emit: (event) => fixture.events.push(event) } },
        );

      fixture.setOutage(true);
      const bearer = await authenticate(fixture, token);
      assertEquals(!bearer.ok && bearer.reason, "vault-error");
      const session = await dashboard();
      assertEquals(session.ok, false);
      if (!session.ok) {
        assertEquals(session.reason, "vault-error");
        assertEquals(shouldInvalidateDashboardSession(session.reason), false);
      }
      assertEquals(fixture.warnings.length, 2);
      assertEquals(
        fixture.events.some((e) => e.action === "auth.token.not_admitted"),
        false,
      );

      fixture.setOutage(false);
      assertEquals((await authenticate(fixture, token)).ok, true);
      assertEquals((await dashboard()).ok, true);
      assertEquals(fixture.lookups(), 3);
    },
  );
});
