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
import fc from "fast-check";
import {
  type CatalogAction,
  isRenameMarker,
  type LiveDataVersion,
  projectCatalog,
} from "./catalog_projection.ts";
import { dataVersionOp, type Op, tombstoneOp } from "./op.ts";
import { RecordKey } from "./record_key.ts";
import { dataKey, metadata, modelIntent } from "./v3_test_helpers.ts";

/**
 * The catalog as `CatalogStore` keeps it, reduced to what the projection
 * drives: each name's row versions and its forward. An upsert that becomes
 * the latest ends the name's forward, as `upsertNewVersion` does.
 */
class MemoryCatalog {
  readonly rows = new Map<string, Set<number>>();
  readonly forwards = new Map<string, string>();

  apply(action: CatalogAction): void {
    switch (action.kind) {
      case "upsert-version": {
        const { name, version } = action.metadata;
        const rows = this.rows.get(name) ?? new Set<number>();
        if ([...rows].every((v) => v <= version)) this.forwards.delete(name);
        rows.add(version);
        this.rows.set(name, rows);
        break;
      }
      case "remove-version":
        this.rows.get(action.name)?.delete(action.version);
        break;
      case "remove-name":
        this.rows.delete(action.name);
        break;
      case "forward":
        this.forwards.set(action.name, action.to);
        break;
      case "end-forward":
        this.forwards.delete(action.name);
        break;
    }
  }

  rowsOf(name: string): number[] {
    return [...(this.rows.get(name) ?? [])].sort((a, b) => a - b);
  }
}

const NAMES = ["a", "b"] as const;

/**
 * Which version a save or rename records: the next above the high-water
 * mark, or (swamp-club#3250) a version at or below it that is not live, as
 * v2 reuses a removed number and parallel writers finish out of order.
 */
const arbAt = fc.oneof(
  { weight: 3, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 6 }) },
);

/** One step, described relative to the state when it runs. */
const arbStep = fc.oneof(
  fc.record({
    kind: fc.constant("save" as const),
    name: fc.constantFrom(...NAMES),
    at: arbAt,
  }),
  fc.record({
    kind: fc.constant("rename" as const),
    name: fc.constantFrom(...NAMES),
    to: fc.constantFrom("c", "d"),
    at: arbAt,
  }),
  fc.record({
    kind: fc.constantFrom("delete" as const, "gc" as const),
    name: fc.constantFrom(...NAMES),
    pick: fc.nat(),
  }),
  fc.record({
    kind: fc.constant("expire" as const),
    name: fc.constantFrom(...NAMES),
  }),
);

type Step = typeof arbStep extends fc.Arbitrary<infer T> ? T : never;

Deno.test("projectCatalog: the catalog tracks each name's top live version across random histories", () => {
  fc.assert(
    fc.property(
      // Each commit holds one to three steps, so ops in one commit interact.
      fc.array(fc.array(arbStep, { minLength: 1, maxLength: 3 }), {
        maxLength: 20,
      }),
      (commits) => {
        const live = new Map<string, LiveDataVersion[]>();
        const highWater = new Map<string, number>();
        const expired = new Set<string>();
        const catalog = new MemoryCatalog();

        for (const steps of commits) {
          // Build the commit's ops step by step against a working copy of
          // the live versions, so a later step sees an earlier one's effect.
          const working = new Map(live);
          const ops: Op[] = [];
          const touched: Step[] = [];
          for (const step of steps) {
            // A late save below the top after expiry restores no row in v2
            // but its own, which this test's top-version rule does not model.
            const expiredNow = expired.has(step.name) ||
              touched.some((s) => s.kind === "expire" && s.name === step.name);
            const stepOps = opsFor(step, working, highWater, expiredNow);
            if (stepOps.length === 0) continue;
            ops.push(...stepOps);
            touched.push(step);
            const effect = projectCatalog(
              stepOps,
              (name) => working.get(name) ?? [],
            );
            for (const [name, versions] of effect.live) {
              working.set(name, [...versions]);
            }
          }
          if (ops.length === 0) continue;

          const projection = projectCatalog(
            ops,
            (name) => live.get(name) ?? [],
          );
          for (const action of projection.actions) catalog.apply(action);
          for (const [name, versions] of projection.live) {
            live.set(name, [...versions]);
          }
          // The last step to touch a name decides whether it ends expired.
          for (const step of touched) {
            if (step.kind === "expire") expired.add(step.name);
            else expired.delete(step.name);
          }

          for (const name of NAMES) {
            const versions = live.get(name) ?? [];
            const top = versions.at(-1);
            const rows = catalog.rowsOf(name);
            // Every row is a live version.
            assert(rows.every((r) => versions.some((v) => v.version === r)));
            if (expired.has(name) || top === undefined) {
              assertEquals(rows, []);
              assertEquals(catalog.forwards.get(name), undefined);
            } else if (isRenameMarker(top.metadata)) {
              assertEquals(rows, []);
              assertEquals(catalog.forwards.get(name), top.metadata.renamedTo);
            } else {
              assertEquals(rows.at(-1), top.version);
              assertEquals(catalog.forwards.get(name), undefined);
            }
          }
        }
      },
    ),
    { numRuns: 500 },
  );
});

function opsFor(
  step: Step,
  live: ReadonlyMap<string, readonly LiveDataVersion[]>,
  highWater: Map<string, number>,
  expired: boolean,
): Op[] {
  const name = step.name;
  const next = () => {
    const top = highWater.get(name) ?? 0;
    const at = "at" in step ? step.at : undefined;
    const isLive = (version: number) =>
      (live.get(name) ?? []).some((v) => v.version === version);
    // v2 writes a rename marker above every version on disk, so only a
    // save lands below a live version. A late save below a rename marker
    // follows v2's catalog rather than this test's top-version rule; the v2
    // oracle (`datastore_v3_read_model_v2_oracle_test.ts`) covers it.
    const versions = live.get(name) ?? [];
    const aboveLive = (version: number) =>
      versions.every((v) => v.version < version);
    const topLive = versions.reduce<LiveDataVersion | undefined>(
      (best, v) => best === undefined || v.version > best.version ? v : best,
      undefined,
    );
    const belowOk = step.kind === "save" && !expired &&
      (topLive === undefined || !isRenameMarker(topLive.metadata));
    if (
      at !== undefined && at <= top && !isLive(at) &&
      (aboveLive(at) || belowOk)
    ) {
      return at;
    }
    highWater.set(name, top + 1);
    return top + 1;
  };
  switch (step.kind) {
    case "save": {
      const version = next();
      return [dataVersionOp({
        key: dataKey(name, version),
        metadata: metadata(name, version),
      })];
    }
    case "rename": {
      const version = next();
      return [dataVersionOp({
        key: dataKey(name, version),
        metadata: {
          ...(metadata(name, version) as Record<string, unknown>),
          lifecycle: "deleted",
          renamedTo: step.to,
        },
      })];
    }
    case "delete":
    case "gc": {
      const versions = live.get(name) ?? [];
      if (versions.length === 0) return [];
      const version = versions[step.pick % versions.length].version;
      return [tombstoneOp({
        intent: modelIntent({ kind: `data.${step.kind}`, name, version }),
        key: dataKey(name, version),
      })];
    }
    case "expire":
      return [tombstoneOp({
        intent: modelIntent({ kind: "data.gc", name }),
        key: RecordKey.create(`data/m/${name}/latest`),
      })];
  }
}
