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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  authGateBlockedError,
  type AuthGateCredential,
  type AuthGateDeps,
  blockMessage,
  type NestedGateDeps,
  nestedGatePassValue,
  runAuthGate,
  runProofRefresh,
} from "./auth_gate.ts";
import { parseNestedGatePass } from "../domain/auth/nested_gate_pass.ts";
import { AuthVerificationRepository } from "../infrastructure/persistence/auth_verification_repository.ts";
import type {
  IdentityCheckResult,
  WhoamiResponse,
} from "../infrastructure/http/swamp_club_client.ts";
import {
  generateTestSigningKey,
  type MintedProof,
  mintTestProof,
  type TestSigningKey,
  toSigninToken,
} from "../domain/auth/proof_test_helpers.ts";

const NOW = 1_800_000_000;
const DAY = 86_400;
const API_KEY = "swamp_test_gate_key";
const CREDENTIAL: AuthGateCredential = {
  apiKey: API_KEY,
  serverUrl: "https://swamp-club.test",
};

interface Harness {
  readonly dir: string;
  readonly repo: AuthVerificationRepository;
  readonly key: TestSigningKey;
  readonly calls: AbortSignal[];
  deps(options?: {
    credential?: AuthGateCredential | null;
    answer?: IdentityCheckResult;
    now?: number;
    canWrite?: boolean;
    nested?: NestedGateDeps;
  }): AuthGateDeps;
}

async function withHarness(
  fn: (h: Harness) => Promise<void>,
  signinToken?: (key: TestSigningKey) => Promise<string>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const key = await generateTestSigningKey();
    const token = signinToken ? await signinToken(key) : undefined;
    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => token,
    });
    const calls: AbortSignal[] = [];
    await fn({
      dir,
      repo,
      key,
      calls,
      deps: (options = {}) => ({
        loadCredential: () =>
          Promise.resolve(
            options.credential === undefined ? CREDENTIAL : options.credential,
          ),
        verificationRepo: repo,
        verifyIdentity: (_credential, signal) => {
          calls.push(signal);
          return Promise.resolve(
            options.answer ??
              { outcome: { kind: "unreachable", reason: "no answer set" } },
          );
        },
        now: () => options.now ?? NOW,
        canWrite: options.canWrite,
        nested: options.nested,
      }),
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function saveProof(h: Harness, minted: MintedProof): Promise<void> {
  await h.repo.save(minted.proof, minted.signature, minted.publicKeys);
}

function verifiedWith(minted?: MintedProof): IdentityCheckResult {
  const response: WhoamiResponse = minted
    ? {
      authenticated: true,
      username: "u",
      verificationProof: minted.proof,
      verificationSignature: minted.signature,
      publicKeys: minted.publicKeys,
    }
    : { authenticated: true, username: "u" };
  return {
    outcome: { kind: "verified", freshProof: Boolean(minted) },
    response,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("runAuthGate: no credential blocks without calling swamp-club", async () => {
  await withHarness(async (h) => {
    const outcome = await runAuthGate(h.deps({ credential: null }));
    assertEquals(outcome, { kind: "block", reason: { kind: "no_credential" } });
    assertEquals(h.calls.length, 0);
  });
});

Deno.test("runAuthGate: a valid file proof passes with no network call", async () => {
  await withHarness(async (h) => {
    await saveProof(
      h,
      await mintTestProof(h.key, API_KEY, { iat: NOW - DAY, exp: NOW + DAY }),
    );
    const outcome = await runAuthGate(h.deps());
    assertEquals(outcome.kind, "pass");
    assert(outcome.kind === "pass");
    assertEquals(outcome.authMode, "verified");
    assertEquals(outcome.refresh, undefined);
    assertEquals(h.calls.length, 0);
  });
});

Deno.test("runAuthGate: first run verifies live and caches the proof", async () => {
  await withHarness(async (h) => {
    const fresh = await mintTestProof(h.key, API_KEY, {
      iat: NOW,
      exp: NOW + 14 * DAY,
    });
    const outcome = await runAuthGate(h.deps({ answer: verifiedWith(fresh) }));
    assert(outcome.kind === "pass");
    assertEquals(outcome.authMode, "verified");
    assertEquals(outcome.liveResponse?.username, "u");
    assertEquals(h.calls.length, 1);
    const [cached] = await h.repo.loadCandidates();
    assertEquals(cached.verification.proof, fresh.proof);
    // The next run needs no network.
    const again = await runAuthGate(h.deps());
    assert(again.kind === "pass");
    assertEquals(h.calls.length, 1);
  });
});

Deno.test("runAuthGate: a verified answer without a proof passes and caches nothing", async () => {
  await withHarness(async (h) => {
    const outcome = await runAuthGate(h.deps({ answer: verifiedWith() }));
    assert(outcome.kind === "pass");
    assertEquals(outcome.authMode, "verified");
    assertEquals(await h.repo.loadCandidates(), []);
  });
});

Deno.test("runAuthGate: a proof for another key does not count", async () => {
  await withHarness(async (h) => {
    await saveProof(
      h,
      await mintTestProof(h.key, "swamp_some_other_key", {
        iat: NOW - DAY,
        exp: NOW + DAY,
      }),
    );
    const outcome = await runAuthGate(
      h.deps({ answer: { outcome: { kind: "unreachable", reason: "dns" } } }),
    );
    assertEquals(outcome, {
      kind: "block",
      reason: {
        kind: "unreachable_unverified",
        daysSinceVerification: undefined,
      },
    });
  });
});

Deno.test("runAuthGate: a rejection blocks and deletes this key's file proof", async () => {
  await withHarness(async (h) => {
    await saveProof(
      h,
      await mintTestProof(h.key, API_KEY, {
        iat: NOW - 20 * DAY,
        exp: NOW - DAY,
      }),
    );
    const outcome = await runAuthGate(
      h.deps({ answer: { outcome: { kind: "rejected", status: 401 } } }),
    );
    assertEquals(outcome, { kind: "block", reason: { kind: "revoked" } });
    assertEquals(
      await fileExists(join(h.dir, "auth_verified.json")),
      false,
    );
  });
});

Deno.test("runAuthGate: an expired proof and no network names the days since verification", async () => {
  await withHarness(async (h) => {
    await saveProof(
      h,
      await mintTestProof(h.key, API_KEY, {
        iat: NOW - 15 * DAY,
        exp: NOW - DAY,
      }),
    );
    const outcome = await runAuthGate(
      h.deps({
        answer: { outcome: { kind: "unreachable", reason: "timeout" } },
      }),
    );
    assertEquals(outcome, {
      kind: "block",
      reason: { kind: "unreachable_unverified", daysSinceVerification: 15 },
    });
  });
});

Deno.test("runAuthGate: a 5xx without a proof fails open for 24 hours, then blocks", async () => {
  await withHarness(async (h) => {
    const answer: IdentityCheckResult = {
      outcome: { kind: "server_error", status: 503 },
    };
    const first = await runAuthGate(h.deps({ answer }));
    assert(first.kind === "pass");
    assertEquals(first.authMode, "offline");
    assertStringIncludes(first.warning ?? "", "24 hours");
    assertEquals(await h.repo.readFailOpenSince(), NOW);

    const later = await runAuthGate(
      h.deps({ answer, now: NOW + DAY - 1 }),
    );
    assertEquals(later.kind, "pass");
    // The window keeps its original start.
    assertEquals(await h.repo.readFailOpenSince(), NOW);

    const dayLater = await runAuthGate(h.deps({ answer, now: NOW + DAY }));
    assertEquals(dayLater, {
      kind: "block",
      reason: { kind: "unverified_for_a_day" },
    });
  });
});

Deno.test("runAuthGate: verifying ends the fail-open window", async () => {
  await withHarness(async (h) => {
    await h.repo.markFailOpenSince(NOW - 60);
    await runAuthGate(h.deps({ answer: verifiedWith() }));
    assertEquals(await h.repo.readFailOpenSince(), undefined);
  });
});

Deno.test("runAuthGate: a future-dated fail-open stamp restarts at now", async () => {
  await withHarness(async (h) => {
    await h.repo.markFailOpenSince(NOW + 365 * DAY);
    const outcome = await runAuthGate(
      h.deps({ answer: { outcome: { kind: "server_error", status: 500 } } }),
    );
    assertEquals(outcome.kind, "pass");
    assertEquals(await h.repo.readFailOpenSince(), NOW);
  });
});

Deno.test("runAuthGate: without a proof a 429 or a proxy 403 blocks", async () => {
  await withHarness(async (h) => {
    for (const status of [429, 403]) {
      const outcome = await runAuthGate(
        h.deps({ answer: { outcome: { kind: "refused", status } } }),
      );
      assertEquals(outcome.kind, "block");
    }
    assertEquals(await h.repo.readFailOpenSince(), undefined);
  });
});

Deno.test("runAuthGate: a signin token is checked live, then trusted for an hour", async () => {
  await withHarness(
    async (h) => {
      // Cache the signing key the way a past whoami would have.
      await saveProof(
        h,
        await mintTestProof(h.key, "swamp_unrelated", { iat: NOW - DAY }),
      );
      const first = await runAuthGate(h.deps({ answer: verifiedWith() }));
      assert(first.kind === "pass");
      assertEquals(first.authMode, "verified");
      assertEquals(h.calls.length, 1);

      await runAuthGate(h.deps({ now: NOW + 60 * 59 }));
      assertEquals(h.calls.length, 1);

      await runAuthGate(
        h.deps({ answer: verifiedWith(), now: NOW + 60 * 60 }),
      );
      assertEquals(h.calls.length, 2);
    },
    async (key) => {
      // The token verifies with the key cached by an earlier whoami.
      return toSigninToken(
        await mintTestProof(key, API_KEY, { iat: NOW - 90 * DAY }),
      );
    },
  );
});

Deno.test("runAuthGate: a signin token runs offline when swamp-club is down", async () => {
  await withHarness(
    async (h) => {
      // Cache the signing key the way a past whoami would have.
      await saveProof(
        h,
        await mintTestProof(h.key, "swamp_unrelated", { iat: NOW - DAY }),
      );
      for (
        const outcome of [
          { kind: "unreachable", reason: "timeout" } as const,
          { kind: "server_error", status: 502 } as const,
          { kind: "refused", status: 429 } as const,
        ]
      ) {
        const result = await runAuthGate(h.deps({ answer: { outcome } }));
        assert(result.kind === "pass");
        assertEquals(result.authMode, "offline");
        assertStringIncludes(
          result.warning ?? "",
          "using your cached verification",
        );
      }
    },
    async (key) =>
      toSigninToken(await mintTestProof(key, API_KEY, { iat: NOW - 90 * DAY })),
  );
});

Deno.test("runAuthGate: a revoked signin token blocks and forgets its check", async () => {
  await withHarness(
    async (h) => {
      await saveProof(
        h,
        await mintTestProof(h.key, "swamp_personal", { iat: NOW - DAY }),
      );
      await h.repo.recordTokenCheck("stale", NOW);
      const outcome = await runAuthGate(
        h.deps({ answer: { outcome: { kind: "rejected", status: 401 } } }),
      );
      assertEquals(outcome, { kind: "block", reason: { kind: "revoked" } });
      // The personal login's proof belongs to another key and survives.
      assert(await fileExists(join(h.dir, "auth_verified.json")));
      assertEquals(
        await fileExists(join(h.dir, "auth_token_check.json")),
        false,
      );
    },
    async (key) =>
      toSigninToken(await mintTestProof(key, API_KEY, { iat: NOW - 90 * DAY })),
  );
});

Deno.test("runAuthGate: a stale signin token does not shadow a valid file proof", async () => {
  await withHarness(
    async (h) => {
      await saveProof(
        h,
        await mintTestProof(h.key, API_KEY, { iat: NOW - DAY, exp: NOW + DAY }),
      );
      const outcome = await runAuthGate(h.deps());
      assert(outcome.kind === "pass");
      assertEquals(outcome.authMode, "verified");
      assertEquals(h.calls.length, 0);
    },
    async (key) =>
      toSigninToken(
        await mintTestProof(key, "swamp_rotated_away", { iat: NOW - 90 * DAY }),
      ),
  );
});

Deno.test("runAuthGate: a file proof older than a week offers the weekly refresh", async () => {
  await withHarness(async (h) => {
    await saveProof(
      h,
      await mintTestProof(h.key, API_KEY, {
        iat: NOW - 8 * DAY,
        exp: NOW + DAY,
      }),
    );
    const outcome = await runAuthGate(h.deps());
    assert(outcome.kind === "pass");
    assert(outcome.refresh, "a week-old proof is due a refresh");
  });
});

Deno.test("runProofRefresh: saves a fresh proof, deletes on rejection, keeps on failure", async () => {
  await withHarness(async (h) => {
    const old = await mintTestProof(h.key, API_KEY, {
      iat: NOW - 8 * DAY,
      exp: NOW + DAY,
    });
    await saveProof(h, old);

    await runProofRefresh(
      h.deps({ answer: { outcome: { kind: "server_error", status: 500 } } }),
    );
    assertEquals(
      (await h.repo.loadCandidates())[0].verification.proof,
      old.proof,
    );

    const fresh = await mintTestProof(h.key, API_KEY, {
      iat: NOW,
      exp: NOW + 14 * DAY,
    });
    await runProofRefresh(h.deps({ answer: verifiedWith(fresh) }));
    assertEquals(
      (await h.repo.loadCandidates())[0].verification.proof,
      fresh.proof,
    );

    await runProofRefresh(
      h.deps({ answer: { outcome: { kind: "rejected", status: 401 } } }),
    );
    assertEquals(await h.repo.loadCandidates(), []);
  });
});

Deno.test("runAuthGate: a read-only config dir does not fail a passing run", async () => {
  if (Deno.build.os === "windows") return;
  await withHarness(async (h) => {
    await Deno.chmod(h.dir, 0o500);
    try {
      const outcome = await runAuthGate(
        h.deps({ answer: { outcome: { kind: "server_error", status: 500 } } }),
      );
      assertEquals(outcome.kind, "pass");
    } finally {
      await Deno.chmod(h.dir, 0o700);
    }
  });
});

Deno.test("authGateBlockedError: carries the reason, the code and the design's message", () => {
  const error = authGateBlockedError({ kind: "no_credential" });
  assertEquals(error.name, "AuthGateBlockedError");
  assertEquals(error.code, "auth_gate_blocked");
  assertStringIncludes(error.message, "swamp auth login");
  assertStringIncludes(error.message, "SWAMP_SIGNIN_TOKEN");
  assertStringIncludes(blockMessage({ kind: "revoked" }), "revoked");
  assertStringIncludes(
    blockMessage({ kind: "unreachable_unverified", daysSinceVerification: 15 }),
    "15 days",
  );
  assertStringIncludes(
    blockMessage({ kind: "refused", status: 429, retryAfterSeconds: 30 }),
    "Retry in 30s",
  );
});

Deno.test("runAuthGate: a refresh attempt suppresses the next for an hour", async () => {
  await withHarness(async (h) => {
    await saveProof(
      h,
      await mintTestProof(h.key, API_KEY, {
        iat: NOW - 8 * DAY,
        exp: NOW + DAY,
      }),
    );
    const offline: IdentityCheckResult = {
      outcome: { kind: "unreachable", reason: "timeout" },
    };
    const first = await runAuthGate(h.deps({ answer: offline }));
    assert(first.kind === "pass" && first.refresh);
    await first.refresh();
    assertEquals(h.calls.length, 1);

    const soon = await runAuthGate(h.deps({ now: NOW + 60 * 59 }));
    assert(soon.kind === "pass");
    assertEquals(soon.refresh, undefined, "no second attempt within the hour");

    const later = await runAuthGate(h.deps({ now: NOW + 60 * 60 }));
    assert(later.kind === "pass");
    assert(later.refresh, "tries again after an hour");
  });
});

Deno.test("blockMessage: waits read in sensible units and days are pluralised", () => {
  assertStringIncludes(
    blockMessage({ kind: "refused", status: 429, retryAfterSeconds: 3600 }),
    "Retry in 60 minutes",
  );
  assertStringIncludes(
    blockMessage({ kind: "refused", status: 429, retryAfterSeconds: 3 * 3600 }),
    "Retry in 3 hours",
  );
  assertStringIncludes(
    blockMessage({ kind: "unreachable_unverified", daysSinceVerification: 1 }),
    "in 1 day.",
  );
});

Deno.test("blockMessage: a refusal names the status and the proxy, and unreachable points at auth whoami", () => {
  const refused = blockMessage({ kind: "refused", status: 403 });
  assertStringIncludes(refused, "(HTTP 403)");
  assertStringIncludes(refused, "a proxy between");
  assertStringIncludes(
    blockMessage({ kind: "unreachable_unverified" }),
    "swamp auth whoami",
  );
});

Deno.test("runAuthGate: a process that does not own the config dir reads but never writes", async () => {
  await withHarness(async (h) => {
    const fresh = await mintTestProof(h.key, API_KEY, {
      iat: NOW,
      exp: NOW + 14 * DAY,
    });
    const verified = await runAuthGate(
      h.deps({ answer: verifiedWith(fresh), canWrite: false }),
    );
    assertEquals(verified.kind, "pass");
    const outage = await runAuthGate(
      h.deps({
        answer: { outcome: { kind: "server_error", status: 503 } },
        canWrite: false,
      }),
    );
    assertEquals(outage.kind, "pass");
    assertEquals([...Deno.readDirSync(h.dir)], [], "nothing written");

    // It still passes on a proof the owner cached, and offers no refresh.
    await saveProof(
      h,
      await mintTestProof(h.key, API_KEY, {
        iat: NOW - 8 * DAY,
        exp: NOW + DAY,
      }),
    );
    const owned = await runAuthGate(h.deps({ canWrite: false }));
    assert(owned.kind === "pass");
    assertEquals(owned.authMode, "verified");
    assertEquals(owned.refresh, undefined);
  });
});

const PARENT_PID = 4242;
/** When the parent swamp in these tests started. */
const PARENT_STARTED_AT = NOW - 60;

/** Nested deps that hand over `minted` from PARENT_PID. */
function nestedFrom(
  minted: MintedProof | null,
  ancestor: NestedGateDeps["checkAncestor"] = () => ({
    kind: "ok",
    startedAt: PARENT_STARTED_AT,
  }),
): NestedGateDeps & { readonly checked: number[] } {
  const checked: number[] = [];
  return {
    checked,
    loadPass: () =>
      minted
        ? {
          parentPid: PARENT_PID,
          proof: minted.proof,
          signature: minted.signature,
        }
        : null,
    checkAncestor: (pid) => {
      checked.push(pid);
      return ancestor(pid);
    },
  };
}

/** Cache the test key's public key, the way an earlier whoami would. */
async function cacheTestKey(h: Harness): Promise<void> {
  await saveProof(
    h,
    await mintTestProof(h.key, "some_other_key", { iat: NOW - DAY }),
  );
}

Deno.test("runAuthGate: no credential with a valid nested pass passes and hands it on", async () => {
  await withHarness(async (h) => {
    await cacheTestKey(h);
    const parentProof = await mintTestProof(h.key, "parent_key", {
      iat: NOW - DAY,
      exp: NOW + 13 * DAY,
    });
    const nested = nestedFrom(parentProof);
    const outcome = await runAuthGate(h.deps({ credential: null, nested }));
    assert(outcome.kind === "pass");
    assertEquals(outcome.authMode, "verified");
    assertEquals(outcome.handoff, {
      proof: parentProof.proof,
      signature: parentProof.signature,
      issuerPid: PARENT_PID,
    });
    assertEquals(nested.checked, [PARENT_PID]);
    assertEquals(h.calls.length, 0);
  });
});

Deno.test("runAuthGate: a nested pass is accepted past its exp under an ancestor started before it", async () => {
  await withHarness(async (h) => {
    await cacheTestKey(h);
    // A daemon admitted 30 days ago on a proof that has since expired.
    const expired = await mintTestProof(h.key, "parent_key", {
      iat: NOW - 31 * DAY,
      exp: NOW - 17 * DAY,
    });
    const outcome = await runAuthGate(
      h.deps({
        credential: null,
        nested: nestedFrom(
          expired,
          () => ({ kind: "ok", startedAt: NOW - 30 * DAY }),
        ),
      }),
    );
    assertEquals(outcome.kind, "pass");
  });
});

Deno.test("runAuthGate: a nested pass whose proof expired before its ancestor started blocks", async () => {
  await withHarness(async (h) => {
    await cacheTestKey(h);
    // A leaked old proof, named by a process started after it expired.
    const old = await mintTestProof(h.key, "parent_key", {
      iat: NOW - 31 * DAY,
      exp: NOW - 17 * DAY,
    });
    const outcome = await runAuthGate(
      h.deps({ credential: null, nested: nestedFrom(old) }),
    );
    assertEquals(outcome, { kind: "block", reason: { kind: "no_credential" } });
  });
});

Deno.test("runAuthGate: a nested pass without exp (a signin token) blocks", async () => {
  await withHarness(async (h) => {
    await cacheTestKey(h);
    const token = await mintTestProof(h.key, "parent_key", { iat: NOW - DAY });
    const outcome = await runAuthGate(
      h.deps({ credential: null, nested: nestedFrom(token) }),
    );
    assertEquals(outcome, { kind: "block", reason: { kind: "no_credential" } });
  });
});

Deno.test("runAuthGate: a nested pass signed by an untrusted key blocks", async () => {
  await withHarness(async (h) => {
    await cacheTestKey(h);
    const forged = await mintTestProof(
      await generateTestSigningKey(h.key.publicKey.kid),
      "parent_key",
      { iat: NOW, exp: NOW + 14 * DAY },
    );
    const nested = nestedFrom(forged);
    const outcome = await runAuthGate(h.deps({ credential: null, nested }));
    assertEquals(outcome, { kind: "block", reason: { kind: "no_credential" } });
    // The signature fails first; ancestry is never consulted.
    assertEquals(nested.checked, []);
  });
});

Deno.test("runAuthGate: a nested pass from a pid that is not a live swamp ancestor blocks", async () => {
  await withHarness(async (h) => {
    await cacheTestKey(h);
    const parentProof = await mintTestProof(h.key, "parent_key", {
      iat: NOW,
      exp: NOW + 14 * DAY,
    });
    const outcome = await runAuthGate(
      h.deps({
        credential: null,
        nested: nestedFrom(
          parentProof,
          () => ({ kind: "failed", reason: "not an ancestor" }),
        ),
      }),
    );
    assertEquals(outcome, { kind: "block", reason: { kind: "no_credential" } });
  });
});

Deno.test("runAuthGate: a credential takes precedence over a nested pass", async () => {
  await withHarness(async (h) => {
    await cacheTestKey(h);
    const parentProof = await mintTestProof(h.key, "parent_key", { iat: NOW });
    const nested = nestedFrom(parentProof);
    // The run's own key has no proof, so it is checked live and the
    // rejection blocks, whatever the inherited pass says.
    const outcome = await runAuthGate(
      h.deps({
        nested,
        answer: { outcome: { kind: "rejected", status: 401 } },
      }),
    );
    assertEquals(outcome, { kind: "block", reason: { kind: "revoked" } });
    assertEquals(nested.checked, []);
  });
});

Deno.test("runAuthGate: a pass on a cached proof hands that proof on", async () => {
  await withHarness(async (h) => {
    const cached = await mintTestProof(h.key, API_KEY, {
      iat: NOW - DAY,
      exp: NOW + DAY,
    });
    await saveProof(h, cached);
    const outcome = await runAuthGate(h.deps());
    assert(outcome.kind === "pass");
    assertEquals(outcome.handoff, {
      proof: cached.proof,
      signature: cached.signature,
    });
  });
});

Deno.test("runAuthGate: a live verification hands on the fresh proof", async () => {
  await withHarness(async (h) => {
    const fresh = await mintTestProof(h.key, API_KEY, {
      iat: NOW,
      exp: NOW + 14 * DAY,
    });
    const outcome = await runAuthGate(h.deps({ answer: verifiedWith(fresh) }));
    assert(outcome.kind === "pass");
    assertEquals(outcome.handoff, {
      proof: fresh.proof,
      signature: fresh.signature,
    });
  });
});

Deno.test("runAuthGate: a fail-open pass with no proof hands nothing on", async () => {
  await withHarness(async (h) => {
    const outcome = await runAuthGate(
      h.deps({ answer: { outcome: { kind: "server_error", status: 503 } } }),
    );
    assert(outcome.kind === "pass");
    assertEquals(outcome.authMode, "offline");
    assertEquals(outcome.handoff, undefined);
  });
});

Deno.test("runAuthGate: a pass on a signin token hands down the file proof, never the token", async () => {
  let token: MintedProof | undefined;
  await withHarness(
    async (h) => {
      const cached = await mintTestProof(h.key, API_KEY, {
        iat: NOW - DAY,
        exp: NOW + 13 * DAY,
      });
      await saveProof(h, cached);
      await h.repo.recordTokenCheck(
        JSON.parse(token!.proof).fpr,
        NOW - 60,
      );
      const outcome = await runAuthGate(h.deps());
      assert(outcome.kind === "pass");
      assertEquals(h.calls.length, 0);
      assertEquals(outcome.handoff, {
        proof: cached.proof,
        signature: cached.signature,
      });
    },
    async (key) => {
      token = await mintTestProof(key, API_KEY, { iat: NOW - 90 * DAY });
      return toSigninToken(token);
    },
  );
});

Deno.test("runAuthGate: a pass on a signin token alone hands nothing down", async () => {
  await withHarness(
    async (h) => {
      // Only the signing key is cached; the file proof is for another key.
      await cacheTestKey(h);
      const outcome = await runAuthGate(
        h.deps({ answer: { outcome: { kind: "unreachable", reason: "dns" } } }),
      );
      assert(outcome.kind === "pass");
      assertEquals(outcome.authMode, "offline");
      assertEquals(outcome.handoff, undefined);
    },
    async (key) =>
      toSigninToken(await mintTestProof(key, API_KEY, { iat: NOW - 90 * DAY })),
  );
});

Deno.test("nestedGatePassValue: names this run for its own proof, the issuer for an inherited one", () => {
  assertEquals(nestedGatePassValue(undefined, 7), undefined);
  const own = nestedGatePassValue({ proof: "{}", signature: "c2ln" }, 7);
  assertEquals(own?.split(".")[0], "7");
  const inherited = nestedGatePassValue(
    { proof: "{}", signature: "c2ln", issuerPid: 4242 },
    7,
  );
  assertEquals(inherited?.split(".")[0], "4242");
});

Deno.test("runAuthGate: a grandchild passes under a daemon that outlived its proof", async () => {
  await withHarness(async (h) => {
    await cacheTestKey(h);
    // The daemon (PARENT_PID) was admitted 20 days ago on a proof that
    // expired 6 days later. The nested run in between started today.
    const daemonStart = NOW - 20 * DAY;
    const proof = await mintTestProof(h.key, "daemon_key", {
      iat: NOW - 21 * DAY,
      exp: NOW - 14 * DAY,
    });
    const middlePid = 5000;
    const startedAt = (pid: number) =>
      pid === PARENT_PID ? daemonStart : NOW - 60;

    const middle = await runAuthGate(h.deps({
      credential: null,
      nested: nestedFrom(
        proof,
        (pid) => ({ kind: "ok", startedAt: startedAt(pid) }),
      ),
    }));
    assert(middle.kind === "pass");

    // What the nested run publishes for its own children.
    const value = nestedGatePassValue(middle.handoff, middlePid);
    assert(value !== undefined);
    const checked: number[] = [];
    const grandchild = await runAuthGate(h.deps({
      credential: null,
      nested: {
        loadPass: () => parseNestedGatePass(value),
        checkAncestor: (pid) => {
          checked.push(pid);
          return { kind: "ok", startedAt: startedAt(pid) };
        },
      },
    }));
    assertEquals(grandchild.kind, "pass");
    // Judged against the daemon, not the nested run that started today.
    assertEquals(checked, [PARENT_PID]);
  });
});
