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

import { AsyncLocalStorage } from "node:async_hooks";
import { assert, assertEquals } from "@std/assert";
import { type Span, trace } from "@opentelemetry/api";
import { waitFor } from "@swamp-club/swamp-testing";
import type {
  EnrollmentBindingCutoffCause,
  EnrollmentToken,
} from "../domain/models/worker/enrollment_token_model.ts";
import {
  DEFAULT_WORKER_TOKEN_REVALIDATION_MS,
  type WorkerTokenRevalidationDeps,
  WorkerTokenRevalidationService,
} from "./worker_token_revalidation_service.ts";
import { DEFAULT_ROTATION_DELIVERY_TIMEOUT_MS } from "./worker_gateway.ts";
import { ROTATION_HEADROOM_MS } from "../domain/models/worker/enrollment_token_model.ts";
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
  deliverRotation?: WorkerTokenRevalidationDeps["deliverRotation"];
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
    ...(options.deliverRotation
      ? { deliverRotation: options.deliverRotation }
      : {}),
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

Deno.test("WorkerTokenRevalidationService: a rotation keeps workers on the predecessor and the successor", async () => {
  const rotatedMint = "2026-01-01T00:05:00.000Z";
  const { service, calls } = createService({
    bound: [
      { tokenName: "ci-runner-3", tokenCreatedAt: MINT },
      { tokenName: "ci-runner-3", tokenCreatedAt: rotatedMint },
    ],
    readTokens: () =>
      Promise.resolve(tokens(tokenRecord({
        createdAt: rotatedMint,
        secretKey: "worker-rotated-token-ci-runner-3-1767225900000",
        predecessor: {
          createdAt: MINT,
          expiresAt: "2099-01-01T00:00:00.000Z",
          secretKey: "worker-token-ci-runner-3",
        },
      }))),
  });
  assertEquals(await service.runOnce(), []);
  assertEquals(calls, []);
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
  await service.runOnce();
  present = true;
  await service.runOnce();
  present = false;
  await service.runOnce();
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

const OLDEST_MINT = "2025-12-01T00:00:00.000Z";
const ROTATED_MINT = "2026-01-01T00:05:00.000Z";

function rotatedRecord(
  overrides: Partial<EnrollmentToken> = {},
): EnrollmentToken {
  return tokenRecord({
    createdAt: ROTATED_MINT,
    secretKey: "worker-rotated-token-ci-runner-3-1767225900000",
    predecessor: {
      createdAt: MINT,
      expiresAt: "2099-01-01T00:00:00.000Z",
      secretKey: "worker-token-ci-runner-3",
    },
    ...overrides,
  });
}

Deno.test("WorkerTokenRevalidationService: delivers a rotation before judging, then judges the re-stamped mints", async () => {
  const bound = [
    { tokenName: "ci-runner-3", tokenCreatedAt: MINT },
    { tokenName: "ci-runner-3", tokenCreatedAt: OLDEST_MINT },
  ];
  const record = rotatedRecord();
  const events: string[] = [];
  const delivered: [string, EnrollmentToken][] = [];
  const { service, calls } = createService({
    bound,
    readTokens: () => Promise.resolve(tokens(record)),
    deliverRotation: (name, token) => {
      events.push("deliver");
      delivered.push([name, token]);
      bound[0] = { tokenName: name, tokenCreatedAt: ROTATED_MINT };
      return Promise.resolve();
    },
  });

  assertEquals(await service.runOnce(), [`ci-runner-3@${OLDEST_MINT}`]);
  assertEquals(delivered, [["ci-runner-3", record]]);
  assertEquals(events, ["deliver"]);
  assertEquals(calls, [{
    name: "ci-runner-3",
    cause: "retired",
    mint: OLDEST_MINT,
  }]);
});

Deno.test("WorkerTokenRevalidationService: delivers nothing unless a bound mint is a live predecessor", async () => {
  const cases: [string, string, EnrollmentToken][] = [
    ["no worker on the predecessor", ROTATED_MINT, rotatedRecord()],
    ["no rotation", MINT, tokenRecord({})],
    ["a revoked token", MINT, rotatedRecord({ state: "revoked" })],
    [
      "a lapsed predecessor",
      MINT,
      rotatedRecord({
        predecessor: {
          createdAt: MINT,
          expiresAt: "2026-01-02T00:00:00.000Z",
          secretKey: "worker-token-ci-runner-3",
        },
      }),
    ],
    [
      "an expired successor",
      MINT,
      rotatedRecord({ expiresAt: "2026-01-02T00:00:00.000Z" }),
    ],
  ];
  for (const [label, mint, record] of cases) {
    let deliveries = 0;
    const { service } = createService({
      bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: mint }],
      readTokens: () => Promise.resolve(tokens(record)),
      deliverRotation: () => {
        deliveries++;
        return Promise.resolve();
      },
    });
    await service.runOnce();
    assertEquals(deliveries, 0, label);
  }
});

Deno.test("WorkerTokenRevalidationService: a delivery that throws still lets the pass cut off retired workers", async () => {
  const { service, calls } = createService({
    bound: [
      { tokenName: "ci-runner-3", tokenCreatedAt: MINT },
      { tokenName: "ci-runner-3", tokenCreatedAt: OLDEST_MINT },
    ],
    readTokens: () => Promise.resolve(tokens(rotatedRecord())),
    deliverRotation: () => Promise.reject(new Error("vault offline")),
  });

  assertEquals(await service.runOnce(), [`ci-runner-3@${OLDEST_MINT}`]);
  assertEquals(calls, [{
    name: "ci-runner-3",
    cause: "retired",
    mint: OLDEST_MINT,
  }]);
});

Deno.test("WorkerTokenRevalidationService: delivers every token's rotation together, before any verdict", async () => {
  const other = "gpu-runner";
  const bound = [
    { tokenName: "ci-runner-3", tokenCreatedAt: MINT },
    { tokenName: other, tokenCreatedAt: MINT },
    { tokenName: "revoked-runner", tokenCreatedAt: MINT },
  ];
  const started = new Set<string>();
  const bothStarted = Promise.withResolvers<void>();
  const events: string[] = [];
  const { service, calls } = createService({
    bound,
    readTokens: () =>
      Promise.resolve(tokens(
        rotatedRecord(),
        rotatedRecord({ name: other }),
        tokenRecord({ name: "revoked-runner", state: "revoked" }),
      )),
    deliverRotation: async (name) => {
      started.add(name);
      if (started.size === 2) bothStarted.resolve();
      await bothStarted.promise;
      events.push(`deliver ${name}`);
    },
  });

  assertEquals(await service.runOnce(), [`revoked-runner@${MINT}`]);
  assertEquals(
    events.sort(),
    [`deliver ${other}`, "deliver ci-runner-3"].sort(),
  );
  assertEquals(calls, [{
    name: "revoked-runner",
    cause: "revoked",
    mint: MINT,
  }]);
});

Deno.test("WorkerTokenRevalidationService: a nudge runs a pass without waiting for the interval", async () => {
  let passes = 0;
  const service = new WorkerTokenRevalidationService({
    intervalMs: 60_000,
    listBoundTokens: () => {
      passes++;
      return [];
    },
    readTokens: () => Promise.resolve(tokens()),
    revokeToken: () => Promise.resolve([]),
  });
  service.nudge();
  assertEquals(passes, 0);
  service.start();
  try {
    service.nudge();
    await waitFor(() => passes === 1, "the nudged pass");
  } finally {
    await service.dispose();
  }
});

Deno.test("WorkerTokenRevalidationService: nudges during a pass coalesce into one more pass", async () => {
  let passes = 0;
  const release = Promise.withResolvers<void>();
  const { service } = createService({
    bound: [{ tokenName: "ci-runner-3", tokenCreatedAt: MINT }],
    readTokens: async () => {
      passes++;
      if (passes === 1) await release.promise;
      return tokens(tokenRecord({}));
    },
  });
  service.start();
  try {
    service.nudge();
    await waitFor(() => passes === 1, "the first pass to start");
    service.nudge();
    service.nudge();
    service.nudge();
    release.resolve();
    await waitFor(() => passes === 2, "one follow-up pass");
  } finally {
    await service.dispose();
  }
  assertEquals(passes, 2);
});

Deno.test("WorkerTokenRevalidationService: a nudged pass never runs in the nudging caller's async context", async () => {
  const caller = new AsyncLocalStorage<string>();
  const seen: (string | undefined)[] = [];
  const service = new WorkerTokenRevalidationService({
    intervalMs: 60_000,
    listBoundTokens: () => {
      seen.push(caller.getStore());
      return [];
    },
    readTokens: () => Promise.resolve(tokens()),
    revokeToken: () => Promise.resolve([]),
  });
  service.start();
  try {
    caller.run("workflow step", () => service.nudge());
    await waitFor(() => seen.length === 1, "the nudged pass");
  } finally {
    await service.dispose();
  }
  assertEquals(seen, [undefined]);
});

Deno.test("WorkerTokenRevalidationService: a delivery re-reads only the delivered token's mints, so another token's fresh enrollment is never judged against an older record", async () => {
  const freshMint = "2026-01-02T00:00:00.000Z";
  const bound = [
    { tokenName: "revoked-runner", tokenCreatedAt: MINT },
    { tokenName: "ci-runner-3", tokenCreatedAt: MINT },
  ];
  const { service, calls } = createService({
    bound,
    readTokens: () =>
      Promise.resolve(tokens(
        tokenRecord({ name: "revoked-runner", state: "revoked" }),
        rotatedRecord(),
      )),
    deliverRotation: (name) => {
      // a re-mint and enrollment land on the other token mid-delivery
      bound[0] = { tokenName: "revoked-runner", tokenCreatedAt: freshMint };
      bound[1] = { tokenName: name, tokenCreatedAt: ROTATED_MINT };
      return Promise.resolve();
    },
  });

  await service.runOnce();

  assertEquals(calls, [{
    name: "revoked-runner",
    cause: "revoked",
    mint: MINT,
  }]);
});

Deno.test("ROTATION_HEADROOM_MS: covers serve's token check interval plus its delivery timeout", () => {
  assert(
    ROTATION_HEADROOM_MS >=
      DEFAULT_WORKER_TOKEN_REVALIDATION_MS +
        DEFAULT_ROTATION_DELIVERY_TIMEOUT_MS,
  );
});
