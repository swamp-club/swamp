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
import { assertCompletes, collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createDatastoreStatusDeps,
  datastoreStatus,
  type DatastoreStatusDeps,
  type DatastoreStatusEvent,
  outboxEntryStatusesOf,
  quarantineStatusOf,
} from "./status.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { Commit } from "../../domain/datastore_v3/commit.ts";
import { opFromJSON } from "../../domain/datastore_v3/op.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";

function makeDeps(
  overrides: Partial<DatastoreStatusDeps> = {},
): DatastoreStatusDeps {
  const defaultConfig: DatastoreConfig = {
    type: "filesystem",
    path: "/tmp/swamp-data",
  };
  return {
    loadConfig: () => defaultConfig,
    verifyHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 5 }),
    getDirectories: () => ["data", "outputs", "workflow-runs"],
    ...overrides,
  };
}

Deno.test("datastoreStatus: healthy filesystem datastore", async () => {
  const deps = makeDeps();

  await assertCompletes<DatastoreStatusEvent>(
    datastoreStatus(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: {
        type: "filesystem",
        path: "/tmp/swamp-data",
        healthy: true,
        message: "OK",
        latencyMs: 5,
        directories: ["data", "outputs", "workflow-runs"],
        exclude: undefined,
      },
    },
  );
});

Deno.test("datastoreStatus: unhealthy datastore", async () => {
  const deps = makeDeps({
    verifyHealth: () =>
      Promise.resolve({
        healthy: false,
        message: "Connection refused",
        latencyMs: 0,
      }),
  });

  await assertCompletes<DatastoreStatusEvent>(
    datastoreStatus(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: {
        type: "filesystem",
        path: "/tmp/swamp-data",
        healthy: false,
        message: "Connection refused",
        latencyMs: 0,
        directories: ["data", "outputs", "workflow-runs"],
        exclude: undefined,
      },
    },
  );
});

Deno.test("datastoreStatus: includes exclude patterns", async () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/tmp/swamp-data",
    exclude: ["*.log", "temp/"],
  };
  const deps = makeDeps({
    loadConfig: () => config,
  });

  await assertCompletes<DatastoreStatusEvent>(
    datastoreStatus(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: {
        type: "filesystem",
        path: "/tmp/swamp-data",
        healthy: true,
        message: "OK",
        latencyMs: 5,
        directories: ["data", "outputs", "workflow-runs"],
        exclude: ["*.log", "temp/"],
      },
    },
  );
});

Deno.test("datastoreStatus: a v3 datastore reports its format and commit log", async () => {
  const deps = makeDeps({
    describeCommitLog: () =>
      Promise.resolve({ storedCommits: 7, compactedThrough: 2 }),
  });
  const events = await collect<DatastoreStatusEvent>(
    datastoreStatus(createLibSwampContext(), deps),
  );
  const completed = events[0] as Extract<
    DatastoreStatusEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.format, 3);
  assertEquals(completed.data.commitLog, {
    storedCommits: 7,
    compactedThrough: 2,
  });
});

Deno.test("datastoreStatus: serve's status lists the explicit leases it holds, and a local one lists none (swamp-club#4195)", async () => {
  const lease = {
    lockKey: "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock",
    holder: "user:alice",
    expiresAt: "2026-10-31T12:00:00.000Z",
  };
  const served = await collect<DatastoreStatusEvent>(
    datastoreStatus(
      createLibSwampContext(),
      makeDeps({ listExplicitLeases: () => [lease] }),
    ),
  );
  assertEquals(
    (served[0] as Extract<DatastoreStatusEvent, { kind: "completed" }>).data
      .explicitLeases,
    [lease],
  );
  const local = await collect<DatastoreStatusEvent>(
    datastoreStatus(createLibSwampContext(), makeDeps()),
  );
  assertEquals(
    (local[0] as Extract<DatastoreStatusEvent, { kind: "completed" }>).data
      .explicitLeases,
    undefined,
  );
});

Deno.test("datastoreStatus: a v2 datastore reports no format or commit log", async () => {
  const events = await collect<DatastoreStatusEvent>(
    datastoreStatus(createLibSwampContext(), makeDeps()),
  );
  const completed = events[0] as Extract<
    DatastoreStatusEvent,
    { kind: "completed" }
  >;
  assertEquals("format" in completed.data, false);
  assertEquals("commitLog" in completed.data, false);
});

Deno.test("datastoreStatus: lists this checkout's kept outbox entries, and none when it holds none (swamp-club#4195)", async () => {
  const entry = {
    state: "quarantined" as const,
    partition: "model--aws%2Fec2--web",
    txnId: "11111111-1111-4111-8111-111111111111",
    reason: "Not authorized",
    savedAt: "2026-10-30T12:00:00.000Z",
  };
  const [listed] = await collect(
    datastoreStatus(
      createLibSwampContext(),
      makeDeps({ listOutboxEntries: () => Promise.resolve([entry]) }),
    ),
  );
  assertEquals(
    listed.kind === "completed" ? listed.data.outbox : undefined,
    [entry],
  );
  const [empty] = await collect(
    datastoreStatus(
      createLibSwampContext(),
      makeDeps({ listOutboxEntries: () => Promise.resolve([]) }),
    ),
  );
  assertEquals(
    empty.kind === "completed" ? "outbox" in empty.data : true,
    false,
  );
});

Deno.test("datastoreStatus: lists serve's quarantined changes and says when accepted ones were left out (swamp-club#4195)", async () => {
  const change = {
    txnId: "22222222-2222-4222-8222-222222222222",
    partition: "model--aws%2Fec2--web",
    author: "user:bob",
    reason: "Not authorized",
    depositedAt: "2026-10-30T12:00:00.000Z",
    state: "held" as const,
  };
  const [event] = await collect(
    datastoreStatus(
      createLibSwampContext(),
      makeDeps({
        listQuarantine: () =>
          Promise.resolve({ entries: [change], truncated: true }),
      }),
    ),
  );
  assertEquals(event.kind, "completed");
  if (event.kind === "completed") {
    assertEquals(event.data.quarantine, [change]);
    assertEquals(event.data.quarantineTruncated, true);
  }
});

Deno.test("outboxEntryStatusesOf: lists kept entries only, and quarantineStatusOf names the author (swamp-club#4195)", async () => {
  const type = ModelType.create("aws/ec2");
  const id = "2e27d62d-4a9e-4f4d-9ce3-c0822f353578";
  const commit = Commit.create({
    seq: 1,
    partition: partitionOf({ kind: "model", type, id }),
    namespace: "",
    txnId: "33333333-3333-4333-8333-333333333333",
    writer: { host: "h", pid: 1, instance: "i" },
    at: "2026-10-30T12:00:00.000Z",
    ops: [
      await opFromJSON({
        kind: "put",
        intent: {
          kind: "data.save",
          model: { type: type.normalized, id },
          name: "vpc",
          version: 1,
        },
        key: `data/${type.normalized}/${id}/vpc/1/raw`,
        inline: btoa("{}"),
      }),
    ],
  });
  const entry = (state?: "offline") => ({
    commit,
    unitId: "u",
    base: { seq: 0, txnId: undefined },
    sequence: 1,
    createdAt: Date.parse("2026-10-30T12:00:00.000Z"),
    ...(state === undefined ? {} : { state }),
  });
  assertEquals(outboxEntryStatusesOf([entry(), entry("offline")]), [{
    state: "offline",
    partition: commit.partition.toString(),
    txnId: commit.txnId,
    savedAt: "2026-10-30T12:00:00.000Z",
  }]);
  assertEquals(
    quarantineStatusOf({
      txnId: commit.txnId,
      partition: "p",
      principal: "user:bob",
      reason: "r",
      depositedAt: "d",
      bytes: 1,
      state: "accepted",
      acceptedBy: "user:admin",
      seq: 2,
    }),
    {
      txnId: commit.txnId,
      partition: "p",
      author: "user:bob",
      reason: "r",
      depositedAt: "d",
      state: "accepted",
      acceptedBy: "user:admin",
      seq: 2,
    },
  );
});

Deno.test("datastoreStatus: a serve-mode checkout lists the leases it holds and serve's section when serve answers (swamp-club#4195)", async () => {
  const held = {
    lockKey: "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock",
    fence: 3,
    expiresAt: "2026-10-31T12:00:00.000Z",
  };
  const lease = {
    lockKey: held.lockKey,
    holder: "user:alice",
    expiresAt: held.expiresAt,
  };
  const events = await collect<DatastoreStatusEvent>(
    datastoreStatus(
      createLibSwampContext(),
      makeDeps({
        listHeldLeases: () => Promise.resolve([held]),
        serveSection: () =>
          Promise.resolve({
            kind: "shown",
            explicitLeases: [lease],
            quarantine: [],
          }),
      }),
    ),
  );
  const done = events.find((e) => e.kind === "completed");
  const data = done?.kind === "completed" ? done.data : undefined;
  assertEquals(data?.heldLeases, [held]);
  assertEquals(data?.explicitLeases, [lease]);
  assertEquals(data?.quarantine, []);
  assertEquals(data?.serveSectionAbsent, undefined);
});

Deno.test("datastoreStatus: serve's section missing says why and never fails the checkout's status (swamp-club#4195)", async () => {
  const events = await collect<DatastoreStatusEvent>(
    datastoreStatus(
      createLibSwampContext(),
      makeDeps({
        listHeldLeases: () => Promise.resolve([]),
        serveSection: () =>
          Promise.resolve({ kind: "absent", reason: "serve is unreachable" }),
      }),
    ),
  );
  const done = events.find((e) => e.kind === "completed");
  const data = done?.kind === "completed" ? done.data : undefined;
  assertEquals(data?.serveSectionAbsent, "serve is unreachable");
  assertEquals(data?.explicitLeases, undefined);
  assertEquals(data?.heldLeases, []);
});

Deno.test("createDatastoreStatusDeps: a serve-mode checkout describes its own copy, not the storage its config names (swamp-club#4195)", async () => {
  const named: DatastoreConfig = { type: "filesystem", path: "/tmp/ds-unused" };
  const copy: DatastoreConfig = { type: "filesystem", path: "/tmp/the-copy" };
  const resolver = new DefaultDatastorePathResolver("/tmp/repo", named);
  const withCopy = await createDatastoreStatusDeps(resolver, { config: copy });
  assertEquals(withCopy.loadConfig(), copy);
  const without = await createDatastoreStatusDeps(resolver);
  assertEquals(without.loadConfig(), named);
});
