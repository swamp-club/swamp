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
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import type { ServerToken } from "../domain/models/access/server_token_model.ts";
import { ServerTokenNotFoundError } from "./token_auth.ts";
import {
  type TokenSessionCloseOptions,
  type TokenSessionRevalidationDeps,
  TokenSessionRevalidationService,
  tokenSessionVerdict,
} from "./token_session_revalidation_service.ts";

const MINT_1 = "2026-01-01T00:00:00.000Z";
const MINT_2 = "2026-02-02T00:00:00.000Z";
const NOW = Date.parse("2026-03-01T00:00:00.000Z");

function token(overrides: Partial<ServerToken> = {}): ServerToken {
  return {
    name: "tok",
    state: "active",
    principalId: "user:alice",
    principalEmail: "alice@example.com",
    collectives: [],
    groups: [],
    createdAt: MINT_1,
    expiresAt: "2026-12-31T00:00:00.000Z",
    vaultName: "_token-secrets",
    secretKey: "server-token-tok",
    ...overrides,
  };
}

// ── tokenSessionVerdict ─────────────────────────────────────────────────

Deno.test("tokenSessionVerdict: keeps a session on its active, unexpired mint", () => {
  assertEquals(tokenSessionVerdict(token(), MINT_1, NOW), { keep: true });
});

Deno.test("tokenSessionVerdict: a revoked token closes with 4003", () => {
  const verdict = tokenSessionVerdict(
    token({ state: "revoked" }),
    MINT_1,
    NOW,
  );
  assertEquals(verdict.keep, false);
  if (verdict.keep) return;
  assertEquals(verdict.cause, "revoked");
  assertEquals(verdict.code, 4003);
});

Deno.test("tokenSessionVerdict: a missing token closes as deleted", () => {
  const verdict = tokenSessionVerdict(null, MINT_1, NOW);
  assertEquals(verdict.keep, false);
  if (verdict.keep) return;
  assertEquals(verdict.cause, "deleted");
  assertEquals(verdict.code, 4003);
});

Deno.test("tokenSessionVerdict: a session on a rotated-away mint closes as rotated", () => {
  const verdict = tokenSessionVerdict(
    token({ createdAt: MINT_2 }),
    MINT_1,
    NOW,
  );
  assertEquals(verdict.keep, false);
  if (verdict.keep) return;
  assertEquals(verdict.cause, "rotated");
  assertEquals(verdict.code, 4003);
});

Deno.test("tokenSessionVerdict: a passed expiresAt closes with 4002", () => {
  const verdict = tokenSessionVerdict(
    token({ expiresAt: "2026-02-28T23:59:59.000Z" }),
    MINT_1,
    NOW,
  );
  assertEquals(verdict.keep, false);
  if (verdict.keep) return;
  assertEquals(verdict.cause, "expired");
  assertEquals(verdict.code, 4002);
});

Deno.test("tokenSessionVerdict: an unparseable expiresAt fails closed", () => {
  const verdict = tokenSessionVerdict(
    token({ expiresAt: "not-a-date" }),
    MINT_1,
    NOW,
  );
  assertEquals(verdict.keep, false);
  if (verdict.keep) return;
  assertEquals(verdict.cause, "expired");
});

Deno.test("tokenSessionVerdict: an expired state closes with 4002 before expiresAt", () => {
  const verdict = tokenSessionVerdict(token({ state: "expired" }), MINT_1, NOW);
  assertEquals(verdict.keep, false);
  if (verdict.keep) return;
  assertEquals(verdict.cause, "expired");
});

// ── TokenSessionRevalidationService ─────────────────────────────────────

interface Harness {
  deps: TokenSessionRevalidationDeps;
  reads: string[];
  closes: { name: string; options: TokenSessionCloseOptions }[];
}

function harness(
  sessions: { name: string; createdAt: string }[],
  readToken: (name: string) => Promise<ServerToken>,
  intervalMs = 60_000,
): Harness {
  const reads: string[] = [];
  const closes: { name: string; options: TokenSessionCloseOptions }[] = [];
  return {
    reads,
    closes,
    deps: {
      intervalMs,
      listTokenSessions: () => sessions,
      readToken: (name) => {
        reads.push(name);
        return readToken(name);
      },
      terminateSessions: (name, options) => {
        closes.push({ name, options });
        return 1;
      },
      now: () => NOW,
    },
  };
}

Deno.test("runOnce: closes the sessions of a revoked token", async () => {
  const h = harness(
    [{ name: "tok", createdAt: MINT_1 }],
    () => Promise.resolve(token({ state: "revoked" })),
  );
  const service = new TokenSessionRevalidationService(h.deps);

  assertEquals(await service.runOnce(), 1);
  assertEquals(h.closes.length, 1);
  assertEquals(h.closes[0].name, "tok");
  assertEquals(h.closes[0].options.onlyCreatedAt, MINT_1);
  assertEquals(h.closes[0].options.cause, "revoked");
  assertEquals(h.closes[0].options.code, 4003);
});

Deno.test("runOnce: keeps sessions whose token is still valid", async () => {
  const h = harness(
    [{ name: "tok", createdAt: MINT_1 }],
    () => Promise.resolve(token()),
  );
  const service = new TokenSessionRevalidationService(h.deps);

  assertEquals(await service.runOnce(), 0);
  assertEquals(h.closes, []);
});

Deno.test("runOnce: after a rotation closes only the old mint's sessions", async () => {
  const h = harness(
    [
      { name: "tok", createdAt: MINT_1 },
      { name: "tok", createdAt: MINT_2 },
    ],
    () => Promise.resolve(token({ createdAt: MINT_2 })),
  );
  const service = new TokenSessionRevalidationService(h.deps);

  await service.runOnce();

  assertEquals(h.closes.map((c) => c.options.onlyCreatedAt), [MINT_1]);
  assertEquals(h.closes[0].options.cause, "rotated");
});

Deno.test("runOnce: a token that no longer exists closes as deleted", async () => {
  const h = harness(
    [{ name: "gone", createdAt: MINT_1 }],
    () => Promise.reject(new ServerTokenNotFoundError("gone")),
  );
  const service = new TokenSessionRevalidationService(h.deps);

  await service.runOnce();

  assertEquals(h.closes.length, 1);
  assertEquals(h.closes[0].options.cause, "deleted");
});

Deno.test("runOnce: a datastore error that mentions 'does not exist' is transient, not a deletion", async () => {
  const h = harness(
    [{ name: "tok", createdAt: MINT_1 }],
    () => Promise.reject(new Error("The specified bucket does not exist")),
  );
  const service = new TokenSessionRevalidationService(h.deps);

  assertEquals(await service.runOnce(), 0);
  assertEquals(h.closes, []);
});

Deno.test("runOnce: a transient read failure keeps the sessions for the next pass", async () => {
  const h = harness(
    [{ name: "tok", createdAt: MINT_1 }],
    () => Promise.reject(new Error("EIO: i/o error")),
  );
  const service = new TokenSessionRevalidationService(h.deps);

  assertEquals(await service.runOnce(), 0);
  assertEquals(h.closes, []);
});

Deno.test("runOnce: a record that will not parse closes its sessions as invalid", async () => {
  for (
    const unreadable of [
      new SyntaxError("Unexpected end of JSON input"),
      new z.ZodError([]),
    ]
  ) {
    const h = harness(
      [{ name: "tok", createdAt: MINT_1 }],
      () => Promise.reject(unreadable),
    );
    const service = new TokenSessionRevalidationService(h.deps);

    assertEquals(await service.runOnce(), 1);
    assertEquals(h.closes[0].options.cause, "invalid");
    assertEquals(h.closes[0].options.code, 4003);
  }
});

Deno.test("runOnce: one failing token does not stop the others being checked", async () => {
  const h = harness(
    [
      { name: "flaky", createdAt: MINT_1 },
      { name: "revoked", createdAt: MINT_1 },
    ],
    (name) =>
      name === "flaky"
        ? Promise.reject(new Error("EIO: i/o error"))
        : Promise.resolve(token({ name, state: "revoked" })),
  );
  const service = new TokenSessionRevalidationService(h.deps);

  await service.runOnce();

  assertEquals(h.closes.map((c) => c.name), ["revoked"]);
});

Deno.test("runOnce: reads each token once however many mints are open", async () => {
  const h = harness(
    [
      { name: "tok", createdAt: MINT_1 },
      { name: "tok", createdAt: MINT_2 },
      { name: "other", createdAt: MINT_1 },
    ],
    (name) => Promise.resolve(token({ name })),
  );
  const service = new TokenSessionRevalidationService(h.deps);

  await service.runOnce();

  assertEquals(h.reads.sort(), ["other", "tok"]);
});

Deno.test("runOnce: closes a session bound after a revoke's immediate close ran", async () => {
  // The upgrade race: authentication read the token as active, the revoke
  // handler's immediate close ran, then the upgrading socket was bound. The
  // next pass still finds it and closes it.
  const sessions: { name: string; createdAt: string }[] = [];
  const h = harness(
    sessions,
    () => Promise.resolve(token({ state: "revoked" })),
  );
  const service = new TokenSessionRevalidationService(h.deps);
  assertEquals(await service.runOnce(), 0);

  sessions.push({ name: "tok", createdAt: MINT_1 });

  assertEquals(await service.runOnce(), 1);
  assertEquals(h.closes[0].options.cause, "revoked");
});

Deno.test("start: runs revalidation passes on its timer", async () => {
  const h = harness(
    [{ name: "tok", createdAt: MINT_1 }],
    () => Promise.resolve(token({ state: "revoked" })),
    5,
  );
  const service = new TokenSessionRevalidationService(h.deps);

  service.start();
  await waitFor(() => h.closes.length >= 1, "a timed revalidation pass");
  await service.dispose();

  assertEquals(h.closes[0].options.cause, "revoked");
});

Deno.test("dispose: waits for a pass already running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let passFinished = false;
  const h = harness(
    [{ name: "tok", createdAt: MINT_1 }],
    async () => {
      await gate;
      passFinished = true;
      return token();
    },
    5,
  );
  const service = new TokenSessionRevalidationService(h.deps);

  service.start();
  await waitFor(() => h.reads.length >= 1, "a pass to start reading");
  const disposed = service.dispose();
  release();
  await disposed;

  assertEquals(passFinished, true);
});
