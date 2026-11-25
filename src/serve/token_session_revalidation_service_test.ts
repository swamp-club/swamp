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

import type { TokenAdmissionChecker } from "./token_admission.ts";
import { assert, assertEquals } from "@std/assert";
import { type Span, trace } from "@opentelemetry/api";
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import {
  type ServerToken,
  serverTokenSecretFingerprint,
} from "../domain/models/access/server_token_model.ts";
import { ServerTokenNotFoundError } from "./token_auth.ts";
import {
  STALE_COPY_KEEP_MS,
  type TokenSessionCloseOptions,
  type TokenSessionRevalidationDeps,
  TokenSessionRevalidationService,
  tokenSessionVerdict,
} from "./token_session_revalidation_service.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import { withCapturedSpans } from "../infrastructure/tracing/span_test_helpers.ts";

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

Deno.test("TokenSessionRevalidationService: a tick runs with no active span when started under one", async () => {
  await withCapturedSpans(async () => {
    const seen: (Span | undefined)[] = [];
    const h = harness([], () => Promise.resolve(token()), 10);
    const service = new TokenSessionRevalidationService({
      ...h.deps,
      listTokenSessions: () => {
        seen.push(trace.getActiveSpan());
        return [];
      },
    });
    await withSpan("swamp.cli", {}, async () => {
      service.start();
      try {
        await waitFor(() => seen.length >= 2, "two revalidation passes");
      } finally {
        await service.dispose();
      }
    });
    assert(seen.length >= 2);
    for (const span of seen) assertEquals(span, undefined);
  });
});

Deno.test("runOnce: a delegation's sessions are checked against the directory and never read as a server token", async () => {
  const standing = new Map([["d-live", "standing"], ["d-ended", "ended"]]);
  const h = harness(
    [
      { name: "delegation:d-live", createdAt: MINT_1 },
      { name: "delegation:d-ended", createdAt: MINT_1 },
      { name: "delegation:d-missing", createdAt: MINT_1 },
    ],
    () => Promise.reject(new Error("no server token is read")),
  );
  const service = new TokenSessionRevalidationService({
    ...h.deps,
    delegationStanding: (id) => standing.get(id) ?? "unknown",
  });

  assertEquals(await service.runOnce(), 2);
  assertEquals(h.reads, []);
  assertEquals(h.closes.map((c) => c.name).sort(), [
    "delegation:d-ended",
    "delegation:d-missing",
  ]);
  for (const close of h.closes) {
    assertEquals(close.options.cause, "delegation-ended");
    assertEquals(close.options.code, 4003);
  }
});

function admitting(admitted: () => boolean): TokenAdmissionChecker {
  const result = () => ({ admitted: admitted(), reason: "test" });
  return {
    serverToken: () => Promise.resolve(result()),
    delegation: () => result(),
  };
}

Deno.test("runOnce: closes a valid token's sessions once its person is no longer admitted", async () => {
  let admitted = true;
  const h = harness(
    [
      { name: "tok", createdAt: MINT_1 },
      { name: "tok", createdAt: MINT_2 },
    ],
    () => Promise.resolve(token({ createdAt: MINT_2 })),
  );
  const service = new TokenSessionRevalidationService({
    ...h.deps,
    admission: admitting(() => admitted),
  });

  await service.runOnce();
  assertEquals(h.closes.map((c) => c.options.cause), ["rotated"]);

  admitted = false;
  h.closes.length = 0;
  await service.runOnce();
  assertEquals(
    h.closes.map((c) => [c.options.onlyCreatedAt, c.options.cause]),
    [[MINT_1, "rotated"], [MINT_2, "not-admitted"]],
  );
  assertEquals(h.closes[1].options.code, 4003);
});

Deno.test("runOnce: keeps a token's sessions while admission cannot tell, and still closes a rotated mint", async () => {
  const h = harness(
    [
      { name: "tok", createdAt: MINT_1 },
      { name: "tok", createdAt: MINT_2 },
    ],
    () => Promise.resolve(token({ createdAt: MINT_2 })),
  );
  const unavailable = {
    admitted: false,
    unavailable: true as const,
    reason: "test",
  };
  const service = new TokenSessionRevalidationService({
    ...h.deps,
    admission: {
      serverToken: () => Promise.resolve(unavailable),
      delegation: () => unavailable,
    },
  });

  await service.runOnce();
  assertEquals(
    h.closes.map((c) => [c.options.onlyCreatedAt, c.options.cause]),
    [[MINT_1, "rotated"]],
  );
});

Deno.test("runOnce: closes a standing delegation's sessions once its person is no longer admitted", async () => {
  let admitted = true;
  const h = harness(
    [{ name: "delegation:d-live", createdAt: MINT_1 }],
    () => Promise.reject(new Error("never read")),
  );
  const service = new TokenSessionRevalidationService({
    ...h.deps,
    delegationStanding: () => "standing",
    delegationPerson: () => ({ sub: "sub-1", collectives: [] }),
    admission: admitting(() => admitted),
  });

  assertEquals(await service.runOnce(), 0);
  admitted = false;
  assertEquals(await service.runOnce(), 1);
  assertEquals(h.closes[0].options.cause, "not-admitted");
  assertEquals(h.reads, []);
});

Deno.test("tokenSessionVerdict: a stale copy of the record keeps a session on another mint", () => {
  assertEquals(tokenSessionVerdict(token(), MINT_2, NOW, true), {
    keep: true,
  });
  assertEquals(
    tokenSessionVerdict(token({ state: "revoked" }), MINT_2, NOW, true).keep,
    false,
  );
});

async function pairedToken(
  secret: string,
  overrides: Partial<ServerToken> = {},
): Promise<ServerToken> {
  return token({
    secretFingerprint: await serverTokenSecretFingerprint(secret),
    ...overrides,
  });
}

function withSecret(
  h: Harness,
  readSecret: () => Promise<string>,
): { reads: number; deps: TokenSessionRevalidationDeps } {
  const counted = { reads: 0, deps: h.deps };
  counted.deps = {
    ...h.deps,
    readSecret: () => {
      counted.reads++;
      return readSecret();
    },
  };
  return counted;
}

Deno.test("runOnce: a changed record that pairs with the vault secret closes as rotated", async () => {
  const record = await pairedToken("new-secret", { createdAt: MINT_1 });
  const h = harness(
    [{ name: "tok", createdAt: MINT_2 }],
    () => Promise.resolve(record),
  );
  const s = withSecret(h, () => Promise.resolve("new-secret"));
  await new TokenSessionRevalidationService(s.deps).runOnce();
  assertEquals(h.closes.map((c) => c.options.cause), ["rotated"]);
});

Deno.test("runOnce: a changed record that does not pair with the vault secret keeps the session", async () => {
  const stale = await pairedToken("old-secret", { createdAt: MINT_1 });
  const h = harness(
    [{ name: "tok", createdAt: MINT_2 }],
    () => Promise.resolve(stale),
  );
  const s = withSecret(h, () => Promise.resolve("current-secret"));
  assertEquals(await new TokenSessionRevalidationService(s.deps).runOnce(), 0);
  assertEquals(h.closes, []);
});

Deno.test("runOnce: an unreadable secret or a record with no fingerprint closes as rotated", async () => {
  for (
    const [label, record, readSecret] of [
      [
        "vault error",
        await pairedToken("old-secret"),
        () => Promise.reject(new Error("vault offline")),
      ],
      ["no fingerprint", token(), () => Promise.resolve("anything")],
    ] as const
  ) {
    const h = harness(
      [{ name: "tok", createdAt: MINT_2 }],
      () => Promise.resolve(record),
    );
    const s = withSecret(h, readSecret);
    await new TokenSessionRevalidationService(s.deps).runOnce();
    assertEquals(h.closes.map((c) => c.options.cause), ["rotated"], label);
  }
});

Deno.test("runOnce: the vault is read only when a session's mint differs from the record", async () => {
  const record = await pairedToken("s");
  const h = harness(
    [{ name: "tok", createdAt: MINT_1 }],
    () => Promise.resolve(record),
  );
  const s = withSecret(h, () => Promise.resolve("s"));
  await new TokenSessionRevalidationService(s.deps).runOnce();
  assertEquals(s.reads, 0);
  assertEquals(h.closes, []);
});

Deno.test("tokenSessionVerdict: a stale copy keeps only a session newer than it", () => {
  const stale = token({ createdAt: MINT_2 });
  assertEquals(tokenSessionVerdict(stale, MINT_1, NOW, true).keep, false);
  assertEquals(tokenSessionVerdict(stale, "not-a-time", NOW, true).keep, false);
});

Deno.test("runOnce: a session kept over a stale copy closes as rotated once the keep window runs out", async () => {
  const stale = await pairedToken("old-secret", { createdAt: MINT_1 });
  const h = harness(
    [{ name: "tok", createdAt: MINT_2 }],
    () => Promise.resolve(stale),
  );
  let now = NOW;
  const s = withSecret(h, () => Promise.resolve("current-secret"));
  const service = new TokenSessionRevalidationService({
    ...s.deps,
    now: () => now,
  });
  assertEquals(await service.runOnce(), 0);
  now += STALE_COPY_KEEP_MS - 1;
  assertEquals(await service.runOnce(), 0);
  now += 1;
  await service.runOnce();
  assertEquals(h.closes.map((c) => c.options.cause), ["rotated"]);
});

Deno.test("runOnce: the keep window starts again after the record pairs", async () => {
  let record = await pairedToken("old-secret", { createdAt: MINT_1 });
  let secret = "current-secret";
  const h = harness(
    [{ name: "tok", createdAt: MINT_2 }],
    () => Promise.resolve(record),
  );
  let now = NOW;
  const s = withSecret(h, () => Promise.resolve(secret));
  const service = new TokenSessionRevalidationService({
    ...s.deps,
    now: () => now,
  });
  await service.runOnce();
  now += STALE_COPY_KEEP_MS - 1;
  // the session's own mint comes back, so nothing is kept over a stale copy
  record = await pairedToken("current-secret", { createdAt: MINT_2 });
  await service.runOnce();
  record = await pairedToken("old-secret", { createdAt: MINT_1 });
  secret = "current-secret";
  now += 1;
  assertEquals(await service.runOnce(), 0);
  assertEquals(h.closes, []);
});

Deno.test("runOnce: a transient read failure does not restart the keep window", async () => {
  const stale = await pairedToken("old-secret", { createdAt: MINT_1 });
  let failRead = false;
  const h = harness(
    [{ name: "tok", createdAt: MINT_2 }],
    () =>
      failRead
        ? Promise.reject(new Error("datastore offline"))
        : Promise.resolve(stale),
  );
  let now = NOW;
  const s = withSecret(h, () => Promise.resolve("current-secret"));
  const service = new TokenSessionRevalidationService({
    ...s.deps,
    now: () => now,
  });
  await service.runOnce();
  now += STALE_COPY_KEEP_MS / 2;
  failRead = true;
  await service.runOnce();
  failRead = false;
  now += STALE_COPY_KEEP_MS / 2;
  await service.runOnce();
  assertEquals(h.closes.map((c) => c.options.cause), ["rotated"]);
});
