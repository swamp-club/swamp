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
import fc from "fast-check";
import { createIntent, modelRef } from "../src/domain/datastore_v3/intent.ts";
import {
  dataVersionOp,
  type Op,
  putOp,
  tombstoneOp,
} from "../src/domain/datastore_v3/op.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../src/domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { base64 } from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { DurableWriteBatch } from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";
import { ProcessRuntime } from "../src/infrastructure/runtime/process_runtime.ts";
import {
  commitOf,
  observeReadModel,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const TYPE = ModelType.create("@swamp/aws-ec2");
const MODELS = [
  "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  "7a2d3b4c-5e6f-4a70-9b8c-0d1e2f3a4b5c",
  "8b3e4c5d-6f70-4b81-8c9d-1e2f3a4b5c6d",
] as const;
const NAMES = ["out", "log"] as const;
const CONFIG = partitionOf({
  kind: "config",
  definitionKind: "model",
  name: "producer",
});

function modelPartition(model: number): PartitionKey {
  return partitionOf({ kind: "model", type: TYPE, id: MODELS[model] });
}

const PARTITIONS = [
  ...MODELS.map((_, i) => modelPartition(i)),
  CONFIG,
];

/** a model's commit: a save of the name's next version, or a delete of its last */
type CommitSpec =
  | { readonly model: number; readonly name: number; readonly save: string }
  | { readonly model: number; readonly name: number; readonly save?: never }
  | { readonly config: string };

function intentOf(model: number, fields: Record<string, unknown>) {
  return createIntent({
    ...fields,
    kind: fields.kind as "data.save",
    model: modelRef(TYPE, MODELS[model]),
  });
}

function base(model: number, name: string, version: number): string {
  return `data/${TYPE.normalized}/${MODELS[model]}/${name}/${version}`;
}

async function append(
  env: V3Env,
  history: readonly CommitSpec[],
  afterEach: () => Promise<void>,
): Promise<void> {
  const seqs = new Map<string, number>();
  // a removed version is never written again: saves take the next unused one
  const issued = new Map<string, number>();
  const live = new Map<string, number[]>();
  for (const spec of history) {
    let partition: PartitionKey;
    const ops: Op[] = [];
    if ("config" in spec) {
      partition = CONFIG;
      ops.push(
        await putOp({
          intent: {
            kind: "definition.edit",
            definition: { kind: "model", name: "producer" },
          },
          key: RecordKey.create(
            "config/models/aws/3f0e7d1c-2b4a-4c6d-8e9f-0a1b2c3d4e5f.yaml",
          ),
          inline: base64(spec.config),
        }),
      );
    } else {
      partition = modelPartition(spec.model);
      const name = NAMES[spec.name];
      const at = `${spec.model}/${name}`;
      const versions = live.get(at) ?? [];
      live.set(at, versions);
      if (spec.save !== undefined) {
        const version = (issued.get(at) ?? 0) + 1;
        issued.set(at, version);
        versions.push(version);
        ops.push(
          await putOp({
            intent: intentOf(spec.model, { kind: "data.save", name, version }),
            key: RecordKey.create(`${base(spec.model, name, version)}/raw`),
            inline: base64(spec.save),
          }),
          dataVersionOp({
            key: RecordKey.create(
              `${base(spec.model, name, version)}/metadata.yaml`,
            ),
            metadata: {
              name,
              id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
              version,
              contentType: "application/json",
              lifetime: "infinite",
              garbageCollection: 10,
              tags: { type: "resource" },
              ownerDefinition: { ownerType: "manual", ownerRef: "test" },
              createdAt: "2026-10-11T00:00:00.000Z",
            },
          }),
        );
      } else {
        const current = versions.pop();
        if (current === undefined) continue;
        ops.push(tombstoneOp({
          intent: intentOf(spec.model, {
            kind: "data.delete",
            name,
            version: current,
          }),
          key: RecordKey.create(`${base(spec.model, name, current)}/raw`),
        }));
      }
    }
    const seq = (seqs.get(partition.toString()) ?? 0) + 1;
    seqs.set(partition.toString(), seq);
    await env.store.append(
      commitOf({ seq, partition, namespace: "", ops }),
    );
    await afterEach();
  }
}

type Step = "none" | "whole" | number;

const signal = () => AbortSignal.timeout(30_000);

async function observeAfter(
  env: V3Env,
  history: readonly CommitSpec[],
  plan: readonly Step[],
): Promise<unknown> {
  const readModel = env.openReadModel({ pageSize: 2 });
  try {
    let step = 0;
    await append(env, history, async () => {
      const next = plan.length === 0 ? "none" : plan[step++ % plan.length];
      if (next === "whole") await readModel.catchUp(signal());
      else if (next !== "none") {
        await readModel.catchUpPartition("", PARTITIONS[next], signal());
      }
    });
    await readModel.catchUp(signal());
    return await observeReadModel(
      env,
      readModel,
      PARTITIONS.map((partition) => ({ namespace: "", partition })),
    );
  } finally {
    await readModel.close();
  }
}

const arbCommit: fc.Arbitrary<CommitSpec> = fc.oneof(
  fc.record({
    model: fc.integer({ min: 0, max: MODELS.length - 1 }),
    name: fc.integer({ min: 0, max: NAMES.length - 1 }),
    save: fc.constantFrom("one", "two", "three"),
  }),
  fc.record({
    model: fc.integer({ min: 0, max: MODELS.length - 1 }),
    name: fc.integer({ min: 0, max: NAMES.length - 1 }),
  }),
  fc.record({ config: fc.constantFrom("v1", "v2") }),
);

const arbPlan = fc.array(
  fc.oneof(
    fc.constantFrom<Step>("none", "whole"),
    fc.integer({ min: 0, max: PARTITIONS.length - 1 }),
  ),
  { minLength: 1, maxLength: 8 },
);

Deno.test("scoped apply, property: any mix of partition and whole applies ends as whole applies alone do, in files, catalog and live index", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbCommit, { minLength: 1, maxLength: 12 }),
      arbPlan,
      async (history, plan) => {
        let wholeOnly: unknown;
        await withV3Env(async (env) => {
          wholeOnly = await observeAfter(env, history, ["whole"]);
        });
        await withV3Env(async (env) => {
          assertEquals(await observeAfter(env, history, plan), wholeOnly);
        });
      },
    ),
    { numRuns: 60 },
  );
});

class CrashAtBarrier extends DurableWriteBatch {
  constructor(private readonly crash: { armed: boolean }) {
    super();
  }
  override async barrier(): Promise<void> {
    if (this.crash.armed) {
      this.crash.armed = false;
      throw new Error("injected crash at the barrier");
    }
    await super.barrier();
  }
}

Deno.test("scoped apply: a process that dies between a partition apply ahead of the cursor and its next whole apply leaves a read model the next process brings to the whole-only result", async () => {
  const history: CommitSpec[] = [
    { model: 0, name: 0, save: "one" },
    { model: 1, name: 0, save: "one" },
    { config: "v1" },
    { model: 1, name: 0, save: "two" },
    { model: 0, name: 1, save: "three" },
    { model: 1, name: 0 },
    { model: 2, name: 1, save: "two" },
  ];
  let wholeOnly: unknown;
  await withV3Env(async (env) => {
    wholeOnly = await observeAfter(env, history, ["whole"]);
  });
  await withV3Env(async (env) => {
    const crash = { armed: false };
    let crashed: unknown;
    await new ProcessRuntime(`scoped-${crypto.randomUUID()}`).run(async () => {
      const readModel = env.openReadModel({
        pageSize: 2,
        writeBatch: () => new CrashAtBarrier(crash),
      });
      try {
        let appended = 0;
        await append(env, history, async () => {
          if (++appended === 3) await readModel.catchUp(signal());
        });
        await readModel.catchUpPartition("", PARTITIONS[1], signal());
        crash.armed = true;
        await readModel.catchUp(signal()).catch((error) => crashed = error);
      } finally {
        await readModel.close();
      }
    });
    assertEquals(
      (crashed as Error | undefined)?.message,
      "injected crash at the barrier",
    );
    await new ProcessRuntime(`next-${crypto.randomUUID()}`).run(async () => {
      const readModel = env.openReadModel({ pageSize: 2 });
      try {
        await readModel.catchUp(signal());
        assertEquals(
          await observeReadModel(
            env,
            readModel,
            PARTITIONS.map((partition) => ({ namespace: "", partition })),
          ),
          wholeOnly,
        );
      } finally {
        await readModel.close();
      }
    });
  });
});
