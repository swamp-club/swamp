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
import {
  decideAfterCheck,
  decideBeforeCheck,
  FAIL_OPEN_WINDOW_SECONDS,
  type LocalProofVerdict,
  NO_EFFECTS,
  REFRESH_AFTER_SECONDS,
  REFRESH_RETRY_SECONDS,
  refreshEffects,
  shouldRefresh,
  TOKEN_CHECK_TTL_SECONDS,
} from "./auth_gate_policy.ts";

const NOW = 1_800_000_000;
const DAY = 86_400;

const fileProof: LocalProofVerdict = {
  kind: "valid",
  source: "file",
  issuedAt: NOW - DAY,
};
const tokenProof: LocalProofVerdict = {
  kind: "valid",
  source: "signin_token",
  issuedAt: NOW - 90 * DAY,
};
const missing: LocalProofVerdict = { kind: "missing" };

Deno.test("decideBeforeCheck: no credential blocks", () => {
  assertEquals(
    decideBeforeCheck({ credentialPresent: false, proof: fileProof, now: NOW }),
    { kind: "block", reason: { kind: "no_credential" } },
  );
});

Deno.test("decideBeforeCheck: a valid file proof passes with no live check", () => {
  assertEquals(
    decideBeforeCheck({ credentialPresent: true, proof: fileProof, now: NOW }),
    { kind: "pass", authMode: "verified" },
  );
});

Deno.test("decideBeforeCheck: no valid proof asks for a blocking check", () => {
  for (
    const proof of [
      missing,
      { kind: "expired", issuedAt: NOW - 20 * DAY } as const,
      { kind: "invalid", reason: "fingerprint mismatch" } as const,
    ]
  ) {
    assertEquals(
      decideBeforeCheck({ credentialPresent: true, proof, now: NOW }),
      { kind: "check", timeout: "blocking" },
    );
  }
});

Deno.test("decideBeforeCheck: a signin token is checked unless checked within the hour", () => {
  assertEquals(
    decideBeforeCheck({ credentialPresent: true, proof: tokenProof, now: NOW }),
    { kind: "check", timeout: "short" },
  );
  assertEquals(
    decideBeforeCheck({
      credentialPresent: true,
      proof: tokenProof,
      lastTokenCheckAt: NOW - TOKEN_CHECK_TTL_SECONDS + 1,
      now: NOW,
    }),
    { kind: "pass", authMode: "verified" },
  );
  assertEquals(
    decideBeforeCheck({
      credentialPresent: true,
      proof: tokenProof,
      lastTokenCheckAt: NOW - TOKEN_CHECK_TTL_SECONDS,
      now: NOW,
    }),
    { kind: "check", timeout: "short" },
  );
});

Deno.test("decideBeforeCheck: a future token-check time is ignored", () => {
  assertEquals(
    decideBeforeCheck({
      credentialPresent: true,
      proof: tokenProof,
      lastTokenCheckAt: NOW + 10 * DAY,
      now: NOW,
    }),
    { kind: "check", timeout: "short" },
  );
});

Deno.test("decideAfterCheck: verified passes, saves the proof and ends the fail-open window", () => {
  assertEquals(
    decideAfterCheck({
      proof: missing,
      outcome: { kind: "verified", freshProof: true },
      failOpenSince: NOW - 60,
      now: NOW,
    }),
    {
      decision: { kind: "pass", authMode: "verified" },
      effects: { ...NO_EFFECTS, saveProof: true, clearFailOpen: true },
    },
  );
});

Deno.test("decideAfterCheck: a verified signin token is remembered", () => {
  const { effects } = decideAfterCheck({
    proof: tokenProof,
    outcome: { kind: "verified", freshProof: false },
    now: NOW,
  });
  assertEquals(effects.recordTokenCheck, true);
  assertEquals(effects.saveProof, false);
});

Deno.test("decideAfterCheck: a rejection blocks even with a valid proof", () => {
  for (const proof of [fileProof, tokenProof, missing]) {
    assertEquals(
      decideAfterCheck({
        proof,
        outcome: { kind: "rejected", status: 401 },
        now: NOW,
      }),
      {
        decision: { kind: "block", reason: { kind: "revoked" } },
        effects: {
          ...NO_EFFECTS,
          deleteFileProof: true,
          clearTokenCheck: true,
        },
      },
    );
  }
});

Deno.test("decideAfterCheck: with a valid proof every failure passes offline", () => {
  for (
    const outcome of [
      { kind: "server_error", status: 503 } as const,
      { kind: "refused", status: 429 } as const,
      { kind: "refused", status: 403 } as const,
      { kind: "unreachable", reason: "timeout" } as const,
    ]
  ) {
    assertEquals(
      decideAfterCheck({ proof: tokenProof, outcome, now: NOW }).decision,
      { kind: "pass", authMode: "offline" },
    );
  }
});

Deno.test("decideAfterCheck: without a proof a 5xx opens the fail-open window", () => {
  assertEquals(
    decideAfterCheck({
      proof: missing,
      outcome: { kind: "server_error", status: 502 },
      now: NOW,
    }),
    {
      decision: { kind: "pass", authMode: "offline" },
      effects: { ...NO_EFFECTS, markFailOpen: true },
    },
  );
});

Deno.test("decideAfterCheck: the fail-open window lasts 24 hours", () => {
  const inside = decideAfterCheck({
    proof: missing,
    outcome: { kind: "server_error", status: 500 },
    failOpenSince: NOW - FAIL_OPEN_WINDOW_SECONDS + 1,
    now: NOW,
  });
  assertEquals(inside.decision, { kind: "pass", authMode: "offline" });
  assertEquals(inside.effects, NO_EFFECTS);

  const past = decideAfterCheck({
    proof: missing,
    outcome: { kind: "server_error", status: 500 },
    failOpenSince: NOW - FAIL_OPEN_WINDOW_SECONDS,
    now: NOW,
  });
  assertEquals(past.decision, {
    kind: "block",
    reason: { kind: "unverified_for_a_day" },
  });
});

Deno.test("decideAfterCheck: a future fail-open stamp restarts the window at now", () => {
  assertEquals(
    decideAfterCheck({
      proof: missing,
      outcome: { kind: "server_error", status: 500 },
      failOpenSince: NOW + 30 * DAY,
      now: NOW,
    }).effects.markFailOpen,
    true,
  );
});

Deno.test("decideAfterCheck: without a proof a 429 or proxy 403 blocks", () => {
  assertEquals(
    decideAfterCheck({
      proof: missing,
      outcome: { kind: "refused", status: 429, retryAfterSeconds: 30 },
      now: NOW,
    }).decision,
    {
      kind: "block",
      reason: { kind: "refused", status: 429, retryAfterSeconds: 30 },
    },
  );
});

Deno.test("decideAfterCheck: without a proof an unreachable server blocks", () => {
  assertEquals(
    decideAfterCheck({
      proof: { kind: "expired", issuedAt: NOW - 15 * DAY - 60 },
      outcome: { kind: "unreachable", reason: "dns" },
      now: NOW,
    }).decision,
    {
      kind: "block",
      reason: { kind: "unreachable_unverified", daysSinceVerification: 15 },
    },
  );
  assertEquals(
    decideAfterCheck({
      proof: missing,
      outcome: { kind: "unreachable", reason: "timeout" },
      now: NOW,
    }).decision,
    {
      kind: "block",
      reason: {
        kind: "unreachable_unverified",
        daysSinceVerification: undefined,
      },
    },
  );
});

Deno.test("shouldRefresh: only file proofs older than a week", () => {
  assertEquals(shouldRefresh(fileProof, NOW), false);
  assertEquals(
    shouldRefresh(
      {
        kind: "valid",
        source: "file",
        issuedAt: NOW - REFRESH_AFTER_SECONDS - 1,
      },
      NOW,
    ),
    true,
  );
  assertEquals(shouldRefresh(tokenProof, NOW), false);
  assertEquals(shouldRefresh(missing, NOW), false);
});

Deno.test("refreshEffects: saves on verified, deletes on rejection, keeps otherwise", () => {
  assertEquals(refreshEffects({ kind: "verified", freshProof: true }), {
    ...NO_EFFECTS,
    saveProof: true,
    clearFailOpen: true,
  });
  assertEquals(refreshEffects({ kind: "rejected", status: 401 }), {
    ...NO_EFFECTS,
    deleteFileProof: true,
  });
  assertEquals(refreshEffects({ kind: "refused", status: 403 }), NO_EFFECTS);
  assertEquals(
    refreshEffects({ kind: "server_error", status: 500 }),
    NO_EFFECTS,
  );
  assertEquals(
    refreshEffects({ kind: "unreachable", reason: "timeout" }),
    NO_EFFECTS,
  );
});

Deno.test("shouldRefresh: waits an hour after an attempt, ignoring future stamps", () => {
  const old: LocalProofVerdict = {
    kind: "valid",
    source: "file",
    issuedAt: NOW - REFRESH_AFTER_SECONDS - 1,
  };
  assertEquals(shouldRefresh(old, NOW, NOW - REFRESH_RETRY_SECONDS + 1), false);
  assertEquals(shouldRefresh(old, NOW, NOW - REFRESH_RETRY_SECONDS), true);
  assertEquals(shouldRefresh(old, NOW, NOW + DAY), true);
  assertEquals(shouldRefresh(old, NOW, undefined), true);
});
