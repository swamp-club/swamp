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
import { createRetentionHealthProvider } from "./retention_health.ts";
import type {
  RetentionWatermark,
  RetentionWatermarkRepository,
} from "../domain/retention/retention_watermark.ts";

const WATERMARK: RetentionWatermark = {
  kind: "data",
  cutoff: "2026-09-15T00:00:00.000Z",
  retention: "30d",
  lastPassAt: "2026-10-15T00:00:00.000Z",
  complete: false,
  deleted: 4,
  bytesReclaimed: 100,
};

function watermarkRepo(
  getAll: () => Promise<RetentionWatermark[]>,
): RetentionWatermarkRepository {
  return {
    get: () => Promise.resolve(null),
    getAll,
    put: () => Promise.resolve(),
    claimHourlyPass: () => Promise.resolve(true),
  };
}

Deno.test("createRetentionHealthProvider: reports each kind's retention and last pass", async () => {
  const provider = createRetentionHealthProvider({
    readConfig: () =>
      Promise.resolve({
        retention: "30d",
        automatic: true,
        data: "30d",
        audit: "7d",
      }),
    watermarks: watermarkRepo(() => Promise.resolve([WATERMARK])),
  });
  const retention = await provider.retention();
  assertEquals(retention?.automatic, true);
  assertEquals(retention?.configured, true);
  const data = retention?.kinds.find((k) => k.kind === "data");
  assertEquals(data, {
    kind: "data",
    retention: "30d",
    cutoff: WATERMARK.cutoff,
    lastPassAt: WATERMARK.lastPassAt,
    complete: false,
  });
  const audit = retention?.kinds.find((k) => k.kind === "audit");
  assertEquals(audit, {
    kind: "audit",
    retention: "7d",
    cutoff: null,
    lastPassAt: null,
    complete: null,
  });
});

Deno.test("createRetentionHealthProvider: reports not configured without a garbageCollection block", async () => {
  const provider = createRetentionHealthProvider({
    readConfig: () => Promise.resolve(undefined),
  });
  const retention = await provider.retention();
  assertEquals(retention?.configured, false);
  assertEquals(retention?.automatic, false);
  assertEquals(retention?.kinds.every((k) => k.retention === null), true);
});

Deno.test("createRetentionHealthProvider: reads once per ttl and again after it", async () => {
  let reads = 0;
  let clock = 0;
  const provider = createRetentionHealthProvider({
    readConfig: () => Promise.resolve({ retention: "30d" }),
    watermarks: watermarkRepo(() => {
      reads++;
      return Promise.resolve([WATERMARK]);
    }),
    ttlMs: 60_000,
    now: () => clock,
  });
  await Promise.all([provider.retention(), provider.retention()]);
  clock = 59_999;
  await provider.retention();
  assertEquals(reads, 1);
  clock = 60_000;
  await provider.retention();
  assertEquals(reads, 2);
});

Deno.test("createRetentionHealthProvider: does not keep a failed read", async () => {
  let fail = true;
  let reads = 0;
  const provider = createRetentionHealthProvider({
    readConfig: () => Promise.resolve({ retention: "30d" }),
    watermarks: watermarkRepo(() => {
      reads++;
      return fail
        ? Promise.reject(new Error("unreachable"))
        : Promise.resolve([WATERMARK]);
    }),
    now: () => 0,
  });
  await assertRejects(() => provider.retention());
  fail = false;
  const retention = await provider.retention();
  assertEquals(reads, 2);
  assertEquals(
    retention?.kinds.find((k) => k.kind === "data")?.lastPassAt,
    WATERMARK.lastPassAt,
  );
});
