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

/**
 * commits rebase in outbox order, each on the state the earlier ones left, so
 * they never share a version; each is built under its original txnId, so a
 * cut-off and resumed flush never lands one twice
 */

import { maxOf } from "../array_extrema.ts";
import type { DataMetadata } from "../data/data_metadata.ts";
import { ModelType } from "../models/model_type.ts";
import type { BlobRef } from "./blob_ref.ts";
import type { Commit } from "./commit.ts";
import type { TypedChange } from "./commit_log_unit_of_work.ts";
import type { FileAccess } from "./file_access.ts";
import { createIntent, type Intent, modelRef } from "./intent.ts";
import {
  chooseLatest,
  correctedExecutionTime,
  observationTimeOf,
  RESTATES_TAG,
  sourceVersionOf,
  type VersionObservation,
} from "./latest_choice.ts";
import {
  type DataVersionOp,
  dataVersionOp,
  type Op,
  type PutOp,
  putOp,
  type TombstoneOp,
  tombstoneOp,
} from "./op.ts";
import type { Partition } from "./partition.ts";
import { ModelChanges } from "./repository_changes.ts";
import { RecordKey } from "./record_key.ts";

export interface VersionContent {
  readonly raw: { readonly blob: BlobRef } | { readonly inline: string };
  readonly rawAccess?: FileAccess;
  readonly metadata: DataMetadata;
}

export interface OfflineRebaseLookups {
  observation(name: string, version: number): VersionObservation | undefined;
  /**
   * The content of committed version `version` of `name`, or undefined
   * when this checkout cannot read it: it is then not restated.
   */
  content(name: string, version: number): VersionContent | undefined;
}

export interface CarriedCreatedAt {
  readonly name: string;
  readonly version: number;
  readonly createdAt: string;
}

/**
 * queued numbers are unique among a partition's queued commits, so the maps
 * merge without conflict
 */
export interface OfflineRebaseCarry {
  readonly versions: readonly RenumberedVersion[];
  readonly digests: readonly (readonly [string, string])[];
  readonly createdAt: readonly CarriedCreatedAt[];
}

export const EMPTY_REBASE_CARRY: OfflineRebaseCarry = {
  versions: [],
  digests: [],
  createdAt: [],
};

export function mergeRebaseCarry(
  earlier: OfflineRebaseCarry,
  later: OfflineRebaseCarry,
): OfflineRebaseCarry {
  return {
    versions: [...earlier.versions, ...later.versions],
    digests: [...earlier.digests, ...later.digests],
    createdAt: [...earlier.createdAt, ...later.createdAt],
  };
}

/**
 * A carry read back from where it was recorded, or undefined when it is not
 * one: it was written by this code, but a file can be edited or damaged.
 */
export function parseRebaseCarry(text: string): OfflineRebaseCarry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { versions, digests, createdAt } = value as Record<string, unknown>;
  if (
    !Array.isArray(versions) || !Array.isArray(digests) ||
    !Array.isArray(createdAt)
  ) {
    return undefined;
  }
  const isVersion = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  const parsed: OfflineRebaseCarry = {
    versions: versions.filter((v): v is RenumberedVersion =>
      typeof v === "object" && v !== null &&
      typeof (v as RenumberedVersion).name === "string" &&
      isVersion((v as RenumberedVersion).from) &&
      isVersion((v as RenumberedVersion).to)
    ).map(({ name, from, to }) => ({ name, from, to })),
    digests: digests.filter((pair): pair is [string, string] =>
      Array.isArray(pair) && pair.length === 2 &&
      typeof pair[0] === "string" && typeof pair[1] === "string"
    ).map(([from, to]) => [from, to] as const),
    createdAt: createdAt.filter((c): c is CarriedCreatedAt =>
      typeof c === "object" && c !== null &&
      typeof (c as CarriedCreatedAt).name === "string" &&
      isVersion((c as CarriedCreatedAt).version) &&
      typeof (c as CarriedCreatedAt).createdAt === "string"
    ).map(({ name, version, createdAt }) => ({ name, version, createdAt })),
  };
  return parsed.versions.length === versions.length &&
      parsed.digests.length === digests.length &&
      parsed.createdAt.length === createdAt.length
    ? parsed
    : undefined;
}

/**
 * found when a flush that landed the commit was cut off before recording it;
 * queued versions pair with landed ones in op order, and a restatement is not
 * one of the queued versions
 */
export function carryOfLanded(
  queued: Commit,
  landed: Commit,
): OfflineRebaseCarry {
  const queuedVersions = queued.ops.filter((op): op is DataVersionOp =>
    op.kind === "data-version"
  );
  const landedVersions = landed.ops.filter((op): op is DataVersionOp =>
    op.kind === "data-version" &&
    op.metadata.tags[RESTATES_TAG] === undefined
  );
  const versions: RenumberedVersion[] = [];
  const createdAt: CarriedCreatedAt[] = [];
  const digests: (readonly [string, string])[] = [];
  const metadataDigest = (commit: Commit, key: RecordKey) => {
    const put = commit.ops.find((op): op is PutOp =>
      op.kind === "put" && op.key.equals(key)
    );
    return put?.sha256;
  };
  for (let i = 0; i < queuedVersions.length; i++) {
    const before = queuedVersions[i];
    const after = landedVersions[i];
    if (after === undefined || after.metadata.name !== before.metadata.name) {
      break;
    }
    const name = before.metadata.name;
    versions.push({
      name,
      from: before.metadata.version,
      to: after.metadata.version,
    });
    createdAt.push({
      name,
      version: after.metadata.version,
      createdAt: after.metadata.createdAt,
    });
    const from = metadataDigest(queued, before.key);
    const to = metadataDigest(landed, after.key);
    if (from !== undefined && to !== undefined && from !== to) {
      digests.push([from, to]);
    }
  }
  return { versions, digests, createdAt };
}

export interface OfflineRebaseOptions {
  readonly encodeMetadata: (metadata: DataMetadata) => Uint8Array;
  readonly restate?: boolean;
  readonly windowMs?: number;
  readonly carry?: OfflineRebaseCarry;
  /**
   * The versions of `name` the partition's other offline commits, still
   * queued, hold by their queued numbers: a renumbered version never lands
   * on one, so a queued number never names two versions.
   */
  readonly reserved?: (name: string) => ReadonlySet<number>;
}

export interface RenumberedVersion {
  readonly name: string;
  readonly from: number;
  readonly to: number;
}

export type RestateSkipped =
  | "disabled"
  /** serve would not let the flush name the content */
  | "content-not-provided"
  | "content-unknown"
  | "renamed"
  | "lifecycle";

export type LatestOutcome =
  | {
    readonly name: string;
    readonly kind: "rebased";
    readonly version: number;
    readonly restateSkipped?: RestateSkipped;
  }
  | {
    readonly name: string;
    readonly kind: "restated";
    readonly version: number;
    readonly restates: number;
  };

export type RebasedCommit =
  | { readonly kind: "unchanged"; readonly commit: Commit }
  | {
    readonly kind: "rebased";
    readonly commit: Commit;
    readonly changes: readonly TypedChange[];
    readonly renumbered: readonly RenumberedVersion[];
    readonly latest: readonly LatestOutcome[];
    readonly carry: OfflineRebaseCarry;
  }
  /** A removal whose target changed; the whole commit is kept, not sent. */
  | {
    readonly kind: "rejected";
    readonly commit: Commit;
    readonly reason: "target-changed";
    readonly detail: string;
  };

interface NameState {
  highWater: number;
  readonly live: Set<number>;
  latest: number | undefined;
  readonly observedAt: Map<number, number | undefined>;
  readonly sources: Map<number, number>;
  readonly content: Map<number, VersionContent>;
  readonly createdAt: Map<number, string>;
}

export async function rebaseOfflineCommits(
  commits: readonly Commit[],
  partition: Partition,
  lookups: OfflineRebaseLookups,
  options: OfflineRebaseOptions,
): Promise<RebasedCommit[]> {
  const carry = options.carry ?? EMPTY_REBASE_CARRY;
  const names = new Map<string, NameState>();
  const stateOf = (name: string): NameState => {
    let state = names.get(name);
    if (state === undefined) {
      state = {
        highWater: partition.highWater(name),
        live: new Set(partition.versions(name)),
        latest: partition.latest(name),
        observedAt: new Map(),
        sources: new Map(),
        content: new Map(),
        createdAt: new Map(
          carry.createdAt
            .filter((carried) => carried.name === name)
            .map((carried) => [carried.version, carried.createdAt]),
        ),
      };
      names.set(name, state);
    }
    return state;
  };
  const mapped = new Map<string, Map<number, number>>();
  for (const version of carry.versions) {
    const all = mapped.get(version.name) ?? new Map<number, number>();
    all.set(version.from, version.to);
    mapped.set(version.name, all);
  }
  /** Metadata digests rewritten so far: an append's expect follows them. */
  const digests = new Map<string, string>(carry.digests);
  const records = new Map<string, string | null>();
  const results: RebasedCommit[] = [];
  for (const commit of commits) {
    if (!commit.partition.equals(partition.key)) {
      throw new Error(
        `Commit ${commit.txnId} is for ${commit.partition}, not ${partition.key}`,
      );
    }
    results.push(
      await rebaseOne(commit, partition, lookups, options, {
        stateOf,
        mapped,
        digests,
        records,
      }),
    );
  }
  return results;
}

interface FlushState {
  readonly stateOf: (name: string) => NameState;
  readonly mapped: Map<string, Map<number, number>>;
  readonly digests: Map<string, string>;
  readonly records: Map<string, string | null>;
}

async function rebaseOne(
  commit: Commit,
  partition: Partition,
  lookups: OfflineRebaseLookups,
  options: OfflineRebaseOptions,
  flush: FlushState,
): Promise<RebasedCommit> {
  const identity = commit.partition.identity;
  if (identity.kind !== "model") return { kind: "unchanged", commit };
  const appended = new Set<string>();
  for (const op of commit.ops) {
    if (op.kind === "put" && op.intent.kind === "data.append") {
      appended.add(nameVersion(op.intent.name, op.intent.version));
    }
  }
  const recorded = commit.ops.filter((op): op is DataVersionOp =>
    op.kind === "data-version"
  );
  const fresh = recorded.filter((op) =>
    !appended.has(nameVersion(op.metadata.name, op.metadata.version))
  );
  if (
    fresh.length === 0 &&
    !commit.ops.some((op) => touchesFlushVersion(op, flush.mapped)) &&
    !commit.ops.some((op) =>
      op.kind === "tombstone" && versionOf(op) !== undefined
    )
  ) {
    return { kind: "unchanged", commit };
  }

  const local = new Map<string, Map<number, number>>();
  const renumbered: RenumberedVersion[] = [];
  const freshByName = new Map<string, number[]>();
  for (const op of fresh) {
    const list = freshByName.get(op.metadata.name) ?? [];
    list.push(op.metadata.version);
    freshByName.set(op.metadata.name, list);
  }
  for (const [name, versions] of freshByName) {
    const state = flush.stateOf(name);
    let next = state.highWater + 1;
    const numbers = new Map<number, number>();
    const reserved = options.reserved?.(name);
    for (const version of [...new Set(versions)].sort((a, b) => a - b)) {
      let to = Math.max(version, next);
      while (to !== version && reserved?.has(to) === true) to++;
      numbers.set(version, to);
      next = to + 1;
      renumbered.push({ name, from: version, to });
    }
    local.set(name, numbers);
  }
  const remap = (name: string, version: number): number =>
    local.get(name)?.get(version) ?? flush.mapped.get(name)?.get(version) ??
      version;

  for (const op of commit.ops) {
    if (op.kind !== "tombstone") continue;
    const target = versionOf(op);
    if (target === undefined) continue;
    const version = remap(target.name, target.version);
    const state = flush.stateOf(target.name);
    if (!state.live.has(version)) {
      return {
        kind: "rejected",
        commit,
        reason: "target-changed",
        detail: `version ${target.version} of ${target.name} is no longer live`,
      };
    }
    if (op.expect !== undefined && op.expect !== "present") {
      const key = rekey(op.key, version);
      const now = flush.records.has(key.toString())
        ? flush.records.get(key.toString())
        : partition.record(key)?.sha256;
      const expected = flush.digests.get(op.expect.sha256) ?? op.expect.sha256;
      if (now !== expected) {
        return {
          kind: "rejected",
          commit,
          reason: "target-changed",
          detail: `version ${target.version} of ${target.name} changed`,
        };
      }
    }
  }

  // each version lands with its new number and, if written offline, the
  // corrected time it ran, so its observation time survives landing; an append
  // keeps that version's corrected time
  const executedAt = correctedExecutionTime(
    commit.executedAt ?? commit.at,
    commit.clockOffsetMs,
  );
  const correctedCreatedAt = executedAt === undefined
    ? undefined
    : new Date(executedAt).toISOString();
  const metadataOf = new Map<string, DataMetadata>();
  const rewritten = new Set<string>();
  for (const op of recorded) {
    const name = op.metadata.name;
    const version = remap(name, op.metadata.version);
    const isFresh = !appended.has(nameVersion(name, op.metadata.version));
    const createdAt = isFresh
      ? correctedCreatedAt ?? op.metadata.createdAt
      : flush.stateOf(name).createdAt.get(version) ?? op.metadata.createdAt;
    const key = rekey(op.key, version).toString();
    metadataOf.set(key, { ...op.metadata, version, createdAt });
    if (
      version !== op.metadata.version || createdAt !== op.metadata.createdAt
    ) {
      rewritten.add(key);
    }
  }

  const changes: TypedChange[] = [];
  const digests = new Map<string, string>();
  for (const op of commit.ops) {
    changes.push(
      await rewrite(op, commit, remap, {
        metadataOf,
        rewritten,
        options,
        flush,
        digests,
      }),
    );
  }

  const type = ModelType.create(identity.type);
  const model = new ModelChanges(type, identity.id);
  const latest: LatestOutcome[] = [];
  for (const [name, numbers] of local) {
    const state = flush.stateOf(name);
    const top = maxOf(numbers.values());
    if (top === undefined) continue;
    const topMetadata = metadataOf.get(
      model.dataKey(name, top, "metadata.yaml").toString(),
    );
    for (const to of numbers.values()) {
      state.live.add(to);
      state.observedAt.set(to, executedAt);
      if (correctedCreatedAt !== undefined) {
        state.createdAt.set(to, correctedCreatedAt);
      }
    }
    state.highWater = Math.max(state.highWater, top);
    for (const op of commit.ops) {
      if (op.kind !== "put" || !isRawKeyOf(op.key, name)) continue;
      const version = keyVersion(op.key);
      if (version === undefined) continue;
      const to = remap(name, version);
      const meta = metadataOf.get(
        model.dataKey(name, to, "metadata.yaml").toString(),
      );
      if (meta !== undefined) {
        state.content.set(to, {
          raw: op.content,
          ...(op.access === undefined ? {} : { rawAccess: op.access }),
          metadata: meta,
        });
      }
    }
    const current = state.latest;
    // A rename's marker, or a version past its life, is not a new latest.
    if (
      current === undefined || current > top ||
      topMetadata?.renamedTo !== undefined
    ) {
      if (current === undefined || top > current) state.latest = top;
      if (state.latest === top) {
        latest.push({ name, kind: "rebased", version: top });
      }
      continue;
    }
    const currentObservedAt = state.observedAt.has(current)
      ? state.observedAt.get(current)
      : observationTimeOf(current, (v) => lookups.observation(name, v));
    const choice = chooseLatest({
      rebasedObservedAt: executedAt,
      currentObservedAt,
      windowMs: options.windowMs,
    });
    if (choice === "rebased") {
      state.latest = top;
      latest.push({ name, kind: "rebased", version: top });
      continue;
    }
    const skipped = restateSkip(name, current, state, lookups, options);
    if (skipped.kind === "skip") {
      state.latest = top;
      latest.push({
        name,
        kind: "rebased",
        version: top,
        restateSkipped: skipped.reason,
      });
      continue;
    }
    const source = state.sources.get(current) ??
      sourceVersionOf(current, (v) => lookups.observation(name, v));
    const version = state.highWater + 1;
    const metadata: DataMetadata = {
      ...skipped.content.metadata,
      version,
      tags: {
        ...skipped.content.metadata.tags,
        [RESTATES_TAG]: String(source),
      },
    };
    const intent = createIntent({
      kind: "data.save",
      model: modelRef(type, identity.id),
      name,
      version,
    });
    const metadataKey = model.dataKey(name, version, "metadata.yaml");
    // The commit's own marker for this name gives way to the restatement's.
    for (let i = changes.length - 1; i >= 0; i--) {
      if (isLatestMarkerOf(changes[i], model, name)) changes.splice(i, 1);
    }
    changes.push(
      {
        partition: commit.partition,
        op: await putOp({
          intent,
          key: model.dataKey(name, version, "raw"),
          ...skipped.content.raw,
          ...(skipped.content.rawAccess === undefined
            ? {}
            : { access: skipped.content.rawAccess }),
        }),
      },
      {
        partition: commit.partition,
        put: {
          intent,
          key: metadataKey,
          content: options.encodeMetadata(metadata),
        },
      },
      {
        partition: commit.partition,
        op: dataVersionOp({ key: metadataKey, metadata }),
      },
      model.latestPut(
        { kind: "data.save" },
        name,
        version,
        new TextEncoder().encode(String(version)),
      ),
    );
    state.highWater = version;
    state.live.add(version);
    state.latest = version;
    state.observedAt.set(version, currentObservedAt);
    state.sources.set(version, source);
    state.content.set(version, { ...skipped.content, metadata });
    latest.push({ name, kind: "restated", version, restates: source });
  }

  for (const op of commit.ops) {
    if (op.kind === "tombstone") {
      const target = versionOf(op);
      if (target !== undefined) {
        const version = remap(target.name, target.version);
        const state = flush.stateOf(target.name);
        state.live.delete(version);
        if (state.latest === version) {
          state.latest = maxOf(state.live);
        }
      }
    }
  }
  for (const change of changes) {
    if ("op" in change && change.op.kind === "put") {
      flush.records.set(change.op.key.toString(), change.op.sha256);
    } else if ("op" in change && change.op.kind === "tombstone") {
      flush.records.set(change.op.key.toString(), null);
    } else if ("put" in change) {
      const content = change.put.content;
      if (content instanceof Uint8Array) {
        flush.records.set(change.put.key.toString(), await sha256Hex(content));
      }
    }
  }
  for (const [from, to] of digests) flush.digests.set(from, to);
  for (const [name, numbers] of local) {
    const all = flush.mapped.get(name) ?? new Map<number, number>();
    for (const [from, to] of numbers) all.set(from, to);
    flush.mapped.set(name, all);
  }
  const carried: OfflineRebaseCarry = {
    versions: renumbered,
    digests: [...digests],
    createdAt: correctedCreatedAt === undefined ? [] : renumbered.map((
      version,
    ) => ({
      name: version.name,
      version: version.to,
      createdAt: correctedCreatedAt,
    })),
  };
  return {
    kind: "rebased",
    commit,
    changes,
    renumbered,
    latest,
    carry: carried,
  };
}

interface RewriteContext {
  readonly metadataOf: Map<string, DataMetadata>;
  readonly rewritten: Set<string>;
  readonly options: OfflineRebaseOptions;
  readonly flush: FlushState;
  readonly digests: Map<string, string>;
}

async function rewrite(
  op: Op,
  commit: Commit,
  remap: (name: string, version: number) => number,
  context: RewriteContext,
): Promise<TypedChange> {
  const partition = commit.partition;
  const { flush } = context;
  switch (op.kind) {
    case "data-version": {
      const version = remap(op.metadata.name, op.metadata.version);
      const key = rekey(op.key, version);
      const metadata = context.metadataOf.get(key.toString());
      if (!context.rewritten.has(key.toString()) || metadata === undefined) {
        return { partition, op };
      }
      return { partition, op: dataVersionOp({ key, metadata }) };
    }
    case "tombstone": {
      const target = versionOf(op);
      if (target === undefined) return { partition, op };
      const version = remap(target.name, target.version);
      if (version === target.version) return { partition, op };
      return {
        partition,
        op: tombstoneOp({
          intent: withVersion(op.intent, version),
          key: rekey(op.key, version),
          ...(op.expect === undefined ? {} : {
            expect: op.expect === "present" ? "present" : {
              sha256: flush.digests.get(op.expect.sha256) ??
                op.expect.sha256,
            },
          }),
        }),
      };
    }
    case "put":
      return await rewritePut(op, partition, remap, context);
    case "lease":
      return { partition, op };
  }
}

async function rewritePut(
  op: PutOp,
  partition: Commit["partition"],
  remap: (name: string, version: number) => number,
  context: RewriteContext,
): Promise<TypedChange> {
  const { flush, options, digests } = context;
  const segments = op.key.toString().split("/");
  const last = segments[segments.length - 1];
  const expect = op.expect === undefined || op.expect === "absent"
    ? op.expect
    : { sha256: flush.digests.get(op.expect.sha256) ?? op.expect.sha256 };
  if (segments[0] === "data" && last === "latest" && "inline" in op.content) {
    const name = segments[segments.length - 2];
    const marked = Number(atob(op.content.inline).trim());
    const version = Number.isSafeInteger(marked) && marked > 0
      ? remap(name, marked)
      : marked;
    const intent = remapIntent(op.intent, remap);
    if (version === marked && intent === op.intent) return { partition, op };
    return {
      partition,
      op: await putOp({
        intent,
        key: op.key,
        inline: btoa(String(version)),
        ...(expect === undefined ? {} : { expect }),
        ...(op.access === undefined ? {} : { access: op.access }),
      }),
    };
  }
  const keyed = dataKeyVersion(op.key);
  if (keyed === undefined) return { partition, op };
  const version = remap(keyed.name, keyed.version);
  const intent = remapIntent(op.intent, remap);
  const key = rekey(op.key, version);
  const metadataChanged = keyed.file === "metadata.yaml" &&
    context.rewritten.has(key.toString());
  if (version === keyed.version && intent === op.intent && !metadataChanged) {
    return { partition, op };
  }
  if (metadataChanged) {
    const metadata = context.metadataOf.get(key.toString());
    if (metadata !== undefined) {
      const content = options.encodeMetadata(metadata);
      digests.set(op.sha256, await sha256Hex(content));
      return {
        partition,
        put: {
          intent,
          key,
          content,
          ...(expect === undefined ? {} : { expect }),
          ...(op.access === undefined ? {} : { access: op.access }),
        },
      };
    }
  }
  return {
    partition,
    op: await putOp({
      intent,
      key,
      ...op.content,
      ...(expect === undefined ? {} : { expect }),
      ...(op.access === undefined ? {} : { access: op.access }),
    }),
  };
}

function restateSkip(
  name: string,
  current: number,
  state: NameState,
  lookups: OfflineRebaseLookups,
  options: OfflineRebaseOptions,
):
  | { readonly kind: "skip"; readonly reason: RestateSkipped }
  | { readonly kind: "restate"; readonly content: VersionContent } {
  if (options.restate === false) return { kind: "skip", reason: "disabled" };
  const content = state.content.get(current) ?? lookups.content(name, current);
  if (content === undefined) {
    return { kind: "skip", reason: "content-unknown" };
  }
  if (content.metadata.renamedTo !== undefined) {
    return { kind: "skip", reason: "renamed" };
  }
  if (content.metadata.lifecycle !== undefined) {
    return { kind: "skip", reason: "lifecycle" };
  }
  return { kind: "restate", content };
}

function nameVersion(name: string, version: number): string {
  return `${version}:${name}`;
}

function dataKeyVersion(
  key: RecordKey,
):
  | {
    readonly name: string;
    readonly version: number;
    readonly file: "raw" | "metadata.yaml";
  }
  | undefined {
  const segments = key.toString().split("/");
  const file = segments[segments.length - 1];
  if (segments[0] !== "data" || (file !== "raw" && file !== "metadata.yaml")) {
    return undefined;
  }
  const version = Number(segments[segments.length - 2]);
  if (!Number.isSafeInteger(version) || version < 1) return undefined;
  return { name: segments[segments.length - 3], version, file };
}

function keyVersion(key: RecordKey): number | undefined {
  return dataKeyVersion(key)?.version;
}

function isRawKeyOf(key: RecordKey, name: string): boolean {
  const parsed = dataKeyVersion(key);
  return parsed !== undefined && parsed.file === "raw" && parsed.name === name;
}

function rekey(key: RecordKey, version: number): RecordKey {
  const segments = key.toString().split("/");
  if (dataKeyVersion(key) === undefined) return key;
  segments[segments.length - 2] = String(version);
  return RecordKey.create(segments.join("/"));
}

function versionOf(
  op: TombstoneOp,
): { readonly name: string; readonly version: number } | undefined {
  const intent = op.intent;
  if (
    (intent.kind !== "data.delete" && intent.kind !== "data.gc") ||
    intent.version === undefined || dataKeyVersion(op.key) === undefined
  ) {
    return undefined;
  }
  return { name: intent.name, version: intent.version };
}

function touchesFlushVersion(
  op: Op,
  mapped: Map<string, Map<number, number>>,
): boolean {
  if (op.kind === "data-version") {
    return mapped.get(op.metadata.name)?.has(op.metadata.version) ?? false;
  }
  if (op.kind === "lease") return false;
  const version = intentVersion(op.intent);
  return version !== undefined &&
    (mapped.get(intentName(op.intent))?.has(version) ?? false);
}

function intentVersion(intent: Intent): number | undefined {
  return (intent.kind === "data.save" || intent.kind === "data.append" ||
      intent.kind === "data.delete" || intent.kind === "data.gc")
    ? intent.version
    : undefined;
}

function intentName(intent: Intent): string {
  return "name" in intent ? intent.name : "";
}

function remapIntent(
  intent: Intent,
  remap: (name: string, version: number) => number,
): Intent {
  const version = intentVersion(intent);
  if (version === undefined) return intent;
  const to = remap(intentName(intent), version);
  return to === version ? intent : withVersion(intent, to);
}

function withVersion(intent: Intent, version: number): Intent {
  return createIntent({ ...intent, version });
}

function isLatestMarkerOf(
  change: TypedChange,
  model: ModelChanges,
  name: string,
): boolean {
  const key = "op" in change
    ? (change.op.kind === "put" ? change.op.key : undefined)
    : change.put.key;
  return key !== undefined && key.equals(model.latestKey(name));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
