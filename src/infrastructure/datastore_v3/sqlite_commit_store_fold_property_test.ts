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
import { join } from "@std/path";
import fc from "fast-check";
import type { LiveDataVersion } from "../../domain/datastore_v3/catalog_projection.ts";
import type { CatalogNameState } from "../../domain/datastore_v3/catalog_state.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import type { PartitionBaseRows } from "../../domain/datastore_v3/commit_store.ts";
import {
  type CompactedBaseWriter,
  foldCommit,
} from "../../domain/datastore_v3/compaction.ts";
import type { FileOwnership } from "../../domain/datastore_v3/materialisation.ts";
import { dataVersionOp, type Op } from "../../domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  deleteVersion,
  metadata,
  MODEL_ID,
  MODEL_TYPE,
  modelCommit,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitStore, versionRowKey } from "./sqlite_commit_store.ts";

const NAMES = ["a", "b"] as const;

const arbOp = fc.oneof(
  fc.record({
    kind: fc.constant("version" as const),
    name: fc.constantFrom(...NAMES),
    version: fc.integer({ min: 1, max: 4 }),
    // the same version recorded again with other metadata
    variant: fc.integer({ min: 0, max: 1 }),
    // only an append re-records a live version
    append: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("marker" as const),
    name: fc.constantFrom(...NAMES),
    version: fc.integer({ min: 1, max: 4 }),
  }),
  fc.record({
    kind: fc.constant("delete" as const),
    name: fc.constantFrom(...NAMES),
    version: fc.integer({ min: 1, max: 4 }),
  }),
);

const arbStep = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("commit" as const),
      ops: fc.array(arbOp, { minLength: 1, maxLength: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("compact" as const),
      batchSize: fc.integer({ min: 1, max: 3 }),
    }),
  },
);

type OpSpec = typeof arbOp extends fc.Arbitrary<infer T> ? T : never;

async function buildOps(spec: OpSpec): Promise<Op[]> {
  if (spec.kind === "delete") return [deleteVersion(spec.name, spec.version)];
  const base = metadata(spec.name, spec.version) as Record<string, unknown>;
  const recorded = spec.kind === "marker"
    ? {
      ...base,
      lifecycle: "deleted",
      renamedTo: spec.name === "a" ? "b" : "a",
    }
    : spec.variant === 0
    ? base
    : { ...base, tags: { type: "resource", variant: "1" } };
  const record = dataVersionOp({
    key: RecordKey.create(
      `data/${MODEL_TYPE.normalized}/${MODEL_ID}/${spec.name}/${spec.version}/metadata.yaml`,
    ),
    metadata: recorded,
  });
  return spec.kind === "version" && spec.append
    ? [
      await savePut(spec.name, spec.version, "x", undefined, "data.append"),
      record,
    ]
    : [record];
}

/** reference fold: every set replaces the name's whole state */
class RewritingBase implements CompactedBaseWriter {
  readonly versions = new Map<string, readonly LiveDataVersion[]>();
  readonly catalog = new Map<string, CatalogNameState>();
  readonly #files = new Map<string, FileOwnership>();

  atCommit(): void {}
  putRecord(): void {}
  deleteRecord(): void {}
  liveVersions(_ns: string, _p: string, name: string) {
    return this.versions.get(name) ?? [];
  }
  setLiveVersions(
    _ns: string,
    _p: string,
    name: string,
    versions: readonly LiveDataVersion[],
  ): void {
    this.versions.set(name, versions);
  }
  catalogName(_ns: string, _p: string, name: string): CatalogNameState {
    return this.catalog.get(name) ?? { rows: [], forward: undefined };
  }
  setCatalogName(
    _ns: string,
    _p: string,
    name: string,
    state: CatalogNameState,
  ): void {
    this.catalog.set(name, state);
  }
  fileOwnership(_ns: string, key: string): FileOwnership | undefined {
    return this.#files.get(key);
  }
  setFileOwnership(_ns: string, key: string, ownership: FileOwnership): void {
    this.#files.set(key, ownership);
  }
  hasPresentFileUnder(): boolean {
    return false;
  }
  setCompactedSeq(): void {}
}

/** versions, catalog rows (with the metadata a reader is sent) and forwards, by row key */
type BaseView = Map<string, string>;

function viewOf(rows: PartitionBaseRows): BaseView {
  const view: BaseView = new Map();
  for (const entry of rows.entries) {
    if (entry.kind === "version") {
      view.set(
        `version:${
          versionRowKey(
            (entry.version.metadata as { name: string }).name,
            entry.version.version,
          )
        }`,
        JSON.stringify(entry.version.metadata),
      );
    } else if (entry.kind === "catalog-row") {
      view.set(
        `catalog:${versionRowKey(entry.metadata.name, entry.metadata.version)}`,
        JSON.stringify(entry.metadata),
      );
    } else if (entry.kind === "forward") {
      view.set(`forward:${entry.name}`, entry.to);
    }
  }
  return view;
}

function referenceView(base: RewritingBase): BaseView {
  const view: BaseView = new Map();
  for (const [name, versions] of base.versions) {
    for (const { version, metadata } of versions) {
      view.set(
        `version:${versionRowKey(name, version)}`,
        JSON.stringify(metadata),
      );
    }
  }
  for (const [name, state] of base.catalog) {
    for (const row of state.rows) {
      view.set(
        `catalog:${versionRowKey(name, row.version)}`,
        JSON.stringify(row),
      );
    }
    if (state.forward !== undefined) view.set(`forward:${name}`, state.forward);
  }
  return view;
}

function sorted(view: BaseView): [string, string][] {
  return [...view].sort(([a], [b]) => a.localeCompare(b));
}

const SECTIONS = new Set(["version", "catalog", "forward"]);

/** the base at `since`, with the difference since it applied */
function applied(start: BaseView, difference: PartitionBaseRows): BaseView {
  const view = new Map(start);
  for (const removal of difference.removed) {
    if (SECTIONS.has(removal.section)) {
      view.delete(`${removal.section}:${removal.key}`);
    }
  }
  for (const [key, value] of viewOf(difference)) view.set(key, value);
  return view;
}

Deno.test("SqliteCommitStore fold: a fold that writes only what each commit changed leaves the base a full rewrite would, and every difference since a fold brings that fold's base to the head (swamp-club#4981)", async () => {
  const coverage = { metadataChanged: 0, readded: 0, differences: 0 };
  const dir = await Deno.makeTempDir();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbStep, { minLength: 1, maxLength: 25 }),
        async (steps) => {
          const path = join(dir, `${crypto.randomUUID()}.db`);
          const store = SqliteCommitStore.open(path);
          const reference = new RewritingBase();
          const partition = modelPartition().toString();
          const commits: Commit[] = [];
          const folds: { seq: number; view: BaseView }[] = [];
          const recorded = new Map<string, string>();
          const deleted = new Set<string>();
          try {
            const fold = async (batchSize: number) => {
              await store.compactHistory(commits.length, { batchSize });
              const whole = await store.readBaseOfPartition(
                "",
                partition,
                undefined,
                100_000,
              );
              if (typeof whole === "string") throw new Error(whole);
              folds.push({ seq: whole.seq, view: viewOf(whole) });
            };
            for (const step of steps) {
              if (step.kind === "compact") {
                if (commits.length > 0) await fold(step.batchSize);
                continue;
              }
              const seq = commits.length + 1;
              const ops = (await Promise.all(step.ops.map(buildOps))).flat();
              const commit = modelCommit(seq, ops);
              try {
                await store.append(commit);
              } catch (error) {
                // a commit the partition refuses never lands, in either fold
                if (error instanceof CommitRejectedError) continue;
                throw error;
              }
              commits.push(commit);
              for (const op of step.ops) {
                const key = `${op.name}@${op.version}`;
                if (op.kind === "delete") {
                  deleted.add(key);
                  continue;
                }
                const text = JSON.stringify(op);
                const before = recorded.get(key);
                if (before !== undefined && before !== text) {
                  coverage.metadataChanged++;
                }
                if (deleted.has(key)) coverage.readded++;
                recorded.set(key, text);
              }
            }
            if (commits.length === 0) return;
            await fold(3);
            commits.forEach((commit, i) =>
              foldCommit(reference, commit, i + 1, new Set())
            );
            const head = folds[folds.length - 1].view;
            assertEquals(sorted(head), sorted(referenceView(reference)));
            for (const { seq, view } of folds) {
              const difference = await store.readBaseOfPartition(
                "",
                partition,
                seq,
                100_000,
              );
              if (typeof difference === "string") continue;
              coverage.differences++;
              assertEquals(sorted(applied(view, difference)), sorted(head));
            }
          } finally {
            await store.close();
          }
        },
      ),
      { numRuns: 150 },
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
  assert(
    coverage.metadataChanged > 0,
    "no version was recorded again with other metadata",
  );
  assert(coverage.readded > 0, "no version was deleted and recorded again");
  assert(coverage.differences > 0, "no difference was read");
});
