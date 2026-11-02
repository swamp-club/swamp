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
import { stringify as stringifyYaml } from "@std/yaml";
import { ReadModelIncompleteError } from "../domain/datastore_v3/read_model.ts";
import { RecordKey } from "../domain/datastore_v3/record_key.ts";
import type { V3Datastore } from "../infrastructure/datastore_v3/v3_datastore.ts";
import { storedRunRecordGuarded } from "./commit_read_filter.ts";

const WORKFLOW = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const RUN = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const KEY = `workflow-runs/${WORKFLOW}/workflow-run-${RUN}.yaml`;

function record(fields: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(stringifyYaml({
    id: RUN,
    workflowId: WORKFLOW,
    workflowName: "deploy",
    status: "succeeded",
    tags: {},
    jobs: [],
    ...fields,
  }));
}

function storeHolding(
  stored:
    | { bytes: Uint8Array | undefined; sha256?: string; key?: string }
    | "incomplete"
    | "empty",
): V3Datastore {
  return {
    namespace: "ns",
    readModel: {
      liveRecords: () => {
        if (stored === "incomplete") {
          return Promise.reject(new ReadModelIncompleteError());
        }
        if (stored === "empty") return Promise.resolve([]);
        return Promise.resolve([{
          key: RecordKey.create(stored.key ?? KEY),
          sha256: "live",
          content: { kind: "inline" },
        }]);
      },
      recordBytes: () =>
        Promise.resolve(
          stored === "incomplete" || stored === "empty" ||
            stored.bytes === undefined
            ? undefined
            : {
              record: { sha256: stored.sha256 ?? "live", writer: null },
              bytes: stored.bytes,
            },
        ),
    },
  } as unknown as V3Datastore;
}

Deno.test("storedRunRecordGuarded: a member's undecided run, or none stored, is not guarded (swamp-club#4290)", async () => {
  assertEquals(
    await storedRunRecordGuarded(
      storeHolding({ bytes: record() }),
      WORKFLOW,
      RUN,
    ),
    false,
  );
  assertEquals(
    await storedRunRecordGuarded(storeHolding("empty"), WORKFLOW, RUN),
    false,
  );
  assertEquals(
    await storedRunRecordGuarded(
      storeHolding({
        bytes: record({ instanceId: "node" }),
        key: `workflows-evaluated/runs/${RUN}/evaluated-workflow.yaml`,
      }),
      WORKFLOW,
      RUN,
    ),
    false,
  );
});

Deno.test("storedRunRecordGuarded: fails closed when the record cannot be read, has moved, or does not parse (swamp-club#4290)", async () => {
  for (
    const stored of [
      "incomplete" as const,
      { bytes: undefined },
      { bytes: record(), sha256: "older" },
      { bytes: new TextEncoder().encode("jobs: [unterminated") },
      { bytes: new TextEncoder().encode("id: 7\n") },
      { bytes: record({ instanceId: "node" }) },
    ]
  ) {
    assertEquals(
      await storedRunRecordGuarded(storeHolding(stored), WORKFLOW, RUN),
      true,
      JSON.stringify(stored),
    );
  }
});
