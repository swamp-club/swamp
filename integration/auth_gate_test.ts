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

// Wires the auth gate's real dependencies — AuthRepository and
// AuthVerificationRepository on a temp config dir, SwampClubClient against a
// port-0 mock of /api/whoami — across the scenarios of the design
// (design/surfaces/auth-gate.md).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  type AncestorCheck,
  type AuthGateOutcome,
  createAuthGateDeps,
  runAuthGate,
} from "../src/cli/auth_gate.ts";
import {
  formatNestedGatePass,
  NESTED_GATE_PASS_ENV,
} from "../src/domain/auth/nested_gate_pass.ts";
import { AuthVerificationRepository } from "../src/infrastructure/persistence/auth_verification_repository.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  generateTestSigningKey,
  type MintedProof,
  mintTestProof,
  type TestSigningKey,
  toSigninToken,
} from "../src/domain/auth/proof_test_helpers.ts";

const API_KEY = "swamp_integration_gate_key";
const DAY = 86_400;

type Handler = (req: Request) => Response | Promise<Response>;

interface World {
  readonly configDir: string;
  readonly key: TestSigningKey;
  readonly serverUrl: string;
  /** Requests the mock whoami received. */
  readonly calls: number;
  answer(handler: Handler): void;
  login(): Promise<void>;
  saveProof(minted: MintedProof): Promise<void>;
  mint(options: { iat: number; exp?: number; apiKey?: string }): Promise<
    MintedProof
  >;
  gate(env?: Record<string, string | undefined>): Promise<AuthGateOutcome>;
  /** The gate with its ancestry check answered by `check`. */
  gateNested(
    env: Record<string, string | undefined>,
    check: (pid: number) => AncestorCheck,
  ): Promise<AuthGateOutcome>;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
  const configDir = await Deno.makeTempDir({ prefix: "swamp-gate-it-" });
  const key = await generateTestSigningKey();
  let handler: Handler = () => new Response("no handler", { status: 500 });
  let calls = 0;
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen() {} },
    (req) => {
      calls++;
      return handler(req);
    },
  );
  const serverUrl = `http://localhost:${(server.addr as Deno.NetAddr).port}`;
  try {
    await fn({
      configDir,
      key,
      serverUrl,
      get calls() {
        return calls;
      },
      answer(h) {
        handler = h;
      },
      async login() {
        await Deno.writeTextFile(
          join(configDir, "auth.json"),
          JSON.stringify({
            serverUrl,
            apiKey: API_KEY,
            apiKeyId: "k1",
            username: "gate-tester",
          }),
        );
      },
      async saveProof(minted) {
        await new AuthVerificationRepository({ configDir }).save(
          minted.proof,
          minted.signature,
          minted.publicKeys,
        );
      },
      mint: (o) =>
        mintTestProof(key, o.apiKey ?? API_KEY, { iat: o.iat, exp: o.exp }),
      gate: (env = {}) =>
        withMockedEnv({
          SWAMP_CONFIG_DIR: configDir,
          SWAMP_HOME: undefined,
          SWAMP_API_KEY: undefined,
          SWAMP_API_KEY_FILE: undefined,
          SWAMP_SIGNIN_TOKEN: undefined,
          SWAMP_CLUB_URL: undefined,
          [NESTED_GATE_PASS_ENV]: undefined,
          ...env,
        }, () => runAuthGate(createAuthGateDeps({ liveChecks: true }))),
      gateNested: (env, check) =>
        withMockedEnv({
          SWAMP_CONFIG_DIR: configDir,
          SWAMP_HOME: undefined,
          SWAMP_API_KEY: undefined,
          SWAMP_API_KEY_FILE: undefined,
          SWAMP_SIGNIN_TOKEN: undefined,
          SWAMP_CLUB_URL: undefined,
          [NESTED_GATE_PASS_ENV]: undefined,
          ...env,
        }, () => {
          const deps = createAuthGateDeps({ liveChecks: true });
          return runAuthGate({
            ...deps,
            nested: { ...deps.nested!, checkAncestor: check },
          });
        }),
    });
  } finally {
    ac.abort();
    await server.finished;
    await Deno.remove(configDir, { recursive: true }).catch(() => {});
  }
}

function whoamiOk(minted?: MintedProof): Response {
  return Response.json({
    authenticated: true,
    username: "gate-tester",
    ...(minted
      ? {
        verificationProof: minted.proof,
        verificationSignature: minted.signature,
        publicKeys: minted.publicKeys,
      }
      : {}),
  });
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

Deno.test("auth gate integration: no credential blocks without a call", async () => {
  await withWorld(async (w) => {
    assertEquals(await w.gate(), {
      kind: "block",
      reason: { kind: "no_credential" },
    });
    assertEquals(w.calls, 0);
  });
});

Deno.test("auth gate integration: first run verifies once, then runs locally", async () => {
  await withWorld(async (w) => {
    await w.login();
    const fresh = await w.mint({ iat: now(), exp: now() + 14 * DAY });
    w.answer(() => whoamiOk(fresh));

    const first = await w.gate();
    assertEquals(first.kind, "pass");
    assertEquals(w.calls, 1);
    assert(await exists(join(w.configDir, "auth_verified.json")));

    const second = await w.gate();
    assert(second.kind === "pass");
    assertEquals(second.authMode, "verified");
    assertEquals(w.calls, 1, "a valid proof needs no network");
  });
});

Deno.test("auth gate integration: whoami's 401 revokes; a gateway's 401 does not", async () => {
  await withWorld(async (w) => {
    await w.login();
    await w.saveProof(
      await w.mint({ iat: now() - 20 * DAY, exp: now() - DAY }),
    );
    w.answer(() => new Response("Unauthorized", { status: 401 }));
    const gateway = await w.gate();
    assertEquals(gateway.kind, "block");
    assert(
      await exists(join(w.configDir, "auth_verified.json")),
      "a gateway 401 must not delete the proof",
    );

    w.answer(() => Response.json({ authenticated: false }, { status: 401 }));
    assertEquals(await w.gate(), {
      kind: "block",
      reason: { kind: "revoked" },
    });
    assertEquals(await exists(join(w.configDir, "auth_verified.json")), false);
  });
});

Deno.test("auth gate integration: a valid proof survives every failure but a rejection", async () => {
  await withWorld(async (w) => {
    await w.login();
    await w.saveProof(await w.mint({ iat: now(), exp: now() + DAY }));
    for (const status of [500, 503, 429, 403]) {
      w.answer(() => new Response("down", { status }));
      const outcome = await w.gate();
      assert(outcome.kind === "pass", `status ${status}`);
    }
    // A file proof is never checked live, so none of those were calls.
    assertEquals(w.calls, 0);
  });
});

Deno.test("auth gate integration: without a proof a 5xx fails open for a day", async () => {
  await withWorld(async (w) => {
    await w.login();
    w.answer(() => new Response("bad gateway", { status: 502 }));
    const first = await w.gate();
    assert(first.kind === "pass");
    assertEquals(first.authMode, "offline");

    // Age the window past 24 hours.
    await new AuthVerificationRepository({ configDir: w.configDir })
      .markFailOpenSince(now() - DAY - 10);
    assertEquals(await w.gate(), {
      kind: "block",
      reason: { kind: "unverified_for_a_day" },
    });

    // A future stamp is discarded and the window restarts.
    await new AuthVerificationRepository({ configDir: w.configDir })
      .markFailOpenSince(now() + 365 * DAY);
    assertEquals((await w.gate()).kind, "pass");
  });
});

Deno.test("auth gate integration: without a proof a 429, a proxy 403 or no server blocks", async () => {
  await withWorld(async (w) => {
    await w.login();
    w.answer(() => new Response("slow down", { status: 429 }));
    assertEquals((await w.gate()).kind, "block");
    w.answer(() => new Response("<html>denied</html>", { status: 403 }));
    assertEquals((await w.gate()).kind, "block");
    assertEquals(
      await exists(join(w.configDir, "auth_fail_open.json")),
      false,
      "only a 5xx may open the window",
    );
  });

  // Nothing listening at all.
  const configDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(configDir, "auth.json"),
      JSON.stringify({
        serverUrl: "http://127.0.0.1:1",
        apiKey: API_KEY,
        apiKeyId: "k1",
        username: "gate-tester",
      }),
    );
    const outcome = await withMockedEnv({
      SWAMP_CONFIG_DIR: configDir,
      SWAMP_HOME: undefined,
      SWAMP_API_KEY: undefined,
      SWAMP_API_KEY_FILE: undefined,
      SWAMP_SIGNIN_TOKEN: undefined,
    }, () => runAuthGate(createAuthGateDeps({ liveChecks: true })));
    assertEquals(outcome, {
      kind: "block",
      reason: {
        kind: "unreachable_unverified",
        daysSinceVerification: undefined,
      },
    });
  } finally {
    await Deno.remove(configDir, { recursive: true });
  }
});

Deno.test("auth gate integration: a signin token is checked once an hour and runs offline", async () => {
  await withWorld(async (w) => {
    // A CI runner: SWAMP_API_KEY and SWAMP_SIGNIN_TOKEN, plus the key cache
    // an earlier whoami left (here, from an unrelated proof).
    await w.saveProof(
      await w.mint({ iat: now(), apiKey: "swamp_someone_else" }),
    );
    const token = toSigninToken(await w.mint({ iat: now() - 90 * DAY }));
    const env = {
      SWAMP_API_KEY: API_KEY,
      SWAMP_SIGNIN_TOKEN: token,
      SWAMP_CLUB_URL: w.serverUrl,
    };

    w.answer(() => whoamiOk());
    assertEquals((await w.gate(env)).kind, "pass");
    assertEquals((await w.gate(env)).kind, "pass");
    assertEquals(w.calls, 1, "the second command reuses the hour's check");

    // swamp-club down: the token carries the run.
    await new AuthVerificationRepository({ configDir: w.configDir })
      .clearTokenCheck();
    w.answer(() => new Response("down", { status: 503 }));
    const offline = await w.gate(env);
    assert(offline.kind === "pass");
    assertEquals(offline.authMode, "offline");

    // Revoked: blocks, even with a valid token.
    w.answer(() => Response.json({ authenticated: false }, { status: 401 }));
    assertEquals(await w.gate(env), {
      kind: "block",
      reason: { kind: "revoked" },
    });
  });
});

Deno.test("auth gate integration: a stale signin token does not shadow a valid login proof", async () => {
  await withWorld(async (w) => {
    await w.login();
    await w.saveProof(await w.mint({ iat: now(), exp: now() + DAY }));
    const stale = toSigninToken(
      await w.mint({ iat: now() - 90 * DAY, apiKey: "swamp_rotated_away" }),
    );
    const outcome = await w.gate({ SWAMP_SIGNIN_TOKEN: stale });
    assert(outcome.kind === "pass");
    assertEquals(outcome.authMode, "verified");
    assertEquals(w.calls, 0);
  });
});

Deno.test("auth gate integration: the weekly refresh saves a fresh proof and drops a revoked one", async () => {
  await withWorld(async (w) => {
    await w.login();
    const old = await w.mint({ iat: now() - 8 * DAY, exp: now() + 6 * DAY });
    await w.saveProof(old);

    const fresh = await w.mint({ iat: now(), exp: now() + 14 * DAY });
    w.answer(() => whoamiOk(fresh));
    const outcome = await w.gate();
    assert(outcome.kind === "pass" && outcome.refresh);
    assertEquals(w.calls, 0, "the refresh runs after the command, not before");
    await withMockedEnv(
      { SWAMP_CONFIG_DIR: w.configDir, SWAMP_API_KEY: undefined },
      () => outcome.refresh!(),
    );
    assertEquals(w.calls, 1);
    const cached = JSON.parse(
      await Deno.readTextFile(join(w.configDir, "auth_verified.json")),
    );
    assertEquals(cached.proof, fresh.proof);

    await w.saveProof(old);
    // An hour later: the last attempt no longer holds the next one back.
    await Deno.remove(join(w.configDir, "auth_refresh_attempt.json"));
    w.answer(() => Response.json({ authenticated: false }, { status: 401 }));
    const again = await w.gate();
    assert(again.kind === "pass" && again.refresh);
    await withMockedEnv(
      { SWAMP_CONFIG_DIR: w.configDir, SWAMP_API_KEY: undefined },
      () => again.refresh!(),
    );
    assertEquals(await exists(join(w.configDir, "auth_verified.json")), false);
  });
});

Deno.test("auth gate integration: a blocked run records one telemetry event and does no other work", async () => {
  const { runCli } = await import("../src/cli/mod.ts");
  const { AuthGateBlockedError } = await import(
    "../src/domain/auth/auth_gate_blocked_error.ts"
  );
  const dir = await Deno.makeTempDir({ prefix: "swamp-gate-block-" });
  try {
    const configDir = join(dir, "config");
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir, { recursive: true });
    // A repo marker, so telemetry records the run (an explicit --repo-dir
    // without one opts out).
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      `swampVersion: "0.0.0"\nrepoId: ${crypto.randomUUID()}\n`,
    );
    await withMockedEnv({
      SWAMP_CONFIG_DIR: configDir,
      SWAMP_HOME: undefined,
      SWAMP_API_KEY: undefined,
      SWAMP_API_KEY_FILE: undefined,
      SWAMP_SIGNIN_TOKEN: undefined,
      [NESTED_GATE_PASS_ENV]: undefined,
      SWAMP_TELEMETRY_ENDPOINT: "http://127.0.0.1:1",
      SWAMP_NO_TELEMETRY: undefined,
      DO_NOT_TRACK: undefined,
    }, async () => {
      await assertRejects(
        () => runCli(["model", "search", "--repo-dir", repoDir]),
        AuthGateBlockedError,
      );
    });

    const spool = join(configDir, "telemetry");
    const entries: Record<string, unknown>[] = [];
    for await (const f of Deno.readDir(spool)) {
      if (f.isFile && f.name.endsWith(".json")) {
        entries.push(JSON.parse(await Deno.readTextFile(join(spool, f.name))));
      }
    }
    assertEquals(entries.length, 1);
    const result = entries[0].result as Record<string, unknown>;
    assertEquals(result.errorType, "AuthGateBlockedError");
    const ctx = entries[0].invocationContext as Record<string, unknown>;
    assertEquals(ctx.authMode, "none");
    const invocation = entries[0].invocation as Record<string, unknown>;
    assertEquals(invocation.command, "model");
    // The run stopped before any startup work touched the repo dir.
    assertEquals(
      [...Deno.readDirSync(repoDir)].map((e) => e.name),
      [".swamp.yaml"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("auth gate integration: an unreadable auth.json is reported as itself, not as no account", async () => {
  if (Deno.build.os === "windows") return;
  await withWorld(async (w) => {
    await w.login();
    const authPath = join(w.configDir, "auth.json");
    await Deno.chmod(authPath, 0o000);
    try {
      // Root can read a mode-000 file; the check only means something
      // for an ordinary user.
      const readable = await Deno.readTextFile(authPath).then(
        () => true,
        () => false,
      );
      if (readable) return;
      await assertRejects(() => w.gate(), Deno.errors.PermissionDenied);
    } finally {
      await Deno.chmod(authPath, 0o600);
    }
  });
});

/** A nested pass for `minted`, as a parent swamp would publish it. */
function nestedPassEnv(
  minted: MintedProof,
  parentPid: number,
): Record<string, string> {
  return {
    [NESTED_GATE_PASS_ENV]: formatNestedGatePass({
      parentPid,
      proof: minted.proof,
      signature: minted.signature,
    }),
  };
}

/** A live ancestor that started a minute ago. */
const anAncestor = (): AncestorCheck => ({
  kind: "ok",
  startedAt: now() - 60,
});

Deno.test("auth gate integration: a nested run with no credential passes on its parent's pass", async () => {
  await withWorld(async (w) => {
    // The cached keys are the only ones trusted; the parent's own key is
    // not this run's business.
    await w.saveProof(await w.mint({ iat: now(), apiKey: "another_key" }));
    // A daemon admitted 20 days ago on a proof that has since expired.
    const parentProof = await w.mint({
      iat: now() - 21 * DAY,
      exp: now() - 7 * DAY,
      apiKey: "parent_key",
    });
    const outcome = await w.gateNested(
      nestedPassEnv(parentProof, 4242),
      () => ({ kind: "ok", startedAt: now() - 20 * DAY }),
    );
    assert(outcome.kind === "pass");
    assertEquals(outcome.authMode, "verified");
    assertEquals(outcome.handoff, {
      proof: parentProof.proof,
      signature: parentProof.signature,
    });
    assertEquals(w.calls, 0);
  });
});

Deno.test("auth gate integration: a nested pass naming this process is not from an ancestor", async () => {
  await withWorld(async (w) => {
    await w.saveProof(await w.mint({ iat: now(), apiKey: "another_key" }));
    const parentProof = await w.mint({
      iat: now(),
      exp: now() + 14 * DAY,
      apiKey: "parent_key",
    });
    // The real ancestry check: a process is never its own ancestor, which is
    // what a pass hand-set in a plain shell (naming that shell) amounts to.
    const outcome = await w.gate(nestedPassEnv(parentProof, Deno.pid));
    assertEquals(outcome, { kind: "block", reason: { kind: "no_credential" } });
  });
});

Deno.test("auth gate integration: a nested pass signed by an untrusted key blocks", async () => {
  await withWorld(async (w) => {
    await w.saveProof(await w.mint({ iat: now(), apiKey: "another_key" }));
    const forged = await mintTestProof(
      await generateTestSigningKey(w.key.publicKey.kid),
      "parent_key",
      { iat: now(), exp: now() + 14 * DAY },
    );
    const outcome = await w.gateNested(nestedPassEnv(forged, 4242), anAncestor);
    assertEquals(outcome, { kind: "block", reason: { kind: "no_credential" } });
  });
});

Deno.test("auth gate integration: a logged-in run ignores an inherited pass and hands on its own", async () => {
  await withWorld(async (w) => {
    await w.login();
    const own = await w.mint({ iat: now() - DAY, exp: now() + DAY });
    await w.saveProof(own);
    const parentProof = await w.mint({
      iat: now(),
      exp: now() + 14 * DAY,
      apiKey: "parent_key",
    });
    const outcome = await w.gateNested(
      nestedPassEnv(parentProof, 4242),
      () => ({ kind: "failed", reason: "must not be consulted" }),
    );
    assert(outcome.kind === "pass");
    assertEquals(outcome.handoff, {
      proof: own.proof,
      signature: own.signature,
    });
  });
});
