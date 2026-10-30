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

import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import {
  checkOfflineCommit,
  decideOfflineWork,
  OFFLINE_CONFIG_EDIT_CODE,
  OFFLINE_LEASE_REQUIRED_CODE,
  OfflineConfigEditError,
  type OfflineContext,
  OfflineLeaseRequiredError,
} from "./offline_write_policy.ts";
import { partitionOf } from "./partition_key.ts";
import { WRITER_LEASE_CLOCK_SKEW_MS } from "./writer_lease.ts";
import { ModelType } from "../models/model_type.ts";

const TYPE = ModelType.create("@swamp/aws-ec2");
const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const MODEL = { type: TYPE.normalized, id: ID };
const NOW = Date.parse("2026-10-30T10:00:00.000Z");
const HOUR = 3_600_000;

function context(
  expiresIn: number,
  overrides: Partial<OfflineContext> = {},
): OfflineContext {
  return {
    heldLeases: [{
      model: MODEL,
      expiresAt: new Date(NOW + expiresIn).toISOString(),
    }],
    now: NOW,
    ...overrides,
  };
}

function method(methodKind: "read" | "list" | "update" | undefined) {
  return {
    kind: "method" as const,
    model: MODEL,
    behaviorName: "web",
    method: "apply",
    methodKind,
  };
}

Deno.test("decideOfflineWork: reads and read or list methods run without a lease", () => {
  const none: OfflineContext = { heldLeases: [], now: NOW };
  assertEquals(decideOfflineWork({ kind: "read" }, none), { allowed: true });
  assertEquals(decideOfflineWork(method("read"), none), { allowed: true });
  assertEquals(decideOfflineWork(method("list"), none), { allowed: true });
});

Deno.test("decideOfflineWork: a changing method, or one of no kind, needs a live lease", () => {
  for (const kind of ["update", undefined] as const) {
    const refused = decideOfflineWork(method(kind), {
      heldLeases: [],
      now: NOW,
    });
    assert(!refused.allowed);
    assertInstanceOf(refused.error, OfflineLeaseRequiredError);
    assertEquals(refused.error.code, OFFLINE_LEASE_REQUIRED_CODE);
    assert(refused.error.message.includes("swamp behavior lease acquire web"));
    const allowed = decideOfflineWork(method(kind), context(2 * HOUR));
    assert(allowed.allowed);
    assertEquals(allowed.lease?.model, MODEL);
  }
});

Deno.test("decideOfflineWork: a lease on another behavior does not count", () => {
  const refused = decideOfflineWork(method("update"), {
    heldLeases: [{
      model: { type: TYPE.normalized, id: OTHER_ID },
      expiresAt: new Date(NOW + HOUR).toISOString(),
    }],
    now: NOW,
  });
  assertEquals(refused.allowed, false);
});

Deno.test("decideOfflineWork: a lease within the skew of its end, or past it, is not live", () => {
  assertEquals(
    decideOfflineWork(method("update"), context(WRITER_LEASE_CLOCK_SKEW_MS))
      .allowed,
    false,
  );
  assertEquals(
    decideOfflineWork(method("update"), context(WRITER_LEASE_CLOCK_SKEW_MS + 1))
      .allowed,
    true,
  );
  assertEquals(
    decideOfflineWork(method("update"), context(-HOUR)).allowed,
    false,
  );
});

Deno.test("decideOfflineWork: serve's clock decides, through the recorded offset", () => {
  // Serve runs 30 minutes ahead: a lease ending in 20 minutes by its clock
  // has already ended.
  assertEquals(
    decideOfflineWork(
      method("update"),
      context(20 * 60_000, { clockOffsetMs: 30 * 60_000 }),
    ).allowed,
    false,
  );
  assertEquals(
    decideOfflineWork(
      method("update"),
      context(20 * 60_000, { clockOffsetMs: -30 * 60_000 }),
    ).allowed,
    true,
  );
});

Deno.test("decideOfflineWork: a definition edit is refused", () => {
  const refused = decideOfflineWork(
    { kind: "config-edit", what: "workflow deploy" },
    context(HOUR),
  );
  assert(!refused.allowed);
  assertInstanceOf(refused.error, OfflineConfigEditError);
  assertEquals(refused.error.code, OFFLINE_CONFIG_EDIT_CODE);
});

Deno.test("checkOfflineCommit: runs and auto-definitions queue, definitions never", () => {
  const ctx = { heldLeases: [], now: NOW, registered: new Set<string>() };
  assert(
    checkOfflineCommit(
      partitionOf({
        kind: "run",
        workflowId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
        runId: OTHER_ID,
      }),
      ctx,
    ),
  );
  assert(checkOfflineCommit(partitionOf({ kind: "definition", id: ID }), ctx));
  assert(
    !checkOfflineCommit(
      partitionOf({
        kind: "config",
        definitionKind: "workflow",
        name: "deploy",
      }),
      ctx,
    ),
  );
  assert(!checkOfflineCommit(partitionOf({ kind: "lockfile" }), ctx));
});

Deno.test("checkOfflineCommit: a behavior queues under a live lease or a registration", () => {
  const partition = partitionOf({ kind: "model", type: TYPE, id: ID });
  const none = { heldLeases: [], now: NOW, registered: new Set<string>() };
  assert(!checkOfflineCommit(partition, none));
  assert(
    checkOfflineCommit(partition, {
      ...none,
      registered: new Set([partition.toString()]),
    }),
  );
  assert(
    checkOfflineCommit(partition, { ...context(HOUR), registered: new Set() }),
  );
  assert(
    !checkOfflineCommit(partition, {
      ...context(-HOUR),
      registered: new Set(),
    }),
  );
});
