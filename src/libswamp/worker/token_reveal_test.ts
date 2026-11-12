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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import {
  workerTokenReveal,
  type WorkerTokenRevealDeps,
  type WorkerTokenRevealEvent,
} from "./token_reveal.ts";

function tokenRecord(overrides: Record<string, unknown>): DataRecord {
  return {
    attributes: {
      name: "web-01",
      state: "enrolled",
      createdAt: "2026-02-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      vaultName: "local",
      secretKey: "worker-rotated-token-web-01-1769904000000",
      maxEnrollments: 1,
      bindings: [],
      ...overrides,
    },
  } as unknown as DataRecord;
}

function deps(
  records: DataRecord[],
  reads: string[] = [],
): WorkerTokenRevealDeps {
  return {
    query: () => Promise.resolve(records),
    readSecret: (vaultName, secretKey) => {
      reads.push(`${vaultName}/${secretKey}`);
      return Promise.resolve("curr3nt");
    },
  };
}

async function reveal(d: WorkerTokenRevealDeps, name = "web-01") {
  return await collect<WorkerTokenRevealEvent>(
    workerTokenReveal(createLibSwampContext(), d, name),
  );
}

Deno.test("workerTokenReveal: reads the current secret the record names", async () => {
  const reads: string[] = [];
  const events = await reveal(deps([tokenRecord({})], reads));
  assertEquals(reads, ["local/worker-rotated-token-web-01-1769904000000"]);
  assertEquals(events.at(-1), {
    kind: "completed",
    data: {
      name: "web-01",
      token: "web-01.curr3nt",
      expiresAt: "2099-01-01T00:00:00.000Z",
      expired: false,
    },
  });
});

Deno.test("workerTokenReveal: the newest mint wins when a name was re-minted", async () => {
  const reads: string[] = [];
  await reveal(
    deps([
      tokenRecord({
        createdAt: "2026-01-01T00:00:00.000Z",
        secretKey: "worker-token-web-01",
      }),
      tokenRecord({}),
    ], reads),
  );
  assertEquals(reads, ["local/worker-rotated-token-web-01-1769904000000"]);
});

Deno.test("workerTokenReveal: an expired token is revealed with a flag", async () => {
  const events = await reveal(
    deps([tokenRecord({ expiresAt: "2020-01-01T00:00:00.000Z" })]),
  );
  const completed = events.at(-1) as Extract<
    WorkerTokenRevealEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.expired, true);
});

Deno.test("workerTokenReveal: refuses a revoked or unknown token without reading the vault", async () => {
  const reads: string[] = [];
  const revoked = await reveal(
    deps([tokenRecord({ state: "revoked" })], reads),
  );
  const unknown = await reveal(deps([], reads), "ghost");
  assertEquals(
    (revoked.at(-1) as Extract<WorkerTokenRevealEvent, { kind: "error" }>)
      .error.code,
    "token_revoked",
  );
  const missing = unknown.at(-1) as Extract<
    WorkerTokenRevealEvent,
    { kind: "error" }
  >;
  assertEquals(missing.error.code, "token_not_found");
  assertStringIncludes(missing.error.message, "swamp worker token list");
  assertEquals(reads, []);
});
