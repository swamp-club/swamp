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
import { stringify as stringifyYaml } from "@std/yaml";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import {
  BASE_DIFFERENCE_FEATURE,
  SERVE_DATASTORE_FEATURES_HEADER,
} from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
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

const bobReadsWebData = (): Grant[] => [
  grant({
    subject: { kind: "user", name: "bob" },
    actions: ["read"],
    resource: { kind: "data", pattern: "web" },
  }),
];

function intentOf(
  server: Server,
  kind: "data.save" | "data.delete",
  name: string,
  version: number,
  modelId = server.model.id,
) {
  return {
    kind,
    model: { type: server.modelType.normalized, id: modelId },
    name,
    version,
  };
}

function keyBase(
  server: Server,
  name: string,
  version: number,
  modelId = server.model.id,
): string {
  return `data/${server.modelType.normalized}/${modelId}/${name}/${version}`;
}

function saveOps(
  server: Server,
  name: string,
  version: number,
  modelId = server.model.id,
): unknown[] {
  const intent = intentOf(server, "data.save", name, version, modelId);
  const base = keyBase(server, name, version, modelId);
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

function deleteOps(server: Server, name: string, version: number): unknown[] {
  const intent = intentOf(server, "data.delete", name, version);
  const base = keyBase(server, name, version);
  return [
    { kind: "tombstone", intent, key: `${base}/raw` },
    { kind: "tombstone", intent, key: `${base}/metadata.yaml` },
  ];
}

async function commit(
  server: Server,
  ops: unknown[],
  modelId = server.model.id,
): Promise<void> {
  const path = partitionPath(server, modelId);
  const head = await server.v3.commitStore.head(
    "",
    partitionOf({ kind: "model", type: server.modelType, id: modelId }),
  );
  const committed = await post(
    path,
    "alice-token",
    commitBody({
      expectedSeq: head.seq,
      txnId: crypto.randomUUID(),
      ops,
    }),
  );
  assertEquals(committed.status, 200, JSON.stringify(committed.json));
}

async function compactAll(
  server: Server,
  pruneRemovedBefore?: Date,
): Promise<void> {
  const store = server.v3.commitStore;
  const fence = store.writerFence();
  await store.compactHistory(store.highWaterMark().cursor, {
    ...(fence !== undefined ? { fence } : {}),
    ...(pruneRemovedBefore !== undefined ? { pruneRemovedBefore } : {}),
  });
}

function partitionKeys(server: Server) {
  const of = (id: string) =>
    partitionOf({ kind: "model", type: server.modelType, id }).toString();
  return { web: of(server.model.id), secret: of(SECRET_ID) };
}

function partitionUrl(server: Server, partition: string, since?: number) {
  const query = new URLSearchParams({ partition });
  if (since !== undefined) query.set("since", String(since));
  return `${server.url}/base/partition?${query}`;
}

const options = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name:
    "datastore base index: lists only the partitions the caller may read, with their seq and size, and names base-difference",
  ...options,
  fn: async () => {
    await withServer([...writer(), ...bobReadsWebData()], async (server) => {
      await commit(server, saveOps(server, "vpc", 1));
      await commit(server, saveOps(server, "key", 1, SECRET_ID), SECRET_ID);
      await compactAll(server);
      const { web, secret } = partitionKeys(server);

      const response = await fetch(`${server.url}/base/index`, {
        headers: { authorization: "Bearer bob-token" },
      });
      assertEquals(response.status, 200);
      assert(
        (response.headers.get(SERVE_DATASTORE_FEATURES_HEADER) ?? "").split(",")
          .includes(BASE_DIFFERENCE_FEATURE),
      );
      const bob = await response.json() as {
        partitions: { partition: string; seq: number; rows: number }[];
      };
      assertEquals(bob.partitions.map((p) => p.partition), [web]);
      assert(bob.partitions[0].seq > 0 && bob.partitions[0].rows > 0);

      const alice = await getJson(`${server.url}/base/index`, "alice-token");
      assertEquals(
        (alice.json.partitions as { partition: string }[])
          .map((p) => p.partition).sort(),
        [secret, web].sort(),
      );
      const refused = await getJson(partitionUrl(server, secret), "bob-token");
      assertEquals(refused.status, 404);
    });
  },
});

Deno.test({
  name:
    "datastore base partition: a difference holds only what changed after the seq, its removals, and answers gone below the horizon",
  ...options,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const { web } = partitionKeys(server);
      await commit(server, saveOps(server, "vpc", 1));
      await commit(server, saveOps(server, "vpc", 2));
      await compactAll(server);
      const whole = await getJson(partitionUrl(server, web), "alice-token");
      assertEquals(whole.status, 200);
      const first = whole.json.seq as number;
      assertEquals(whole.json.removed, []);
      assert(
        (whole.json.entries as { kind: string }[]).some((e) =>
          e.kind === "record"
        ),
      );

      await commit(server, deleteOps(server, "vpc", 1));
      await commit(server, saveOps(server, "vpc", 3));
      await compactAll(server);
      const difference = await getJson(
        partitionUrl(server, web, first),
        "alice-token",
      );
      assertEquals(difference.status, 200);
      const records =
        (difference.json.entries as { kind: string; key: string }[])
          .filter((e) => e.kind === "record").map((e) => e.key);
      assert(
        records.every((key) => key.includes("/vpc/3/")),
        JSON.stringify(records),
      );
      const removed = difference.json.removed as {
        section: string;
        key: string;
      }[];
      assert(
        removed.some((r) =>
          r.section === "record" && r.key.includes("/vpc/1/")
        ),
      );
      assert(removed.some((r) => r.section === "version" && r.key === "1/vpc"));

      // an old removal pruned: a difference from before it is gone
      await commit(server, saveOps(server, "vpc", 4));
      await compactAll(server, new Date(Date.now() + 60_000));
      const gone = await getJson(
        partitionUrl(server, web, first),
        "alice-token",
      );
      assertEquals(gone.status, 410);
    });
  },
});

Deno.test({
  name:
    "datastore base: an existing base reply gains no field, so an older copy reads it unchanged",
  ...options,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await commit(server, saveOps(server, "vpc", 1));
      await compactAll(server);
      const page = await getJson(`${server.url}/base`, "alice-token");
      assertEquals(page.status, 200);
      const text = JSON.stringify(page.json);
      assertEquals(text.includes("changed_seq"), false);
      assertEquals(text.includes("changedSeq"), false);
      assertEquals(Object.keys(page.json).sort(), ["entries", "point"]);
    });
  },
});

Deno.test({
  name:
    "datastore base partition: paged, a partition's whole base arrives a page at a time, filtered as one read is",
  ...options,
  fn: async () => {
    await withServer([...writer(), ...bobReadsWebData()], async (server) => {
      const { web } = partitionKeys(server);
      for (let version = 1; version <= 3; version++) {
        await commit(server, saveOps(server, "vpc", version));
      }
      await compactAll(server);
      const whole = await getJson(
        `${partitionUrl(server, web)}`,
        "bob-token",
      );
      assertEquals(whole.status, 200);
      const paged: Record<string, unknown>[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const query = new URLSearchParams({
          partition: web,
          paged: "1",
          limit: "2",
        });
        if (after !== undefined) query.set("after", after);
        const page = await getJson(
          `${server.url}/base/partition?${query}`,
          "bob-token",
        );
        assertEquals(page.status, 200, JSON.stringify(page.json));
        paged.push(...page.json.entries as Record<string, unknown>[]);
        after = page.json.next as string | undefined;
        pages++;
      } while (after !== undefined);
      assert(pages > 1);
      const others = (entries: Record<string, unknown>[]) =>
        entries.filter((e) => e.kind !== "partition");
      assertEquals(
        others(paged),
        others(whole.json.entries as Record<string, unknown>[]),
      );
    });
  },
});

Deno.test({
  name:
    "datastore base partition: a removed record the caller may not read is withheld from its difference",
  ...options,
  fn: async () => {
    await withServer([...writer(), ...bobReadsWebData()], async (server) => {
      const { web } = partitionKeys(server);
      const type = server.modelType.normalized;
      const key =
        `outputs/${type}/create/${server.model.id}-2026-01-01T00-00-00-000Z.yaml`;
      const intent = (kind: string) => ({
        kind,
        model: { type, id: server.model.id },
        outputId: "o",
      });
      await commit(server, [
        ...saveOps(server, "vpc", 1),
        { kind: "put", intent: intent("output.save"), key, inline: btoa("x") },
      ]);
      await compactAll(server);
      const first = (await getJson(partitionUrl(server, web), "alice-token"))
        .json.seq as number;
      await commit(server, [
        { kind: "tombstone", intent: intent("output.delete"), key },
        ...deleteOps(server, "vpc", 1),
      ]);
      await compactAll(server);
      const removedFor = async (
        token: string,
      ) => ((await getJson(partitionUrl(server, web, first), token)).json
        .removed as { section: string; key: string }[]);
      assert((await removedFor("alice-token")).some((r) => r.key === key));
      const bob = await removedFor("bob-token");
      assertEquals(bob.some((r) => r.key === key), false);
      assert(bob.some((r) => r.key.includes("/vpc/1/")));
    });
  },
});

Deno.test({
  name:
    "datastore base partition: whether a caller sees a rewritten record follows its key and grants, never the content a fold wrote, as the feed decides it",
  ...options,
  fn: async () => {
    await withServer([...writer(), ...bobReadsWebData()], async (server) => {
      const { web } = partitionKeys(server);
      const type = server.modelType.normalized;
      const output =
        `outputs/${type}/create/${server.model.id}-2026-01-01T00-00-00-000Z.yaml`;
      const outputPut = (text: string) => ({
        kind: "put",
        intent: {
          kind: "output.save",
          model: { type, id: server.model.id },
          outputId: "o",
        },
        key: output,
        inline: btoa(text),
      });
      await commit(server, [...saveOps(server, "vpc", 1), outputPut("one")]);
      await compactAll(server);
      const keysOf = (json: Record<string, unknown>) =>
        (json.entries as { kind: string; key?: string }[])
          .filter((e) => e.kind === "record").map((e) => e.key);
      const whole = await getJson(partitionUrl(server, web), "bob-token");
      const first = whole.json.seq as number;
      assertEquals(keysOf(whole.json).includes(output), false);
      const point = await server.v3.commitStore.compactionPoint();

      // the same keys written again, with other content
      await commit(server, [...saveOps(server, "vpc", 2), outputPut("two")]);
      const feed = await getJson(
        `${server.url}/changes?cursor=${point}`,
        "bob-token",
      );
      await compactAll(server);
      const bob = await getJson(partitionUrl(server, web, first), "bob-token");
      const alice = await getJson(
        partitionUrl(server, web, first),
        "alice-token",
      );
      // bob: never the output, before or after; alice: the rewrite
      assertEquals(keysOf(bob.json).includes(output), false);
      assert(keysOf(bob.json).some((k) => k?.includes("/vpc/2/")));
      assert(keysOf(alice.json).includes(output));
      // the feed held the same line: the commit writing the output is not bob's
      assertEquals(
        (feed.json.changes as unknown[]).length,
        0,
        "a commit with a record bob may not read is withheld whole",
      );
    });
  },
});
