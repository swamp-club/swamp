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
 * reads the filesystem and managed config registry, so repositories call it
 * only inside a stageTyped builder or behind typedStagingActive; v2 never runs
 * it
 */

import { basename, isAbsolute, relative, SEPARATOR } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  AutoDefinitionChanges,
  ConfigChanges,
  recordKeyOf,
} from "../../domain/datastore_v3/repository_changes.ts";
import type { DefinitionKind } from "../../domain/datastore_v3/partition_key.ts";
import type { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { getManagedConfigBase, SWAMP_SUBDIRS } from "./paths.ts";
import { markErrorPaths } from "../../domain/errors.ts";

/**
 * tier comes from the default datastore layout; honouring a repository's
 * configured directories and excludes is left to the v3 opt-in; git-tracked
 * files outside the datastore stage nothing
 */
export type StagingTier =
  | { readonly tier: "config"; readonly key: RecordKey }
  | { readonly tier: "auto"; readonly key: RecordKey };

export function stagingTierOf(
  repoDir: string,
  bases: readonly (string | undefined)[],
  path: string,
): StagingTier | undefined {
  const managed = getManagedConfigBase(repoDir);
  if (managed !== undefined && isWithinDir(path, managed)) {
    return { tier: "config", key: keyUnder("config", managed, path) };
  }
  for (const base of bases) {
    if (
      base !== undefined && basename(base) === SWAMP_SUBDIRS.autoDefinitions &&
      isWithinDir(path, base)
    ) {
      return {
        tier: "auto",
        key: keyUnder(SWAMP_SUBDIRS.autoDefinitions, base, path),
      };
    }
  }
  return undefined;
}

export function keyUnder(
  prefix: string,
  base: string,
  path: string,
): RecordKey {
  const rel = relative(base, path);
  if (rel === "" || !isWithinDir(path, base)) {
    throw markErrorPaths(new Error(`${path} is not a file inside ${base}`), [
      path,
      base,
    ]);
  }
  return recordKeyOf([prefix, ...rel.split(SEPARATOR)]);
}

/**
 * read from raw YAML without the schema, so a file another swamp version wrote
 * still names its aggregate
 */
export interface PriorFile {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly id?: string;
  readonly name?: string;
  readonly type?: string;
}

export async function readPriorFile(
  path: string,
): Promise<PriorFile | undefined> {
  let bytes: Uint8Array;
  try {
    const info = await Deno.stat(path);
    if (!info.isFile) return undefined;
    bytes = await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  return { bytes, sha256: await sha256Hex(bytes), ...declaredFields(bytes) };
}

export async function readPriors(
  paths: readonly (string | undefined)[],
): Promise<Map<string, PriorFile>> {
  const priors = new Map<string, PriorFile>();
  for (const path of new Set(paths)) {
    if (path === undefined) continue;
    const prior = await readPriorFile(path);
    if (prior !== undefined) priors.set(path, prior);
  }
  return priors;
}

function declaredFields(
  bytes: Uint8Array,
): { id?: string; name?: string; type?: string } {
  let parsed: unknown;
  try {
    parsed = parseYaml(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const fields: { id?: string; name?: string; type?: string } = {};
  for (const field of ["id", "name", "type"] as const) {
    const value = (parsed as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) fields[field] = value;
  }
  return fields;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * a file whose declared id, name or type cannot form a partition was never put
 * by any repository, so its removal stages nothing
 */
export function unlessUnpartitionable<T>(build: () => T): T | undefined {
  try {
    return build();
  } catch {
    return undefined;
  }
}

export interface DefinitionSave {
  readonly kind: DefinitionKind;
  readonly id: string;
  readonly name: string;
  readonly targetPath: string;
  readonly content: Uint8Array;
  readonly removed: readonly string[];
  readonly priors: ReadonlyMap<string, PriorFile>;
  readonly tierOf: (path: string) => StagingTier | undefined;
}

/**
 * batches in commit order: the written file in its tier with edit, rename or
 * create preconditions, then other names' removed files as tombstones, then
 * auto-definitions removed from another tier
 */
export function definitionSaveBatches(save: DefinitionSave): TypedChange[][] {
  const target = save.tierOf(save.targetPath);
  const prior = save.priors.get(save.targetPath);
  const removed = save.removed.flatMap((path) => {
    const tier = save.tierOf(path);
    return tier === undefined ? [] : [{
      tier,
      name: save.priors.get(path)?.name ?? save.name,
    }];
  });
  const config = removed.filter((r) => r.tier.tier === "config");
  const auto = removed.filter((r) => r.tier.tier === "auto");
  const batches: TypedChange[][] = [];
  // Old names, with the keys to tombstone in their partitions.
  const others = new Map<string, RecordKey[]>();
  const addOther = (name: string, key: RecordKey) =>
    others.set(name, [...(others.get(name) ?? []), key]);

  if (target?.tier === "config") {
    const changes = new ConfigChanges(save.kind, save.name);
    const same = config.filter((r) => r.name === save.name);
    for (const r of config) {
      if (r.name !== save.name) addOther(r.name, r.tier.key);
    }
    const targetOld = prior?.name !== undefined && prior.name !== save.name
      ? prior.name
      : undefined;
    if (targetOld !== undefined) addOther(targetOld, target.key);
    // A target that already holds this name is an edit of it, even when a
    // removed copy of the same id declared another name.
    const renamedFrom = targetOld ??
      (prior?.name === save.name ? undefined : others.keys().next().value);
    const put = renamedFrom !== undefined
      ? changes.renameTo(renamedFrom, target.key, save.content)
      : prior !== undefined
      ? changes.write(
        "definition.edit",
        target.key,
        save.content,
        prior.name === undefined ? undefined : { sha256: prior.sha256 },
      )
      : changes.write(
        same.length > 0 ? "definition.edit" : "definition.create",
        target.key,
        save.content,
        "absent",
      );
    batches.push([
      put,
      ...same.map((r) =>
        changes.remove("definition.edit", r.tier.key, "present")
      ),
    ]);
    for (const [name, keys] of others) {
      const old = new ConfigChanges(save.kind, name);
      batches.push(keys.map((key) => old.renameFrom(save.name, key)));
    }
  } else {
    if (target?.tier === "auto") {
      const changes = new AutoDefinitionChanges(save.id);
      batches.push([
        changes.write(target.key, save.content),
        ...auto.map((r) => changes.remove(r.tier.key)),
      ]);
    }
    for (const r of config) addOther(r.name, r.tier.key);
    for (const [name, keys] of others) {
      const old = new ConfigChanges(save.kind, name);
      batches.push(
        keys.map((key) => old.remove("definition.delete", key, "present")),
      );
    }
  }
  if (target?.tier !== "auto" && auto.length > 0) {
    const changes = new AutoDefinitionChanges(save.id);
    batches.push(auto.map((r) => changes.remove(r.tier.key)));
  }
  return batches;
}

/**
 * tombstones carry no precondition so a locally edited file stays deletable;
 * the commit-log unit sets the expected version for a delete of a definition
 * another checkout changed; unknown-name files stage nothing
 */
export function definitionDeleteBatches(remove: {
  readonly kind: DefinitionKind;
  readonly id: string;
  readonly name: string | undefined;
  readonly removed: readonly string[];
  readonly priors: ReadonlyMap<string, PriorFile>;
  readonly tierOf: (path: string) => StagingTier | undefined;
}): TypedChange[][] {
  const byPartition = new Map<string, TypedChange[]>();
  for (const path of remove.removed) {
    const tier = remove.tierOf(path);
    if (tier === undefined) continue;
    const name = remove.priors.get(path)?.name ?? remove.name;
    const change = tier.tier === "auto"
      ? unlessUnpartitionable(() =>
        new AutoDefinitionChanges(remove.id).remove(tier.key)
      )
      : name === undefined
      ? undefined
      : unlessUnpartitionable(() =>
        new ConfigChanges(remove.kind, name).remove(
          "definition.delete",
          tier.key,
        )
      );
    if (change === undefined) continue;
    const partition = change.partition.toString();
    byPartition.set(partition, [
      ...(byPartition.get(partition) ?? []),
      change,
    ]);
  }
  return [...byPartition.values()];
}

function isWithinDir(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) && !isAbsolute(rel));
}
