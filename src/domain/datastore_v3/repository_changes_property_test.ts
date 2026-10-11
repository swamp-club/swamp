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

import { assert } from "@std/assert";
import fc from "fast-check";
import { ModelType } from "../models/model_type.ts";
import type { TypedChange } from "./commit_log_unit_of_work.ts";
import { intentPartition } from "./intent.ts";
import {
  ConfigChanges,
  ModelChanges,
  recordKeyOf,
} from "./repository_changes.ts";
import { metadata } from "./v3_test_helpers.ts";

const arbType = fc.constantFrom(
  "@swamp/aws-ec2",
  "swamp/echo",
  "aws/ec2/vpc",
  "@collective/x-y",
).map((raw) => ModelType.create(raw));
const arbName = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);

/** The record key a change writes or removes. */
function keyOf(change: TypedChange): string {
  if ("put" in change) return change.put.key.toString();
  const op = change.op;
  if (op.kind === "lease") throw new Error("no lease is staged");
  return op.key.toString();
}

/**
 * Every change any builder makes, for one model, data name and version: the
 * keys a repository can stage.
 */
function everyChange(
  changes: ModelChanges,
  name: string,
  version: number,
): TypedChange[] {
  const written = {
    name,
    version,
    metadata: metadata(name, version),
    metadataBytes: new Uint8Array([1]),
    raw: new Uint8Array([2]),
  };
  return [
    ...changes.writeVersion({ kind: "data.save" }, written),
    ...changes.writeVersion({ kind: "data.append" }, written),
    ...changes.writeVersion(
      { kind: "data.rename", from: name, to: `${name}-new` },
      written,
    ),
    changes.writeContent({ kind: "data.save" }, name, version, written.raw),
    changes.latestPut({ kind: "data.save" }, name, version, written.raw),
    changes.latestPut({ kind: "data.gc" }, name, version, written.raw),
    ...changes.removeVersion("data.delete", name, version),
    changes.removeLatest("data.gc", name),
  ];
}

Deno.test("ModelChanges: every data key lies under its name's directory in its model's partition", () => {
  fc.assert(
    fc.property(
      arbType,
      fc.uuid({ version: 4 }),
      arbName,
      fc.integer({ min: 1, max: 1_000_000 }),
      (type, modelId, name, version) => {
        const changes = new ModelChanges(type, modelId);
        const prefix = `data/${type.normalized}/${modelId}/${name}/`;
        for (const change of everyChange(changes, name, version)) {
          assert(change.partition.equals(changes.partition));
          const key = keyOf(change);
          assert(key.startsWith(prefix), key);
          assert(!key.includes("\\"));
          if ("put" in change) {
            assert(intentPartition(change.put.intent).equals(change.partition));
          } else if (change.op.kind === "tombstone") {
            assert(intentPartition(change.op.intent).equals(change.partition));
          }
        }
      },
    ),
  );
});

Deno.test("ModelChanges: every output key lies under its type's outputs directory", () => {
  fc.assert(
    fc.property(
      arbType,
      fc.uuid({ version: 4 }),
      arbName,
      arbName,
      (type, modelId, method, file) => {
        const changes = new ModelChanges(type, modelId);
        const prefix = `outputs/${type.normalized}/${method}/`;
        for (
          const change of [
            changes.writeOutput("o", method, `${file}.yaml`, new Uint8Array()),
            changes.removeOutput("o", method, `${file}.yaml`),
          ]
        ) {
          assert(keyOf(change).startsWith(prefix));
          assert(change.partition.equals(changes.partition));
        }
      },
    ),
  );
});

const arbSegment = fc.string({ minLength: 1, maxLength: 12 }).filter((s) =>
  s !== "." && s !== ".." && !s.includes("\0")
);

Deno.test("recordKeyOf: segments without a separator round-trip, and any separator is refused", () => {
  fc.assert(
    fc.property(
      fc.array(arbSegment, { minLength: 1, maxLength: 6 }),
      (segments) => {
        const separated = segments.some((s) =>
          s.includes("/") || s.includes("\\")
        );
        if (separated) {
          let threw = false;
          try {
            recordKeyOf(segments);
          } catch {
            threw = true;
          }
          assert(threw);
          return;
        }
        assert(
          recordKeyOf(segments).toString().split("/").length ===
            segments.length,
        );
        assert(recordKeyOf(segments).toString() === segments.join("/"));
      },
    ),
  );
});

Deno.test("ConfigChanges: every change of a definition lies in its partition, under the tier prefix it was given", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("model" as const, "workflow" as const),
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.array(
        arbSegment.filter((s) => !s.includes("/") && !s.includes("\\")),
        {
          minLength: 1,
          maxLength: 3,
        },
      ),
      (kind, name, other, rest) => {
        const config = new ConfigChanges(kind, name);
        const key = recordKeyOf(["config", ...rest]);
        const changes: TypedChange[] = [
          config.write("definition.create", key, new Uint8Array(), "absent"),
          config.remove("definition.delete", key),
          config.renameTo(other, key, new Uint8Array()),
          config.renameFrom(other, key),
        ];
        for (const change of changes) {
          assert(change.partition.equals(config.partition));
          const intent = "put" in change
            ? change.put.intent
            : (change.op as { intent: Parameters<typeof intentPartition>[0] })
              .intent;
          assert(intentPartition(intent).equals(config.partition));
          assert(keyOf(change).startsWith("config/"));
        }
      },
    ),
  );
});
