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

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import {
  type ReadableSpan,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import { grant } from "./serve_request_harness.ts";
import {
  commitBody,
  partitionPath,
  post,
  save,
  seedHistory,
  type Server,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

const COUNTED = [
  "swamp.datastore.v3.versions_read",
  "swamp.datastore.v3.versions_written",
];

const STAGES = [
  "authorize",
  "ingest",
  "landed_lookup",
  "content_check",
  "locked_catch_up",
  "locked_authorize",
  "append",
];

function readModelWork(spans: readonly ReadableSpan[]): Record<string, number> {
  const work: Record<string, number> = {};
  for (const span of spans) {
    if (!span.name.startsWith("swamp.datastore.v3.readmodel.")) continue;
    for (const name of COUNTED) {
      work[name] = (work[name] ?? 0) + Number(span.attributes[name] ?? 0);
    }
  }
  return work;
}

async function deleteVersion(
  server: Server,
  version: number,
  expectedSeq: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const type = server.modelType.normalized;
  const base = `data/${type}/${server.model.id}/seeded/${version}`;
  const intent = {
    kind: "data.delete",
    model: { type, id: server.model.id },
    name: "seeded",
    version,
  };
  return await post(
    partitionPath(server),
    "alice-token",
    commitBody({
      expectedSeq,
      txnId: crypto.randomUUID(),
      ops: [
        { kind: "tombstone", intent, key: `${base}/raw` },
        { kind: "tombstone", intent, key: `${base}/metadata.yaml` },
      ],
      chunks: [],
    }),
  );
}

/** a save of the name's next version, then a delete of it, which reconciles */
async function workAfter(
  history: number,
): Promise<{ save: Record<string, number>; delete: Record<string, number> }> {
  const work = { save: {}, delete: {} };
  await withCapturedSpans(async (spans) => {
    const grants = [
      ...writer(),
      grant({ actions: ["write"], resource: { kind: "data", pattern: "*" } }),
    ];
    await withServer(grants, async (server) => {
      await seedHistory(server, history);
      const beforeSave = spans.length;
      const saved = await save(server, "alice-token", history + 1, history, {
        name: "seeded",
      });
      assertEquals(saved.status, 200, JSON.stringify(saved.json));
      const saveSpans = spans.slice(beforeSave);
      for (const stage of STAGES) {
        assert(
          saveSpans.some((s) =>
            s.name === `swamp.serve.datastore.commit.${stage}`
          ),
          `no span for the ${stage} stage`,
        );
      }
      work.save = readModelWork(saveSpans);
      const beforeDelete = spans.length;
      const deleted = await deleteVersion(server, history + 1, history + 1);
      assertEquals(deleted.status, 200, JSON.stringify(deleted.json));
      work.delete = readModelWork(spans.slice(beforeDelete));
    });
  });
  return work;
}

Deno.test({
  name:
    "datastore API: one write's read-model work on serve is the same at 50 and 2,000 commits of its data name's history",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const short = await workAfter(50);
    const long = await workAfter(2_000);
    assertEquals(long, short);
    assertEquals(short.save["swamp.datastore.v3.versions_written"], 1);
    // the delete reads the removed version and the one now on top
    assertEquals(short.delete, {
      "swamp.datastore.v3.versions_read": 2,
      "swamp.datastore.v3.versions_written": 1,
    });
  },
});
