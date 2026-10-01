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

import { assert, assertEquals } from "@std/assert";
import { type Span, trace } from "@opentelemetry/api";
import { waitFor } from "@swamp-club/swamp-testing";
import type {
  EnrollmentBindingCutoffCause,
  EnrollmentToken,
} from "../domain/models/worker/enrollment_token_model.ts";
import {
  type WorkerTokenRevalidationDeps,
  WorkerTokenRevalidationService,
} from "./worker_token_revalidation_service.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import { withCapturedSpans } from "../infrastructure/tracing/span_test_helpers.ts";

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
  mint: string;
}

function tokens(
  ...records: EnrollmentToken[]
): ReadonlyMap<string, EnrollmentToken> {
  return new Map(records.map((record) => [record.name, record]));
}

function createService(options: {
  bound: { tokenName: string; tokenCreatedAt: string }[];
  readTokens: WorkerTokenRevalidationDeps["readTokens"];
}): { service: WorkerTokenRevalidationService; calls: RevokeCall[] } {
  const calls: RevokeCall[] = [];
  const service = new WorkerTokenRevalidationService({
    intervalMs: 60_000,
    listBoundTokens: () => options.bound,
    readTokens: options.readTokens,
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
    readTokens: () => Promise.resolve(tokens(tokenRecord({}))),
  });
  assertEquals(await service.runOnce(), []);
  assertEquals(calls, []);
});

Deno.test("WorkerTokenRevalidationService: cuts off workers on a revoked token", async () => {
  const { service, calls } = createService({
    bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: MINT }],
    readTokens: () =>
      Promise.resolve(tokens(tokenRecord({ state: "revoked" }))),
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
    readTokens: () =>
      Promise.resolve(
        tokens(tokenRecord({ state: "unused", createdAt: newMint })),
      ),
  });
  await service.runOnce();
  assertEquals(calls, [{ name: "ci-runner-3", cause: "reminted", mint: MINT }]);
});

Deno.test("WorkerTokenRevalidationService: cuts off workers only when their token is missing on two passes in a row", async () => {
  const { service, calls } = createService({
    bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: MINT }],
    readTokens: () => Promise.resolve(tokens()),
  });
  assertEquals(await service.runOnce(), []);
  assertEquals(calls, []);
  await service.runOnce();
  assertEquals(calls, [{ name: "ci-runner-3", cause: "deleted", mint: MINT }]);
});

Deno.test("WorkerTokenRevalidationService: a token that reappears resets the missing count", async () => {
  let present = false;
  const { service, calls } = createService({
    bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: MINT }],
    readTokens: () =>
      Promise.resolve(present ? tokens(tokenRecord({})) : tokens()),
  });
  await service.runOnce(); // missing once
  present = true;
  await service.runOnce(); // readable again
  present = false;
  await service.runOnce(); // missing once more — not two in a row
  assertEquals(calls, []);
});

Deno.test("WorkerTokenRevalidationService: a read failure keeps every worker until the next pass", async () => {
  let fail = true;
  const { service, calls } = createService({
    bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: MINT }],
    readTokens: () =>
      fail
        ? Promise.reject(new Error("datastore offline"))
        : Promise.resolve(tokens(tokenRecord({ state: "revoked" }))),
  });
  assertEquals(await service.runOnce(), []);
  assertEquals(calls, []);
  fail = false;
  await service.runOnce();
  assertEquals(calls, [{ name: "ci-runner-3", cause: "revoked", mint: MINT }]);
});

Deno.test("WorkerTokenRevalidationService: reads the tokens once per pass for every bound token", async () => {
  let reads = 0;
  const { service } = createService({
    bound: [
      { tokenName: "fleet", tokenCreatedAt: MINT },
      { tokenName: "fleet", tokenCreatedAt: "2026-01-01T00:05:00.000Z" },
      { tokenName: "ci-runner-3", tokenCreatedAt: MINT },
    ],
    readTokens: () => {
      reads++;
      return Promise.resolve(
        tokens(tokenRecord({ name: "fleet" }), tokenRecord({})),
      );
    },
  });
  await service.runOnce();
  assertEquals(reads, 1);
});

Deno.test("WorkerTokenRevalidationService: skips the read when no worker is bound", async () => {
  let reads = 0;
  const { service } = createService({
    bound: [],
    readTokens: () => {
      reads++;
      return Promise.resolve(tokens());
    },
  });
  assertEquals(await service.runOnce(), []);
  assertEquals(reads, 0);
});

Deno.test("WorkerTokenRevalidationService: dispose stops further passes", async () => {
  let reads = 0;
  const { service } = createService({
    bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: MINT }],
    readTokens: () => {
      reads++;
      return Promise.resolve(tokens(tokenRecord({})));
    },
  });
  service.start();
  await service.dispose();
  // After dispose, a pass exits before reading any token.
  assertEquals(await service.runOnce(), []);
  assertEquals(reads, 0);
});

Deno.test("WorkerTokenRevalidationService: a tick runs with no active span when started under one", async () => {
  await withCapturedSpans(async () => {
    const seen: (Span | undefined)[] = [];
    const service = new WorkerTokenRevalidationService({
      intervalMs: 10,
      listBoundTokens: () => {
        seen.push(trace.getActiveSpan());
        return [];
      },
      readTokens: () => Promise.resolve(tokens()),
      revokeToken: () => Promise.resolve([]),
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
