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
import type {
  EnrollmentBindingCutoffCause,
  EnrollmentToken,
} from "../domain/models/worker/enrollment_token_model.ts";
import {
  type WorkerTokenRevalidationDeps,
  WorkerTokenRevalidationService,
} from "./worker_token_revalidation_service.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

const MINT = "2026-01-01T00:00:00.000Z";

function tokenRecord(overrides: Partial<EnrollmentToken>): EnrollmentToken {
  return {
    name: "ci-runner-3",
    state: "enrolled",
    createdAt: MINT,
    expiresAt: "2099-01-01T00:00:00.000Z",
    vaultName: "local",
    secretKey: "worker-token-ci-runner-3",
    maxEnrollments: 1,
    bindings: [],
    ...overrides,
  };
}

interface RevokeCall {
  name: string;
  cause: EnrollmentBindingCutoffCause;
  mint: string | null;
}

function createService(options: {
  bound: { tokenName: string; tokenCreatedAt: string | null }[];
  readToken: WorkerTokenRevalidationDeps["readToken"];
}): { service: WorkerTokenRevalidationService; calls: RevokeCall[] } {
  const calls: RevokeCall[] = [];
  const service = new WorkerTokenRevalidationService({
    intervalMs: 60_000,
    listBoundTokens: () => options.bound,
    readToken: options.readToken,
    revokeToken: (name, cause, { mint }) => {
      calls.push({ name, cause, mint });
      return Promise.resolve([`${name}@${mint}`]);
    },
  });
  return { service, calls };
}

Deno.test("WorkerTokenRevalidationService: keeps workers on a live, current mint", async () => {
  const { service, calls } = createService({
    bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: MINT }],
    readToken: () => Promise.resolve(tokenRecord({})),
  });
  assertEquals(await service.runOnce(), []);
  assertEquals(calls, []);
});

Deno.test("WorkerTokenRevalidationService: cuts off workers on a revoked token", async () => {
  const { service, calls } = createService({
    bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: MINT }],
    readToken: () => Promise.resolve(tokenRecord({ state: "revoked" })),
  });
  assertEquals(await service.runOnce(), [`ci-runner-3@${MINT}`]);
  assertEquals(calls, [{ name: "ci-runner-3", cause: "revoked", mint: MINT }]);
});

Deno.test("WorkerTokenRevalidationService: cuts off only the old mint after a re-mint", async () => {
  const newMint = "2026-01-01T00:05:00.000Z";
  const { service, calls } = createService({
    bound: [
      { tokenName: "ci-runner-3", tokenCreatedAt: MINT },
      { tokenName: "ci-runner-3", tokenCreatedAt: newMint },
    ],
    readToken: () =>
      Promise.resolve(tokenRecord({ state: "unused", createdAt: newMint })),
  });
  await service.runOnce();
  assertEquals(calls, [{ name: "ci-runner-3", cause: "reminted", mint: MINT }]);
});

Deno.test("WorkerTokenRevalidationService: cuts off workers whose token record is gone or unreadable", async () => {
  const { service, calls } = createService({
    bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: null }],
    readToken: () => Promise.resolve(null),
  });
  await service.runOnce();
  assertEquals(calls, [{ name: "ci-runner-3", cause: "deleted", mint: null }]);
});

Deno.test("WorkerTokenRevalidationService: a read failure keeps the workers until the next pass", async () => {
  let reads = 0;
  const { service, calls } = createService({
    bound: [
      { tokenName: "flaky", tokenCreatedAt: MINT },
      { tokenName: "ci-runner-3", tokenCreatedAt: MINT },
    ],
    readToken: (name) => {
      reads++;
      return name === "flaky"
        ? Promise.reject(new Error("datastore offline"))
        : Promise.resolve(tokenRecord({ state: "revoked" }));
    },
  });
  await service.runOnce();
  assertEquals(reads, 2);
  assertEquals(calls, [{ name: "ci-runner-3", cause: "revoked", mint: MINT }]);
});

Deno.test("WorkerTokenRevalidationService: reads each token once for a whole fleet", async () => {
  let reads = 0;
  const { service } = createService({
    bound: [
      { tokenName: "fleet", tokenCreatedAt: MINT },
      { tokenName: "fleet", tokenCreatedAt: null },
    ],
    readToken: () => {
      reads++;
      return Promise.resolve(tokenRecord({ name: "fleet" }));
    },
  });
  await service.runOnce();
  assertEquals(reads, 1);
});

Deno.test("WorkerTokenRevalidationService: dispose stops further passes", async () => {
  let reads = 0;
  const { service } = createService({
    bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: MINT }],
    readToken: () => {
      reads++;
      return Promise.resolve(tokenRecord({}));
    },
  });
  service.start();
  await service.dispose();
  // After dispose, a pass exits before reading any token.
  assertEquals(await service.runOnce(), []);
  assertEquals(reads, 0);
});
