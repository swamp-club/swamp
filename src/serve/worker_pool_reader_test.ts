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
import type { EnrollmentToken } from "../domain/models/worker/enrollment_token_model.ts";
import type { WorkerState } from "../domain/models/worker/worker_model.ts";
import type { WorkerSnapshot } from "./worker_gateway.ts";
import {
  createServeWorkerPoolReader,
  leftPoolTokenHolds,
  ServeWorkerPoolReader,
  type ServeWorkerPoolReaderDeps,
} from "./worker_pool_reader.ts";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const MINT = "2026-11-02T10:00:00.000Z";
const ENROLLED = "2026-11-02T10:05:00.000Z";

function token(
  overrides: Partial<EnrollmentToken> & { name: string },
): EnrollmentToken {
  return {
    state: "enrolled",
    createdAt: MINT,
    expiresAt: "2026-11-02T13:00:00.000Z",
    vaultName: "v",
    secretKey: `worker-token-${overrides.name}`,
    maxEnrollments: 1,
    bindings: [],
    ...overrides,
  };
}

function record(
  overrides: Partial<WorkerState> & { name: string },
): WorkerState {
  return {
    instanceUuid: `uuid-${overrides.name}`,
    tokenName: overrides.name,
    status: "disconnected",
    labels: { role: "web" },
    platform: "linux",
    arch: "x86_64",
    swampVersion: "test",
    protocolVersion: 1,
    enrolledAt: ENROLLED,
    lastSeenAt: ENROLLED,
    capacity: 1,
    activeDispatchIds: [],
    ...overrides,
  };
}

function live(
  overrides: Partial<WorkerSnapshot> & { name: string },
): WorkerSnapshot {
  return {
    instanceUuid: `uuid-${overrides.name}`,
    labels: { role: "web" },
    platform: "linux",
    arch: "x86_64",
    swampVersion: "test",
    protocolVersion: 1,
    status: "idle",
    connected: true,
    capacity: 1,
    activeDispatchIds: [],
    ...overrides,
  };
}

function reader(
  deps: Partial<ServeWorkerPoolReaderDeps>,
): ServeWorkerPoolReader {
  return new ServeWorkerPoolReader({
    liveWorkers: () => [],
    readTokenRecords: () => Promise.resolve(new Map()),
    readWorkerRecords: () => Promise.resolve([]),
    now: () => NOW,
    ...deps,
  });
}

Deno.test("leftPoolTokenHolds: a live token on the mint the worker enrolled on holds", () => {
  assertEquals(
    leftPoolTokenHolds(record({ name: "a" }), token({ name: "a" }), NOW),
    true,
  );
});

Deno.test("leftPoolTokenHolds: revoked, re-minted, deleted and expired tokens do not hold", () => {
  const a = record({ name: "a" });
  assertEquals(
    leftPoolTokenHolds(a, token({ name: "a", state: "revoked" }), NOW),
    false,
  );
  assertEquals(
    leftPoolTokenHolds(
      a,
      token({ name: "a", createdAt: "2026-11-02T10:06:00.000Z" }),
      NOW,
    ),
    false,
  );
  assertEquals(leftPoolTokenHolds(a, null, NOW), false);
  assertEquals(
    leftPoolTokenHolds(a, token({ name: "a", state: "expired" }), NOW),
    false,
  );
  assertEquals(
    leftPoolTokenHolds(
      a,
      token({ name: "a", expiresAt: new Date(NOW).toISOString() }),
      NOW,
    ),
    false,
  );
  assertEquals(
    leftPoolTokenHolds(
      a,
      token({ name: "a", expiresAt: new Date(NOW + 1).toISOString() }),
      NOW,
    ),
    true,
  );
});

Deno.test("leftPoolTokenHolds: a token minted the instant the worker enrolled is the same mint", () => {
  assertEquals(
    leftPoolTokenHolds(
      record({ name: "a" }),
      token({ name: "a", createdAt: ENROLLED }),
      NOW,
    ),
    true,
  );
});

Deno.test("leftPoolTokenHolds: the mint the record holds wins over a serve enrolment stamp from a clock behind the minting one", () => {
  const ahead = "2026-11-02T10:09:00.000Z";
  assertEquals(
    leftPoolTokenHolds(
      record({ name: "a", tokenCreatedAt: ahead }),
      token({ name: "a", createdAt: ahead }),
      NOW,
    ),
    true,
  );
});

Deno.test("leftPoolTokenHolds: a token newer than the record's mint is a re-mint whatever enrolledAt says", () => {
  assertEquals(
    leftPoolTokenHolds(
      record({
        name: "a",
        tokenCreatedAt: MINT,
        enrolledAt: "2026-11-02T10:30:00.000Z",
      }),
      token({ name: "a", createdAt: "2026-11-02T10:01:00.000Z" }),
      NOW,
    ),
    false,
  );
});

Deno.test("leftPoolTokenHolds: a record without tokenCreatedAt judges the mint by enrolledAt", () => {
  const legacy = record({ name: "a" });
  assertEquals(legacy.tokenCreatedAt, undefined);
  assertEquals(
    leftPoolTokenHolds(
      legacy,
      token({ name: "a", createdAt: "2026-11-02T10:04:00.000Z" }),
      NOW,
    ),
    true,
  );
  assertEquals(
    leftPoolTokenHolds(
      legacy,
      token({ name: "a", createdAt: "2026-11-02T10:06:00.000Z" }),
      NOW,
    ),
    false,
  );
});

Deno.test("ServeWorkerPoolReader: live workers are members as the gateway reports them", async () => {
  const pool = await reader({
    liveWorkers: () => [
      live({ name: "a" }),
      live({ name: "b", connected: false, status: "busy" }),
    ],
  }).readPool();
  assertEquals(pool.map((w) => [w.name, w.status, w.connected]), [[
    "a",
    "idle",
    true,
  ], ["b", "busy", false]]);
});

Deno.test("ServeWorkerPoolReader: a left-pool worker joins only while its token holds", async () => {
  const pool = await reader({
    readWorkerRecords: () =>
      Promise.resolve([
        record({ name: "kept" }),
        record({ name: "revoked" }),
        record({ name: "gone" }),
        record({ name: "expired" }),
      ]),
    readTokenRecords: () =>
      Promise.resolve(
        new Map([
          ["kept", token({ name: "kept" })],
          ["revoked", token({ name: "revoked", state: "revoked" })],
          [
            "expired",
            token({ name: "expired", expiresAt: "2026-11-02T11:00:00.000Z" }),
          ],
        ]),
      ),
  }).readPool();
  assertEquals(pool, [{
    name: "kept",
    instanceUuid: "uuid-kept",
    labels: { role: "web" },
    platform: "linux",
    arch: "x86_64",
    status: "disconnected",
    connected: false,
  }]);
});

Deno.test("ServeWorkerPoolReader: a fleet worker's token is found by its token name", async () => {
  const pool = await reader({
    readWorkerRecords: () =>
      Promise.resolve([record({ name: "fleet-1", tokenName: "fleet" })]),
    readTokenRecords: () =>
      Promise.resolve(
        new Map([[
          "fleet",
          token({ name: "fleet", maxEnrollments: "unlimited" }),
        ]]),
      ),
  }).readPool();
  assertEquals(pool.map((w) => w.name), ["fleet-1"]);
});

Deno.test("ServeWorkerPoolReader: a left-pool worker keeps an unverified or draining status, else reads disconnected", async () => {
  const pool = await reader({
    readWorkerRecords: () =>
      Promise.resolve([
        record({ name: "a", status: "idle" }),
        record({ name: "b", status: "draining" }),
        record({ name: "c", status: "unverified" }),
        record({ name: "d", status: "busy" }),
      ]),
    readTokenRecords: () =>
      Promise.resolve(
        new Map(["a", "b", "c", "d"].map((n) => [n, token({ name: n })])),
      ),
  }).readPool();
  assertEquals(pool.map((w) => [w.name, w.status, w.connected]), [
    ["a", "disconnected", false],
    ["b", "draining", false],
    ["c", "unverified", false],
    ["d", "disconnected", false],
  ]);
});

Deno.test("ServeWorkerPoolReader: the live entry wins over the worker's record, and names stay unique", async () => {
  let tokenReads = 0;
  const pool = await reader({
    liveWorkers: () => [live({ name: "a", instanceUuid: "live-uuid" })],
    readWorkerRecords: () =>
      Promise.resolve([
        record({ name: "a" }),
        record({ name: "b" }),
        record({ name: "b", instanceUuid: "dup" }),
      ]),
    readTokenRecords: () => {
      tokenReads++;
      return Promise.resolve(
        new Map([["a", token({ name: "a" })], ["b", token({ name: "b" })]]),
      );
    },
  }).readPool();
  assertEquals(pool.map((w) => [w.name, w.instanceUuid]), [["a", "live-uuid"], [
    "b",
    "uuid-b",
  ]]);
  assertEquals(tokenReads, 1);
});

Deno.test("ServeWorkerPoolReader: skips the token read when every record is live", async () => {
  let tokenReads = 0;
  await reader({
    liveWorkers: () => [live({ name: "a" })],
    readWorkerRecords: () => Promise.resolve([record({ name: "a" })]),
    readTokenRecords: () => {
      tokenReads++;
      return Promise.resolve(new Map());
    },
  }).readPool();
  assertEquals(tokenReads, 0);
});

Deno.test("ServeWorkerPoolReader: a token read failure fails the read instead of returning a partial pool", async () => {
  await assertRejects(
    () =>
      reader({
        readWorkerRecords: () => Promise.resolve([record({ name: "a" })]),
        readTokenRecords: () =>
          Promise.reject(new Error("datastore unavailable")),
      }).readPool(),
    Error,
    "datastore unavailable",
  );
});

Deno.test("createServeWorkerPoolReader: lists worker records in this namespace only and skips records that do not parse", async () => {
  const predicates: string[] = [];
  const pool = await createServeWorkerPoolReader({
    gateway: {
      workers: () => [],
      readTokenRecords: () =>
        Promise.resolve(new Map([["a", token({ name: "a" })]])),
    },
    query: (predicate) => {
      predicates.push(predicate);
      return Promise.resolve([{ attributes: record({ name: "a" }) }, {
        attributes: { name: "broken" },
      }]);
    },
    namespace: "team-a",
    now: () => NOW,
  }).readPool();
  assertEquals(pool.map((w) => w.name), ["a"]);
  assertEquals(predicates, [
    'modelType == "swamp/worker" && name == "state-main" && ns == "team-a"',
  ]);
});

Deno.test("ServeWorkerPoolReader: carries serve's queue timeout, and none when serve gave none", () => {
  assertEquals(reader({ queueTimeoutMs: 600_000 }).queueTimeoutMs, 600_000);
  assertEquals(reader({}).queueTimeoutMs, undefined);
  assertEquals(
    createServeWorkerPoolReader({
      gateway: {
        workers: () => [],
        readTokenRecords: () => Promise.resolve(new Map()),
      },
      query: () => Promise.resolve([]),
      namespace: "team-a",
      queueTimeoutMs: 0,
    }).queueTimeoutMs,
    0,
  );
});
