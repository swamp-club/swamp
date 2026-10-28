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

/**
 * Serve's `GET base` (swamp-club#4006) over a real compacted v3 repository:
 * what a caller is sent of the compacted base is what it may read, decided
 * per record, never more than the changes feed decides the op that wrote
 * it.
 */

import { assert, assertEquals } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { SERVE_DATASTORE_LOG_HEADER } from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { grant } from "./serve_request_harness.ts";
import {
  commitBody,
  dataMetadata,
  getJson,
  partitionPath,
  post,
  type Server,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

const SECRET_ID =
  "5b0c7a1e-2f3d-4c5b-8a6e-9d0f1e2a3b4c" as Server["model"]["id"];
const STAMP = "2026-01-01T00-00-00-000Z";

/** Bob may read web's data, and nothing else: not its outputs. */
const bobReadsWebData = (): Grant[] => [
  grant({
    subject: { kind: "user", name: "bob" },
    actions: ["read"],
    resource: { kind: "data", pattern: "web" },
  }),
];

/** A data save of `name` version `version`, its content inline. */
function saveOps(
  server: Server,
  name: string,
  version: number,
  modelId = server.model.id,
): unknown[] {
  const type = server.modelType.normalized;
  const base = `data/${type}/${modelId}/${name}/${version}`;
  const intent = {
    kind: "data.save",
    model: { type, id: modelId },
    name,
    version,
  };
  const metadata = dataMetadata(name, version);
  return [
    {
      kind: "put",
      intent,
      key: `${base}/raw`,
      inline: btoa(`${name}@${version}`),
    },
    {
      kind: "put",
      intent,
      key: `${base}/metadata.yaml`,
      inline: btoa(stringifyYaml(metadata)),
    },
    { kind: "data-version", key: `${base}/metadata.yaml`, metadata },
  ];
}

/** An output of the behavior, which reading needs read on the behavior. */
function outputOp(server: Server): unknown {
  const type = server.modelType.normalized;
  return {
    kind: "put",
    intent: {
      kind: "output.save",
      model: { type, id: server.model.id },
      outputId: "o",
    },
    key: `outputs/${type}/create/${server.model.id}-${STAMP}.yaml`,
    inline: btoa("output: 1\n"),
  };
}

async function commit(
  server: Server,
  ops: unknown[],
  modelId = server.model.id,
): Promise<void> {
  const path = partitionPath(server, modelId);
  const head = await getJson(`${path}?after=0`, "alice-token");
  const committed = await post(
    path,
    "alice-token",
    commitBody({
      expectedSeq: head.json.head ?? 0,
      txnId: crypto.randomUUID(),
      ops,
    }),
  );
  assertEquals(committed.status, 200, JSON.stringify(committed.json));
}

/** Compacts serve's whole log. */
async function compactAll(server: Server): Promise<number> {
  const store = server.v3.commitStore;
  const fence = store.writerFence();
  const report = await store.compactHistory(store.highWaterMark().cursor, {
    ...(fence !== undefined ? { fence } : {}),
  });
  return report.point;
}

/** Every page of the base `token` is sent, at `limit` entries a page. */
async function readBase(
  server: Server,
  token: string,
  limit?: number,
): Promise<
  { point: number; entries: Record<string, unknown>[]; pages: number }
> {
  const entries: Record<string, unknown>[] = [];
  let after: string | undefined;
  let point = 0;
  let pages = 0;
  do {
    const query = new URLSearchParams();
    if (after !== undefined) query.set("after", after);
    if (limit !== undefined) query.set("limit", String(limit));
    const page = await getJson(`${server.url}/base?${query}`, token);
    assertEquals(page.status, 200, JSON.stringify(page.json));
    point = page.json.point as number;
    entries.push(...page.json.entries as Record<string, unknown>[]);
    after = page.json.next as string | undefined;
    pages++;
  } while (after !== undefined);
  return { point, entries, pages };
}

function partitionOfEntry(entry: Record<string, unknown>): string {
  return (entry.kind === "file" ? entry.owner : entry.partition) as string;
}

Deno.test({
  name:
    "datastore base: a caller is sent only the compacted records it may read, never another behavior's",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReadsWebData()], async (server) => {
      await commit(server, saveOps(server, "vpc", 1));
      // One commit holding web's data and its output: the feed hides it
      // from bob whole, for the output.
      await commit(server, [...saveOps(server, "net", 1), outputOp(server)]);
      await commit(server, saveOps(server, "key", 1, SECRET_ID), SECRET_ID);
      const point = await compactAll(server);
      assert(point > 0);

      const web = partitionOf({
        kind: "model",
        type: server.modelType,
        id: server.model.id,
      }).toString();
      const secret = partitionOf({
        kind: "model",
        type: server.modelType,
        id: SECRET_ID,
      }).toString();

      const admin = await readBase(server, "alice-token");
      assertEquals(admin.point, point);
      const adminPartitions = new Set(admin.entries.map(partitionOfEntry));
      assert(adminPartitions.has(web) && adminPartitions.has(secret));
      assert(
        admin.entries.some((e) =>
          e.kind === "record" && String(e.key).startsWith("outputs/")
        ),
      );

      const bob = await readBase(server, "bob-token");
      assertEquals(bob.point, point);
      // Nothing of the behavior bob may not read reaches him.
      assertEquals(
        bob.entries.filter((e) => partitionOfEntry(e) === secret),
        [],
      );
      // Web's partition reaches him once, before its first record, with its
      // data names' marks: he may read its data, not the whole partition.
      const partitions = bob.entries.filter((e) => e.kind === "partition");
      assertEquals(partitions.map((e) => e.partition), [web]);
      assertEquals(bob.entries[0].kind, "partition");
      assertEquals(
        (partitions[0].names as { name: string }[]).map((n) => n.name).sort(),
        ["net", "vpc"],
      );
      // Web's data records, including the one from the commit the feed
      // hides from him, and never its output.
      const keys = bob.entries.filter((e) => e.kind === "record").map((e) =>
        String(e.key)
      );
      assert(keys.some((key) => key.includes("/net/1/raw")));
      assert(keys.some((key) => key.includes("/vpc/1/raw")));
      assertEquals(keys.filter((key) => key.startsWith("outputs/")), []);
      assertEquals(
        bob.entries.filter((e) =>
          e.kind === "file" && String(e.key).startsWith("outputs/")
        ),
        [],
      );
      // The feed decides the whole commit: bob sees none of its ops there.
      const changes = await getJson(
        `${server.url}/changes?cursor=${point}`,
        "bob-token",
      );
      assertEquals(changes.json.changes, []);

      // Paged one entry at a time, bob reaches the same base: next moves
      // past what is filtered. A partition is sent again in each page that
      // holds an entry of it, at the same seq, which the copy dedupes.
      const paged = await readBase(server, "bob-token", 1);
      assert(paged.pages > 1);
      const others = (entries: Record<string, unknown>[]) =>
        entries.filter((e) => e.kind !== "partition");
      assertEquals(others(paged.entries), others(bob.entries));
      const repeated = paged.entries.filter((e) => e.kind === "partition");
      assert(repeated.length > 1);
      for (const entry of repeated) assertEquals(entry, partitions[0]);
    });
  },
});

/** Bob may read behavior web, so its outputs, and none of its data. */
const bobReadsWebOutputs = (): Grant[] => [
  grant({
    subject: { kind: "user", name: "bob" },
    actions: ["read"],
    resource: { kind: "model", pattern: "web" },
  }),
];

Deno.test({
  name:
    "datastore base: a caller who may read a behavior's outputs but not its data gets its partition's seq, never its data names or marks",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReadsWebOutputs()], async (server) => {
      await commit(server, saveOps(server, "vpc", 1));
      await commit(server, saveOps(server, "vpc", 2));
      await commit(server, [outputOp(server)]);
      await compactAll(server);
      const web = partitionOf({
        kind: "model",
        type: server.modelType,
        id: server.model.id,
      }).toString();

      const bob = await readBase(server, "bob-token");
      // The partition reaches him before its output, with its compacted
      // seq: he may read part of it, not all.
      const partitions = bob.entries.filter((e) => e.kind === "partition");
      assertEquals(partitions.length, 1);
      assertEquals(bob.entries[0], partitions[0]);
      assertEquals(partitions[0].partition, web);
      assertEquals(partitions[0].seq, 3);
      // No data name, and no version mark, of data he may not read.
      assertEquals(partitions[0].names, []);
      assertEquals(
        bob.entries.filter((e) =>
          e.kind === "version" || e.kind === "catalog-row" ||
          e.kind === "forward"
        ),
        [],
      );
      const keys = bob.entries.filter((e) =>
        e.kind === "record" || e.kind === "file"
      ).map((e) => String(e.key));
      assert(keys.some((key) => key.startsWith("outputs/")));
      assertEquals(keys.filter((key) => key.startsWith("data/")), []);

      // A caller who may read the data gets its names and marks.
      const alice = await readBase(server, "alice-token");
      const named = alice.entries.find((e) =>
        e.kind === "partition" && e.partition === web
      );
      assertEquals(named?.names, [{ name: "vpc", highWater: 2 }]);
    });
  },
});

Deno.test({
  name:
    "datastore base: a reply carries the log id, an uncompacted store has no base, and a token it never handed out is a 400",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const response = await fetch(`${server.url}/base`, {
        headers: { authorization: "Bearer alice-token" },
      });
      assertEquals(response.status, 200);
      assertEquals(
        response.headers.get(SERVE_DATASTORE_LOG_HEADER),
        server.v3.commitStore.logId(),
      );
      assertEquals(await response.json(), { point: 0, entries: [] });

      for (
        const query of ["after=not-a-token", 'after={"section":9}', "limit=0"]
      ) {
        const refused = await getJson(
          `${server.url}/base?${query}`,
          "alice-token",
        );
        assertEquals(refused.status, 400, query);
        assertEquals(refused.json.code, "invalid_request", query);
      }
      const unauthenticated = await fetch(`${server.url}/base`);
      assertEquals(unauthenticated.status, 401);
      await unauthenticated.body?.cancel();
    });
  },
});

Deno.test({
  name:
    "datastore base: a partition read below the compacted seq is a 410 naming the seq to read on from",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await commit(server, saveOps(server, "vpc", 1));
      await commit(server, saveOps(server, "vpc", 2));
      await compactAll(server);
      const read = await getJson(
        `${partitionPath(server)}?after=0`,
        "alice-token",
      );
      assertEquals(read.status, 410);
      assertEquals(read.json.code, "commits_compacted");
      assertEquals(read.json.seq, 2);
    });
  },
});
