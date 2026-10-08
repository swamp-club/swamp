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

import { assertEquals, assertRejects } from "@std/assert";
import type { AuthGateDeps, GateHandoff } from "./auth_gate.ts";
import {
  beginAuthGateSession,
  currentAuthGateSession,
  deferredWorkerAdmission,
  endAuthGateSession,
} from "./auth_gate_session.ts";
import { formatOrchestratorGatePass } from "../domain/auth/nested_gate_pass.ts";
import { AuthGateBlockedError } from "../domain/auth/auth_gate_blocked_error.ts";
import { AuthVerificationRepository } from "../infrastructure/persistence/auth_verification_repository.ts";
import {
  generateTestSigningKey,
  mintTestProof,
} from "../domain/auth/proof_test_helpers.ts";

const NOW = 1_800_000_000;
const DAY = 86_400;

async function withSession(
  deferred: boolean,
  fn: (repo: AuthVerificationRepository) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => undefined,
    });
    const deps = {
      verificationRepo: repo,
      now: () => NOW,
    } as Pick<AuthGateDeps, "verificationRepo" | "now"> as AuthGateDeps;
    beginAuthGateSession({
      deps,
      outcome: deferred
        ? { kind: "block", reason: { kind: "no_credential" } }
        : { kind: "pass", authMode: "verified" },
      gateTime: NOW,
      deferred,
    });
    await fn(repo);
  } finally {
    endAuthGateSession();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("deferredWorkerAdmission: absent when the worker passed the gate itself", async () => {
  await withSession(false, () => {
    assertEquals(deferredWorkerAdmission(), undefined);
    return Promise.resolve();
  });
  assertEquals(currentAuthGateSession(), undefined);
  assertEquals(deferredWorkerAdmission(), undefined);
});

Deno.test("deferredWorkerAdmission: a valid orchestrator pass publishes the worker's own pass", async () => {
  await withSession(true, async (repo) => {
    const key = await generateTestSigningKey();
    // Cache the key, the way an earlier whoami would.
    const cached = await mintTestProof(key, "other", { iat: NOW - DAY });
    await repo.save(cached.proof, cached.signature, cached.publicKeys);
    const serveProof = await mintTestProof(key, "serve_key", {
      iat: NOW - DAY,
      exp: NOW + 13 * DAY,
    });
    const published: GateHandoff[] = [];
    const admit = deferredWorkerAdmission((h) => published.push(h));
    await admit!(formatOrchestratorGatePass(serveProof));
    assertEquals(published, [
      { proof: serveProof.proof, signature: serveProof.signature },
    ]);
  });
});

Deno.test("deferredWorkerAdmission: no pass throws the gate's block and publishes nothing", async () => {
  await withSession(true, async () => {
    const published: GateHandoff[] = [];
    const admit = deferredWorkerAdmission((h) => published.push(h));
    const error = await assertRejects(
      () => admit!(undefined),
      AuthGateBlockedError,
    );
    assertEquals(error.reason, { kind: "no_credential" });
    assertEquals(published, []);
  });
});

Deno.test("endAuthGateSession: clears the session", async () => {
  await withSession(true, () => Promise.resolve());
  assertEquals(currentAuthGateSession(), undefined);
});
