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
import {
  type CatalogAction,
  greatestLiveIn,
  liveAfter,
  type LiveDataVersion,
  projectCatalog,
} from "./catalog_projection.ts";
import type { BaseDataName, PartitionBase } from "./commit_store.ts";
import type { DataMetadata } from "../data/data_metadata.ts";
import { DataMetadataSchema } from "../data/data_metadata.ts";
import { catalogActionsForNames } from "./name_history_replay.ts";
import { dataVersionOp, type Op, tombstoneOp } from "./op.ts";
import { RecordKey } from "./record_key.ts";
import {
  dataKey,
  metadata,
  MODEL_ID,
  MODEL_TYPE,
  modelCommit,
  modelIntent,
} from "./v3_test_helpers.ts";

const NAMES = ["a", "b", "c"] as const;

function meta(name: string, version: number, renamedTo?: string): DataMetadata {
  return DataMetadataSchema.parse({
    ...(metadata(name, version) as Record<string, unknown>),
    ...(renamedTo === undefined ? {} : { lifecycle: "deleted", renamedTo }),
  });
}

const arbOp = fc.oneof(
  fc.record({
    kind: fc.constant("save" as const),
    name: fc.constantFrom(...NAMES),
    version: fc.integer({ min: 1, max: 6 }),
    renamedTo: fc.option(fc.constantFrom("x", "y"), { nil: undefined }),
  }),
  fc.record({
    kind: fc.constantFrom("data.delete" as const, "data.gc" as const),
    name: fc.constantFrom(...NAMES),
    version: fc.integer({ min: 1, max: 6 }),
  }),
  fc.record({
    kind: fc.constant("expire" as const),
    name: fc.constantFrom(...NAMES),
  }),
);

type OpSpec = typeof arbOp extends fc.Arbitrary<infer T> ? T : never;

function opOf(spec: OpSpec): Op {
  switch (spec.kind) {
    case "save":
      return dataVersionOp({
        key: dataKey(spec.name, spec.version),
        metadata: meta(spec.name, spec.version, spec.renamedTo),
      });
    case "data.delete":
    case "data.gc":
      return tombstoneOp({
        intent: modelIntent({
          kind: spec.kind,
          name: spec.name,
          version: spec.version,
        }),
        key: dataKey(spec.name, spec.version),
      });
    case "expire":
      return tombstoneOp({
        intent: modelIntent({ kind: "data.gc", name: spec.name }),
        key: RecordKey.create(
          `data/${MODEL_TYPE.normalized}/${MODEL_ID}/${spec.name}/latest`,
        ),
      });
  }
}

const arbBaseName = fc.record({
  versions: fc.uniqueArray(fc.integer({ min: 1, max: 6 }), { maxLength: 3 }),
  rows: fc.uniqueArray(fc.integer({ min: 1, max: 6 }), { maxLength: 2 }),
  forward: fc.option(fc.constantFrom("x", "y"), { nil: undefined }),
});

function baseOf(
  specs: Readonly<
    Record<string, { versions: number[]; rows: number[]; forward?: string }>
  >,
  compactedSeq: number,
): PartitionBase {
  const names = new Map<string, BaseDataName>();
  for (const [name, spec] of Object.entries(specs)) {
    names.set(name, {
      versions: spec.versions.map((version) => ({
        version,
        metadata: meta(name, version),
      })),
      catalogRows: spec.rows.map((version) => meta(name, version)),
      forward: spec.forward,
    });
  }
  return { compactedSeq, names };
}

function nameOfAction(action: CatalogAction): string {
  return action.kind === "upsert-version" ? action.metadata.name : action.name;
}

/** a full rebuild's base load and replay over every name */
function fullReplay(
  base: PartitionBase,
  commits: readonly (readonly Op[])[],
): { actions: CatalogAction[]; live: Map<string, LiveDataVersion[]> } {
  const replay = catalogActionsForNames(
    base,
    [],
    new Set(base.names.keys()),
  );
  const actions = [...replay.actions];
  const live = new Map<string, LiveDataVersion[]>();
  for (const [name, versions] of replay.live) live.set(name, [...versions]);
  for (const ops of commits) {
    const projection = projectCatalog(
      ops,
      greatestLiveIn((name) => live.get(name) ?? []),
    );
    actions.push(...projection.actions);
    for (const [name, changes] of projection.versions) {
      live.set(name, liveAfter(live.get(name) ?? [], changes));
    }
  }
  return { actions, live };
}

Deno.test("catalogActionsForNames: replaying some names alone gives exactly their part of replaying every name", () => {
  fc.assert(
    fc.property(
      fc.dictionary(fc.constantFrom(...NAMES), arbBaseName),
      fc.array(fc.array(arbOp, { minLength: 1, maxLength: 4 }), {
        maxLength: 12,
      }),
      fc.subarray([...NAMES]),
      (baseSpecs, commitSpecs, chosen) => {
        const base = baseOf(baseSpecs, 3);
        const ops = commitSpecs.map((specs) => specs.map(opOf));
        const commits = ops.map((commitOps, i) =>
          modelCommit(4 + i, commitOps)
        );
        const names = new Set<string>(chosen);
        const full = fullReplay(base, ops);
        const targeted = catalogActionsForNames(base, commits, names);
        assertEquals(
          targeted.actions,
          full.actions.filter((action) => names.has(nameOfAction(action))),
        );
        for (const name of names) {
          assertEquals(
            targeted.live.get(name) ?? [],
            full.live.get(name) ?? [],
          );
        }
      },
    ),
    { numRuns: 500 },
  );
});

Deno.test("catalogActionsForNames: commits at or below the compacted seq are left to the base", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(arbOp, { minLength: 1, maxLength: 3 }), {
        minLength: 1,
        maxLength: 6,
      }),
      (commitSpecs) => {
        const base = baseOf({}, commitSpecs.length);
        const commits = commitSpecs.map((specs, i) =>
          modelCommit(i + 1, specs.map(opOf))
        );
        const replay = catalogActionsForNames(base, commits, new Set(NAMES));
        assertEquals(replay.actions, []);
        assertEquals(replay.commits, 0);
      },
    ),
    { numRuns: 100 },
  );
});
