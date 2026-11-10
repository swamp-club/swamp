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
import { dirname, join } from "@std/path";
import { walk } from "@std/fs";
import fc from "fast-check";
import { stringify as stringifyYaml } from "@std/yaml";
import { Data } from "../src/domain/data/data.ts";
import { createIntent, modelRef } from "../src/domain/datastore_v3/intent.ts";
import {
  dataVersionOp,
  type Op,
  putOp,
  tombstoneOp,
} from "../src/domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  base64,
  metadata,
  MODEL_TYPE,
  modelCommit,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import type { SqliteReadModel } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import {
  findSpan,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import {
  catalogV3Path,
  readCatalog,
  readTree,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const IDS = [
  "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  "7a2d3b4c-5e6f-4a70-9b8c-0d1e2f3a4b5c",
] as const;
const NAMES = ["a", "b", "c"] as const;
const PARTITIONS = IDS.map((id) =>
  partitionOf({ kind: "model", type: MODEL_TYPE, id })
);

/** tracking started long before any writer the test interrupts */
const TRACKING_START = new Date(1_000);

function keyOf(id: string, name: string, version: number, file: string) {
  return RecordKey.create(
    `data/${MODEL_TYPE.normalized}/${id}/${name}/${version}/${file}`,
  );
}

function intent(
  id: string,
  fields: Record<string, unknown> & { kind: string },
) {
  return createIntent({ ...fields, model: modelRef(MODEL_TYPE, id) } as never);
}

function versionMeta(
  name: string,
  version: number,
  extra: Record<string, unknown> = {},
) {
  return { ...(metadata(name, version) as Record<string, unknown>), ...extra };
}

const arbHistoryStep = fc.record({
  model: fc.constantFrom(0, 1),
  kind: fc.constantFrom(
    "save",
    "save",
    "append",
    "rename",
    "delete",
    "gc",
    "expire",
  ),
  name: fc.constantFrom(...NAMES),
  to: fc.constantFrom(...NAMES),
  pick: fc.nat(),
});

type HistoryStep = typeof arbHistoryStep extends fc.Arbitrary<infer T> ? T
  : never;

const arbWriterStep = fc.record({
  model: fc.constantFrom(0, 1),
  kind: fc.constantFrom(
    "repo-save",
    "repo-delete",
    "repo-expire",
    "row-upsert",
    "row-remove",
    "row-forward",
    "overwrite",
    "unlink",
    "unowned",
    "commit",
  ),
  name: fc.constantFrom(...NAMES),
  pick: fc.nat(),
});

type WriterStep = typeof arbWriterStep extends fc.Arbitrary<infer T> ? T
  : never;

/** live versions per partition and name, as the commits left them */
class History {
  readonly seqs = [0, 0];
  readonly live = new Map<string, number[]>();
  readonly highWater = new Map<string, number>();
  #txn = 0;

  liveOf(model: number, name: string): number[] {
    return this.live.get(`${model}/${name}`) ?? [];
  }

  async opsFor(step: HistoryStep | WriterStep): Promise<Op[]> {
    const id = IDS[step.model];
    const name = step.name;
    const id_ = `${step.model}/${name}`;
    const live = this.liveOf(step.model, name);
    const next = () => (this.highWater.get(id_) ?? 0) + 1;
    const save = async (
      n: string,
      version: number,
      text: string,
      extra = {},
    ) => [
      await putOp({
        intent: intent(id, { kind: "data.save", name: n, version }),
        key: keyOf(id, n, version, "raw"),
        inline: base64(text),
      }),
      // as the repository's staged changes: metadata and marker are records
      await putOp({
        intent: intent(id, { kind: "data.save", name: n, version }),
        key: keyOf(id, n, version, "metadata.yaml"),
        inline: base64(stringifyYaml(versionMeta(n, version, extra))),
      }),
      dataVersionOp({
        key: keyOf(id, n, version, "metadata.yaml"),
        metadata: versionMeta(n, version, extra),
      }),
      await putOp({
        intent: intent(id, { kind: "data.save", name: n, version }),
        key: RecordKey.create(
          `data/${MODEL_TYPE.normalized}/${id}/${n}/latest`,
        ),
        inline: base64(String(version)),
      }),
    ];
    switch (step.kind) {
      case "save":
      case "commit":
        return await save(name, next(), `${name}@${next()}#${this.#txn}`);
      case "append": {
        const top = live.at(-1);
        if (top === undefined) return [];
        return [
          await putOp({
            intent: intent(id, { kind: "data.append", name, version: top }),
            key: keyOf(id, name, top, "raw"),
            inline: base64(`${name}@${top}+${this.#txn}`),
          }),
        ];
      }
      case "rename": {
        const to = "to" in step ? step.to : name;
        if (to === name || live.length === 0) return [];
        const marker = next();
        const target = (this.highWater.get(`${step.model}/${to}`) ?? 0) + 1;
        return [
          dataVersionOp({
            key: keyOf(id, name, marker, "metadata.yaml"),
            metadata: versionMeta(name, marker, {
              lifecycle: "deleted",
              renamedTo: to,
            }),
          }),
          ...await save(to, target, `${to}@${target} from ${name}`),
        ];
      }
      case "delete":
      case "gc": {
        if (live.length === 0) return [];
        const version = live[step.pick % live.length];
        return (["raw", "metadata.yaml"] as const).map((file) =>
          tombstoneOp({
            intent: intent(id, { kind: `data.${step.kind}`, name, version }),
            key: keyOf(id, name, version, file),
          })
        );
      }
      case "expire":
        return [tombstoneOp({
          intent: intent(id, { kind: "data.gc", name }),
          key: RecordKey.create(
            `data/${MODEL_TYPE.normalized}/${id}/${name}/latest`,
          ),
        })];
      default:
        return [];
    }
  }

  async append(
    env: V3Env,
    model: number,
    ops: readonly Op[],
  ): Promise<boolean> {
    if (ops.length === 0) return false;
    const seq = this.seqs[model] + 1;
    try {
      await env.store.append(modelCommit(seq, ops, {
        partition: PARTITIONS[model],
        txnId: `h-${this.#txn++}`,
      }));
    } catch (error) {
      if (!(error instanceof CommitRejectedError)) throw error;
      return false;
    }
    this.seqs[model] = seq;
    for (const op of ops) {
      if (op.kind === "data-version") {
        const key = `${model}/${op.metadata.name}`;
        const versions = new Set(this.live.get(key) ?? []);
        versions.add(op.metadata.version);
        this.live.set(key, [...versions].sort((x, y) => x - y));
        this.highWater.set(
          key,
          Math.max(this.highWater.get(key) ?? 0, op.metadata.version),
        );
      } else if (op.kind === "tombstone") {
        const removed = op.intent;
        if (
          (removed.kind === "data.delete" || removed.kind === "data.gc") &&
          removed.version !== undefined
        ) {
          const key = `${model}/${removed.name}`;
          this.live.set(
            key,
            (this.live.get(key) ?? []).filter((v) => v !== removed.version),
          );
        }
      }
    }
    return true;
  }
}

function repoData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test" },
  });
}

async function backdate(root: string, at: Date): Promise<void> {
  try {
    for await (const entry of walk(root, { includeDirs: false })) {
      if (entry.isSymlink) continue;
      await Deno.utime(entry.path, at, at);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function presentFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (
      const entry of walk(join(root, "data"), { includeDirs: false })
    ) {
      files.push(entry.path);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return files.sort();
}

async function observe(env: V3Env, readModel: SqliteReadModel) {
  const live: Record<string, unknown> = {};
  for (const partition of PARTITIONS) {
    live[partition.toString()] = (await readModel.liveRecords("", partition))
      .map((record) => [record.key.toString(), record.sha256]);
  }
  return {
    catalog: readCatalog(catalogV3Path(env)),
    tree: Object.fromEntries(await readTree(env.cacheRoot(""))),
    live,
  };
}

async function recoverAndPath(
  readModel: SqliteReadModel,
  options: Parameters<SqliteReadModel["recover"]>[1],
): Promise<
  {
    path: unknown;
    fallback: unknown;
    touched: unknown;
    restored: unknown;
    removed: unknown;
  }
> {
  let found = {
    path: undefined as unknown,
    fallback: undefined as unknown,
    touched: undefined as unknown,
    restored: undefined as unknown,
    removed: undefined as unknown,
  };
  await withCapturedSpans(async (spans) => {
    await readModel.recover("", options);
    const attributes = findSpan(spans, "swamp.datastore.v3.readmodel.recover")
      .attributes;
    const of = (name: string) =>
      attributes[`swamp.datastore.v3.readmodel.recover.${name}`];
    found = {
      path: of("path"),
      fallback: of("fallback"),
      touched: of("touched_names"),
      restored: of("files_restored"),
      removed: of("files_removed"),
    };
  });
  return found;
}

interface Coverage {
  runs: number;
  targeted: number;
  fallbacks: Record<string, number>;
  touched: number;
  restored: number;
  removed: number;
  aborted: number;
  pinned: number;
  dropped: number;
  compacted: number;
  catalogOnly: number;
  landed: number;
  committedAfter: number;
}

const coverage: Coverage = {
  runs: 0,
  targeted: 0,
  fallbacks: {},
  touched: 0,
  restored: 0,
  removed: 0,
  aborted: 0,
  pinned: 0,
  dropped: 0,
  compacted: 0,
  catalogOnly: 0,
  landed: 0,
  committedAfter: 0,
};

/** a writer's repository call over files earlier steps tore may fail part way */
let writeFailed = false;

async function tolerated<T>(write: () => Promise<T>): Promise<T | undefined> {
  try {
    return await write();
  } catch {
    writeFailed = true;
    return undefined;
  }
}

async function writerStep(
  env: V3Env,
  history: History,
  step: WriterStep,
  repo: FileSystemUnifiedDataRepository,
  catalog: CatalogStore,
  writtenDirs: Set<string>,
): Promise<number | undefined> {
  const id = IDS[step.model];
  const root = env.cacheRoot("");
  const live = history.liveOf(step.model, step.name);
  switch (step.kind) {
    case "repo-save": {
      const saved = await tolerated(() =>
        repo.save(
          MODEL_TYPE,
          id,
          repoData(step.name),
          new TextEncoder().encode(`uncommitted ${step.pick}`),
        )
      );
      if (saved === undefined) return undefined;
      writtenDirs.add(
        `data/${MODEL_TYPE.normalized}/${id}/${step.name}/${saved.version}`,
      );
      return saved.version;
    }
    case "repo-delete":
      if (live.length === 0) return;
      await tolerated(() =>
        repo.delete(
          MODEL_TYPE,
          id,
          step.name,
          live[step.pick % live.length],
        )
      );
      return;
    case "repo-expire":
      await tolerated(() => repo.removeLatestMarker(MODEL_TYPE, id, step.name));
      return;
    case "row-upsert": {
      coverage.catalogOnly++;
      const version =
        (history.highWater.get(`${step.model}/${step.name}`) ?? 0) +
        1 + step.pick % 2;
      catalog.upsertNewVersion({
        namespace: "",
        type_normalized: MODEL_TYPE.normalized,
        model_id: id,
        data_name: step.name,
        id: crypto.randomUUID(),
        version,
        is_latest: 1,
        is_step_latest: 1,
        model_name: "",
        spec_name: "",
        data_type: "resource",
        content_type: "application/json",
        lifetime: "infinite",
        garbage_collection: "10",
        lifecycle: "active",
        owner_type: "manual",
        streaming: 0,
        size: 1,
        created_at: new Date(0).toISOString(),
        tags: "{}",
        owner_ref: "test",
        workflow_run_id: "",
        workflow_name: "",
        job_name: "",
        step_name: "",
        source: "",
      });
      return;
    }
    case "row-remove":
      coverage.catalogOnly++;
      catalog.remove("", MODEL_TYPE.normalized, id, step.name);
      return;
    case "row-forward":
      coverage.catalogOnly++;
      catalog.recordRename({
        namespace: "",
        type_normalized: MODEL_TYPE.normalized,
        model_id: id,
        data_name: step.name,
        renamed_to: "elsewhere",
      });
      return;
    case "overwrite":
    case "unlink": {
      const files = await presentFiles(root);
      if (files.length === 0) return;
      const path = files[step.pick % files.length];
      if (step.kind === "overwrite") {
        await Deno.writeTextFile(path, `overwritten ${step.pick}`);
      } else {
        await Deno.remove(path);
      }
      return;
    }
    case "unowned": {
      const path = join(
        root,
        "data",
        MODEL_TYPE.normalized,
        id,
        step.name,
        String(90 + step.pick % 5),
        "raw",
      );
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, "unowned");
      return;
    }
    case "commit":
      if (await history.append(env, step.model, await history.opsFor(step))) {
        coverage.committedAfter++;
      }
      return;
  }
}

Deno.test({
  name:
    "targeted recovery: leaves the catalog, renames, files and live records a full rebuild leaves, whatever the history and whatever an interrupted writer or dropped work left (swamp-club#4581)",
  sanitizeResources: false,
  fn: async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbHistoryStep, { minLength: 4, maxLength: 24 }),
        fc.nat(),
        fc.array(arbWriterStep, { minLength: 1, maxLength: 10 }),
        fc.option(
          fc.record({
            // what a cleanly ended command's queued entries wrote: their own
            // names' rows and files, nothing of another name
            pending: fc.tuple(
              arbWriterStep.map((step) => ({
                ...step,
                kind: "repo-save" as WriterStep["kind"],
              })),
              fc.array(
                arbWriterStep.filter((step) =>
                  step.kind.startsWith("repo-") || step.kind.startsWith("row-")
                ),
                { maxLength: 2 },
              ),
            ).map(([first, rest]) => [first, ...rest]),
            lands: fc.boolean(),
          }),
          { nil: undefined },
        ),
        fc.constantFrom("interrupted_writer" as const, "dropped_work" as const),
        fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
        async (steps, compactAt, writer, pinned, entry, abortAt) => {
          coverage.runs++;
          await withV3Env(async (env) => {
            const history = new History();
            // a checkout that caught up nothing has no state to build on
            for (const model of [0, 1]) {
              await history.append(
                env,
                model,
                await history.opsFor({ ...steps[0], model, kind: "save" }),
              );
            }
            const point = compactAt % (steps.length + 1);
            for (const [i, step] of steps.entries()) {
              if (i === point) {
                await env.store.compactHistory(Number.MAX_SAFE_INTEGER);
                coverage.compacted++;
              }
              await history.append(env, step.model, await history.opsFor(step));
            }
            let readModel = env.openReadModel({
              clock: () => TRACKING_START,
            });
            try {
              await readModel.catchUp(AbortSignal.timeout(30_000));
            } finally {
              await readModel.close();
            }
            const root = env.cacheRoot("");
            await backdate(root, new Date(Date.now() - 600_000));
            const since = Date.now() - 60_000;
            const catalog = new CatalogStore(catalogV3Path(env));
            const repo = new FileSystemUnifiedDataRepository(
              env.repoDir,
              undefined,
              catalog,
            );
            const writtenDirs = new Set<string>();
            try {
              if (pinned !== undefined) {
                coverage.pinned++;
                // an earlier command's outbox entries outlive its clean end
                writeFailed = false;
                const saved: (number | undefined)[] = [];
                for (const step of pinned.pending) {
                  saved.push(
                    await writerStep(
                      env,
                      history,
                      step,
                      repo,
                      catalog,
                      writtenDirs,
                    ),
                  );
                }
                const pins = pinned.pending.map((step, i) => ({
                  namespace: "",
                  type: MODEL_TYPE.normalized,
                  modelId: IDS[step.model],
                  name: step.name,
                  partition: PARTITIONS[step.model].toString(),
                  txnId: `pending-${i}`,
                }));
                readModel = env.openReadModel({ clock: () => TRACKING_START });
                try {
                  await readModel.releaseDirtyNames(
                    pins,
                    () => Promise.resolve(false),
                  );
                  const landing = saved[0];
                  if (pinned.lands && landing !== undefined) {
                    // the first entry lands as it was written, as a later
                    // flush lands it; one the store refuses stays pinned
                    const step = pinned.pending[0];
                    const highWater = history.highWater.get(
                      `${step.model}/${step.name}`,
                    );
                    history.highWater.set(
                      `${step.model}/${step.name}`,
                      landing - 1,
                    );
                    const landed = await history.append(
                      env,
                      step.model,
                      await history.opsFor({ ...step, kind: "commit" }),
                    );
                    if (!landed && highWater !== undefined) {
                      history.highWater.set(
                        `${step.model}/${step.name}`,
                        highWater,
                      );
                    }
                    if (landed) coverage.landed++;
                    await readModel.catchUp(AbortSignal.timeout(30_000));
                    await readModel.releaseDirtyNames(
                      landed ? pins.slice(1) : pins,
                      (pin) =>
                        Promise.resolve(landed && pin.txnId === "pending-0"),
                    );
                  }
                } finally {
                  await readModel.close();
                }
                // a write that failed part way is dropped work, never left
                // queued by a clean end: its files stay as new as the writer's
                if (!writeFailed) {
                  await backdate(root, new Date(Date.now() - 600_000));
                }
                writtenDirs.clear();
              }
              for (const step of writer) {
                await writerStep(
                  env,
                  history,
                  step,
                  repo,
                  catalog,
                  writtenDirs,
                );
              }
            } finally {
              catalog.close();
            }
            if (entry === "dropped_work") coverage.dropped++;
            const options = {
              since,
              admits: () => true,
              entry,
              targeted: true,
              ...(entry === "dropped_work"
                ? { droppedDirs: [...writtenDirs] }
                : {}),
            };
            if (abortAt !== undefined) {
              const stop = new AbortController();
              let reads = 0;
              const stopping = new Proxy(env.store, {
                get(target, property) {
                  if (property === "readPartitionBase") {
                    return (
                      ...args: Parameters<typeof target.readPartitionBase>
                    ) => {
                      if (++reads === abortAt) stop.abort();
                      return target.readPartitionBase(...args);
                    };
                  }
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                },
              });
              readModel = env.openReadModel({ commitStore: stopping });
              try {
                await readModel.recover("", { ...options, signal: stop.signal })
                  .catch(() => {});
                if (stop.signal.aborted) coverage.aborted++;
              } finally {
                await readModel.close();
              }
            }
            readModel = env.openReadModel();
            let targeted;
            try {
              const run = await recoverAndPath(readModel, {
                ...options,
                signal: AbortSignal.timeout(30_000),
              });
              if (run.path === "targeted") coverage.targeted++;
              else {
                const reason = String(run.fallback);
                coverage.fallbacks[reason] = (coverage.fallbacks[reason] ?? 0) +
                  1;
              }
              assertEquals(run.path, "targeted", String(run.fallback));
              coverage.touched += Number(run.touched ?? 0);
              coverage.restored += Number(run.restored ?? 0);
              coverage.removed += Number(run.removed ?? 0);
              targeted = await observe(env, readModel);
              await readModel.recover("", {
                ...options,
                targeted: false,
                signal: AbortSignal.timeout(30_000),
              });
              const full = await observe(env, readModel);
              assertEquals(targeted, full);
            } finally {
              await readModel.close();
            }
            // every committed version's record is in place
            for (const [key, versions] of history.live) {
              const [model, name] = key.split("/");
              for (const version of versions) {
                const raw = keyOf(IDS[Number(model)], name, version, "raw")
                  .toString();
                const owned =
                  (targeted.live[PARTITIONS[Number(model)].toString()] as [
                    string,
                    string,
                  ][])
                    .some(([k]) => k === raw);
                if (owned) assert(raw in targeted.tree, raw);
              }
            }
          });
        },
      ),
      { numRuns: 150 },
    );
    console.log(`targeted recovery coverage: ${JSON.stringify(coverage)}`);
  },
});
