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
import {
  createIntent,
  type Intent,
  intentPartition,
  modelRef,
} from "./intent.ts";
import { bindKey } from "./intent_key_paths.ts";
import { RecordKey } from "./record_key.ts";

/**
 * An aggregate and the keys its repositories write, built independently of
 * the binding: the projection side of the property.
 */
interface Aggregate {
  readonly intents: readonly Intent[];
  readonly keys: readonly string[];
  /** Keys any aggregate of the same kind may share by design. */
  readonly shared: readonly string[];
}

const TYPES = ["@swamp/aws-ec2", "@swamp/aws-s3", "acme/web", "@swamp/grant"];
const uuid = fc.uuid({ version: 4 }).map((id) => id.toLowerCase());
const name = fc.constantFrom("vpc", "web", "net", "grant-main", "deploy");

const modelAggregate: fc.Arbitrary<Aggregate> = fc.record({
  type: fc.constantFrom(...TYPES.filter((t) => t !== "@swamp/grant")),
  id: uuid,
  data: name,
  version: fc.integer({ min: 1, max: 5 }),
}).map(({ type, id, data, version }) => {
  const model = modelRef(ModelType.create(type), id);
  const base = `data/${type}/${id}/${data}`;
  return {
    intents: [
      createIntent({ kind: "data.save", model, name: data, version }),
      createIntent({ kind: "data.delete", model, name: data }),
      createIntent({ kind: "data.rename", model, name: data, to: "renamed" }),
      createIntent({ kind: "output.save", model, outputId: "o" }),
      createIntent({ kind: "evaluated-definition.save", model }),
    ],
    keys: [
      `${base}/${version}/raw`,
      `${base}/${version}/metadata.yaml`,
      `${base}/latest`,
      `definitions-evaluated/${type}/${id}.yaml`,
      `outputs/${type}/create/${id}-2026-01-01T00-00-00-000Z.yaml`,
    ],
    shared: [],
  };
});

const grantAggregate: fc.Arbitrary<Aggregate> = uuid.map((id) => {
  const model = modelRef(ModelType.create("@swamp/grant"), id);
  return {
    intents: [createIntent({ kind: "grant.create", model })],
    keys: [`data/@swamp/grant/${id}/grant-main/1/raw`],
    shared: [],
  };
});

const runAggregate: fc.Arbitrary<Aggregate> = fc.record({
  workflowId: uuid,
  runId: uuid,
}).map((run) => ({
  intents: [
    createIntent({ kind: "run.update", run }),
    createIntent({ kind: "run-snapshot.save", run }),
  ],
  keys: [
    `workflow-runs/${run.workflowId}/workflow-run-${run.runId}.yaml`,
    `workflows-evaluated/runs/${run.runId}/evaluated-workflow.yaml`,
  ],
  shared: [],
}));

const definitionAggregate: fc.Arbitrary<Aggregate> = fc.record({
  kind: fc.constantFrom("model", "workflow"),
  name,
  type: fc.constantFrom(...TYPES),
}).map(({ kind, name, type }) => ({
  intents: [
    createIntent({ kind: "definition.edit", definition: { kind, name } }),
  ],
  keys: [
    kind === "model"
      ? `config/models/${type}/${name}.yaml`
      : `config/workflows/workflow-${name}.yaml`,
  ],
  shared: [],
}));

const aggregate = fc.oneof(
  modelAggregate,
  grantAggregate,
  runAggregate,
  definitionAggregate,
);

Deno.test("bindKey: no key of another aggregate is ever bound to an intent", () => {
  let checked = 0;
  fc.assert(
    fc.property(aggregate, aggregate, (a, b) => {
      for (const intent of a.intents) {
        for (const key of b.keys) {
          if (a.keys.includes(key)) continue;
          const sameAggregate = b.intents.some((other) =>
            intentPartition(other).equals(intentPartition(intent))
          );
          for (const opKind of ["put", "tombstone"] as const) {
            const bound = bindKey(intent, opKind, RecordKey.create(key)).ok;
            // Two aggregates with one partition (the same behavior drawn
            // twice) may bind each other's keys; nothing else may.
            if (!sameAggregate) {
              assert(!bound, `${intent.kind} bound ${key}`);
            }
            checked++;
          }
        }
      }
    }),
    { numRuns: 500 },
  );
  assert(checked > 1_000, `only ${checked} pairs were checked`);
});

Deno.test("bindKey: every key an aggregate writes binds to one of its intents", () => {
  fc.assert(
    fc.property(aggregate, (a) => {
      for (const key of a.keys) {
        const bound = a.intents.some((intent) =>
          (["put", "tombstone"] as const).some((opKind) =>
            bindKey(intent, opKind, RecordKey.create(key)).ok
          )
        );
        assert(bound, `no intent binds ${key}`);
      }
    }),
    { numRuns: 300 },
  );
});

Deno.test("bindKey: a key with an extra or a missing segment never binds", () => {
  fc.assert(
    fc.property(
      aggregate,
      fc.constantFrom("extra", "missing"),
      (a, mutation) => {
        for (const key of [...a.keys, ...a.shared]) {
          const segments = key.split("/");
          const mutated = mutation === "extra"
            ? [...segments.slice(0, -1), "x", segments[segments.length - 1]]
            : segments.filter((_, i) => i !== 1);
          if (mutated.length === 0) continue;
          const mutatedKey = RecordKey.create(mutated.join("/"));
          for (const intent of a.intents) {
            for (const opKind of ["put", "tombstone"] as const) {
              const binding = bindKey(intent, opKind, mutatedKey);
              // A type spans segments, so dropping or adding one can name
              // another valid type: that binding names it.
              if (binding.ok && binding.type !== undefined) continue;
              assert(
                !binding.ok,
                `${intent.kind} bound mutated ${mutatedKey}`,
              );
            }
          }
        }
      },
    ),
    { numRuns: 300 },
  );
});
