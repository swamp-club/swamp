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
  greatestLiveIn,
  isRenameMarker,
  liveAfter,
  type LiveDataVersion,
  projectCatalog,
} from "./catalog_projection.ts";
import { dataVersionOp, type Op, tombstoneOp } from "./op.ts";
import { RecordKey } from "./record_key.ts";
import { dataKey, metadata, modelIntent } from "./v3_test_helpers.ts";

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
 * which version a save or rename records: the next above the high-water mark,
 * or one at or below it that is not live, as v2 reuses a removed number and
 * parallel writers finish out of order
 */
const arbAt = fc.oneof(
  { weight: 3, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 6 }) },
);

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
      fc.array(fc.array(arbStep, { minLength: 1, maxLength: 3 }), {
        maxLength: 20,
      }),
      (commits) => {
        const live = new Map<string, LiveDataVersion[]>();
        const highWater = new Map<string, number>();
        const expired = new Set<string>();
        const catalog = new MemoryCatalog();

        for (const steps of commits) {
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
              greatestLiveIn((name) => working.get(name) ?? []),
            );
            for (const [name, changes] of effect.versions) {
              working.set(name, liveAfter(working.get(name) ?? [], changes));
            }
          }
          if (ops.length === 0) continue;

          const projection = projectCatalog(
            ops,
            greatestLiveIn((name) => live.get(name) ?? []),
          );
          for (const action of projection.actions) catalog.apply(action);
          for (const [name, changes] of projection.versions) {
            live.set(name, liveAfter(live.get(name) ?? [], changes));
          }
          for (const step of touched) {
            if (step.kind === "expire") expired.add(step.name);
            else expired.delete(step.name);
          }

          for (const name of NAMES) {
            const versions = live.get(name) ?? [];
            const top = versions.at(-1);
            const rows = catalog.rowsOf(name);
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

/** the oracle: folds every touched name's full live set */
function fullSetFold(
  ops: readonly Op[],
  liveBefore: (name: string) => readonly LiveDataVersion[],
): {
  actions: CatalogAction[];
  live: Map<string, LiveDataVersion[]>;
} {
  const live = new Map<string, Map<number, LiveDataVersion>>();
  const liveOf = (name: string) => {
    let versions = live.get(name);
    if (versions === undefined) {
      versions = new Map(liveBefore(name).map((v) => [v.version, v]));
      live.set(name, versions);
    }
    return versions;
  };
  const actions: CatalogAction[] = [];
  const reconcile = new Set<string>();
  for (const op of ops) {
    if (op.kind === "data-version") {
      const { metadata } = op;
      liveOf(metadata.name).set(metadata.version, {
        version: metadata.version,
        metadata,
      });
      if (isRenameMarker(metadata)) {
        actions.push(
          { kind: "remove-name", name: metadata.name },
          {
            kind: "forward",
            name: metadata.name,
            to: metadata.renamedTo as string,
          },
        );
      } else {
        actions.push({ kind: "upsert-version", metadata });
      }
    } else if (op.kind === "tombstone") {
      const intent = op.intent;
      if (intent.kind !== "data.delete" && intent.kind !== "data.gc") continue;
      if (intent.version !== undefined) {
        liveOf(intent.name).delete(intent.version);
        actions.push({
          kind: "remove-version",
          name: intent.name,
          version: intent.version,
        });
        reconcile.add(intent.name);
      } else if (intent.kind === "data.gc") {
        reconcile.delete(intent.name);
        actions.push(
          { kind: "remove-name", name: intent.name },
          { kind: "end-forward", name: intent.name },
        );
      }
    }
  }
  for (const name of reconcile) {
    let top: LiveDataVersion | undefined;
    for (const v of liveOf(name).values()) {
      if (top === undefined || v.version > top.version) top = v;
    }
    if (top === undefined) {
      actions.push({ kind: "remove-name", name }, {
        kind: "end-forward",
        name,
      });
    } else if (isRenameMarker(top.metadata)) {
      actions.push(
        { kind: "remove-name", name },
        { kind: "forward", name, to: top.metadata.renamedTo as string },
      );
    } else {
      actions.push({ kind: "upsert-version", metadata: top.metadata });
    }
  }
  return {
    actions,
    live: new Map(
      [...live].map(([name, versions]) => [
        name,
        [...versions.values()].sort((a, b) => a.version - b.version),
      ]),
    ),
  };
}

function versionAt(
  name: string,
  version: number,
  renamedTo: string | undefined,
): LiveDataVersion {
  const op = dataVersionOp({
    key: dataKey(name, version),
    metadata: renamedTo === undefined ? metadata(name, version) : {
      ...(metadata(name, version) as Record<string, unknown>),
      lifecycle: "deleted",
      renamedTo,
    },
  });
  return { version, metadata: op.metadata };
}

const arbMarker = fc.option(fc.constantFrom("c", "d"), { freq: 4 });

const arbStored = fc.record({
  a: fc.uniqueArray(fc.tuple(fc.integer({ min: 1, max: 8 }), arbMarker), {
    selector: ([v]) => v,
    maxLength: 8,
  }),
  b: fc.uniqueArray(fc.tuple(fc.integer({ min: 1, max: 8 }), arbMarker), {
    selector: ([v]) => v,
    maxLength: 8,
  }),
});

const arbOp = fc.oneof(
  fc.record({
    kind: fc.constant("put" as const),
    name: fc.constantFrom(...NAMES),
    version: fc.integer({ min: 1, max: 9 }),
    marker: arbMarker,
  }),
  fc.record({
    kind: fc.constantFrom("delete" as const, "gc" as const),
    name: fc.constantFrom(...NAMES),
    version: fc.option(fc.integer({ min: 1, max: 9 }), { freq: 4 }),
  }),
);

Deno.test("projectCatalog: version changes give the same actions and live sets as the full-set fold", () => {
  fc.assert(
    fc.property(
      arbStored,
      fc.array(arbOp, { maxLength: 8 }),
      (stored, steps) => {
        const before = new Map<string, LiveDataVersion[]>(
          NAMES.map((name) => [
            name,
            stored[name]
              .map(([v, to]) => versionAt(name, v, to ?? undefined))
              .sort((x, y) => x.version - y.version),
          ]),
        );
        const ops: Op[] = steps.map((step) =>
          step.kind === "put"
            ? dataVersionOp({
              key: dataKey(step.name, step.version),
              metadata: versionAt(
                step.name,
                step.version,
                step.marker ?? undefined,
              ).metadata,
            })
            : tombstoneOp({
              intent: modelIntent(
                step.version === null
                  ? { kind: `data.${step.kind}`, name: step.name }
                  : {
                    kind: `data.${step.kind}`,
                    name: step.name,
                    version: step.version,
                  },
              ),
              key: step.version === null
                ? RecordKey.create(`data/m/${step.name}/latest`)
                : dataKey(step.name, step.version),
            })
        );
        const versionsOf = (name: string) => before.get(name) ?? [];
        const expected = fullSetFold(ops, versionsOf);
        const projection = projectCatalog(ops, greatestLiveIn(versionsOf));
        assertEquals(projection.actions, expected.actions);
        assertEquals(
          new Map(
            [...projection.versions].map((
              [name, changes],
            ) => [name, liveAfter(versionsOf(name), changes)]),
          ),
          expected.live,
        );
        for (const changes of projection.versions.values()) {
          const put = new Set(changes.put.map((v) => v.version));
          assert(changes.removed.every((v) => !put.has(v)));
        }
      },
    ),
    { numRuns: 1000 },
  );
});
