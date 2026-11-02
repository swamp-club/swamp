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

import { z } from "zod";
import { InputRecordSchema } from "../inputs/input_record.ts";
import { vaultReferenceText } from "../secrets/run_sensitive_values.ts";
import {
  holdsValue,
  type SecretBagRegistry,
} from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";

/**
 * A `[start, end)` character range of a string that came from data.
 * Mirrored in src/domain/vaults/shell_data_placement.ts, which may not
 * depend on expressions; keep the two the same.
 */
export type DataRange = readonly [number, number];

/**
 * an expression found in a later pass is authored only if it does not overlap
 * data; the map holds ranges and paths, never text, so it can be persisted
 * safely
 */
export class ProvenanceMap {
  static readonly #empty = new ProvenanceMap(new Set(), new Map(), new Set());
  static readonly #whole = new ProvenanceMap(
    new Set([""]),
    new Map(),
    new Set(),
  );

  private constructor(
    private readonly whole: ReadonlySet<string>,
    private readonly ranges: ReadonlyMap<string, readonly DataRange[]>,
    private readonly keys: ReadonlySet<string>,
  ) {}

  /**
   * A map built in one pass from whole-data paths, per-string ranges and
   * the paths of objects whose own keys are data. Linear in the input,
   * where repeated withRanges/withWholeData calls would copy the map each
   * time.
   */
  static fromEntries(
    whole: Iterable<string>,
    ranges: Iterable<readonly [string, readonly DataRange[]]>,
    keys: Iterable<string> = [],
  ): ProvenanceMap {
    const merged = new Map<string, readonly DataRange[]>();
    for (const [path, value] of ranges) {
      merged.set(path, mergeRanges([...(merged.get(path) ?? []), ...value]));
    }
    return ProvenanceMap.of(new Set(whole), merged, new Set(keys));
  }

  static authored(): ProvenanceMap {
    return ProvenanceMap.#empty;
  }

  static data(): ProvenanceMap {
    return ProvenanceMap.#whole;
  }

  get isAuthored(): boolean {
    return this.whole.size === 0 && this.ranges.size === 0 &&
      this.keys.size === 0;
  }

  get isWholeData(): boolean {
    return this.whole.has("");
  }

  isWholeDataAt(path: string): boolean {
    for (const ancestor of ancestorsOf(canonicalPath(path))) {
      if (this.whole.has(ancestor)) return true;
    }
    return false;
  }

  hasDataKeysAt(path: string): boolean {
    return this.isWholeDataAt(path) || this.keys.has(canonicalPath(path));
  }

  /**
   * Whether `[start, end)` of the string at `path` overlaps data. Partial
   * overlap counts: text spliced next to authored text must never complete
   * an expression across the boundary.
   */
  overlapsData(path: string, start: number, end: number): boolean {
    if (this.isWholeDataAt(path)) return true;
    for (const [s, e] of this.ranges.get(canonicalPath(path)) ?? []) {
      if (s < end && start < e) return true;
    }
    return false;
  }

  hasDataAtOrBelow(path: string): boolean {
    if (this.isWholeDataAt(path)) return true;
    return this.dataAncestors().has(canonicalPath(path));
  }

  #dataAncestors: Set<string> | undefined;
  private dataAncestors(): Set<string> {
    if (this.#dataAncestors) return this.#dataAncestors;
    const ancestors = new Set<string>();
    for (const key of [...this.whole, ...this.ranges.keys(), ...this.keys]) {
      for (const ancestor of ancestorsOf(key)) {
        if (ancestors.has(ancestor)) break;
        ancestors.add(ancestor);
      }
    }
    this.#dataAncestors = ancestors;
    return ancestors;
  }

  rangesAt(path: string): readonly DataRange[] {
    return this.ranges.get(canonicalPath(path)) ?? [];
  }

  subtree(path: string): ProvenanceMap {
    path = canonicalPath(path);
    if (path === "") return this;
    if (this.isWholeDataAt(path)) return ProvenanceMap.#whole;
    const whole = new Set<string>();
    const ranges = new Map<string, readonly DataRange[]>();
    const keys = new Set<string>();
    for (const key of this.whole) {
      if (isAtOrUnder(key, path)) whole.add(reroot(key, path));
    }
    for (const [key, value] of this.ranges) {
      if (isAtOrUnder(key, path)) ranges.set(reroot(key, path), value);
    }
    for (const key of this.keys) {
      if (isAtOrUnder(key, path)) keys.add(reroot(key, path));
    }
    return ProvenanceMap.of(whole, ranges, keys);
  }

  graft(path: string, sub: ProvenanceMap): ProvenanceMap {
    path = canonicalPath(path);
    const whole = new Set<string>();
    const ranges = new Map<string, readonly DataRange[]>();
    const keys = new Set<string>();
    for (const key of this.whole) {
      if (!isAtOrUnder(key, path)) whole.add(key);
    }
    for (const [key, value] of this.ranges) {
      if (!isAtOrUnder(key, path)) ranges.set(key, value);
    }
    for (const key of this.keys) {
      if (!isAtOrUnder(key, path)) keys.add(key);
    }
    for (const key of sub.whole) whole.add(prefix(path, key));
    for (const [key, value] of sub.ranges) ranges.set(prefix(path, key), value);
    for (const key of sub.keys) keys.add(prefix(path, key));
    return ProvenanceMap.of(whole, ranges, keys);
  }

  /**
   * {@link graft} for many disjoint paths at once, in one pass: everything at
   * or below each path is replaced by its map. Linear in the size of the
   * maps, where repeated grafts would copy the map each time.
   */
  graftAll(
    entries: readonly (readonly [string, ProvenanceMap])[],
  ): ProvenanceMap {
    if (entries.length === 0) return this;
    if (entries.length === 1) return this.graft(entries[0][0], entries[0][1]);
    entries = entries.map(([path, sub]) => [canonicalPath(path), sub] as const);
    const targets = new Set(entries.map(([path]) => path));
    const replaced = (key: string) => {
      for (const ancestor of ancestorsOf(key)) {
        if (targets.has(ancestor)) return true;
      }
      return false;
    };
    const whole = new Set<string>();
    const ranges = new Map<string, readonly DataRange[]>();
    const keys = new Set<string>();
    for (const key of this.whole) if (!replaced(key)) whole.add(key);
    for (const [key, value] of this.ranges) {
      if (!replaced(key)) ranges.set(key, value);
    }
    for (const key of this.keys) if (!replaced(key)) keys.add(key);
    for (const [path, sub] of entries) {
      for (const key of sub.whole) whole.add(prefix(path, key));
      for (const [key, value] of sub.ranges) {
        ranges.set(prefix(path, key), value);
      }
      for (const key of sub.keys) keys.add(prefix(path, key));
    }
    return ProvenanceMap.of(whole, ranges, keys);
  }

  withWholeData(path: string): ProvenanceMap {
    return this.graft(path, ProvenanceMap.#whole);
  }

  withRanges(path: string, ranges: readonly DataRange[]): ProvenanceMap {
    path = canonicalPath(path);
    const merged = mergeRanges(ranges);
    const next = this.graft(path, ProvenanceMap.#empty);
    if (merged.length === 0) return next;
    const all = new Map(next.ranges);
    all.set(path, merged);
    return ProvenanceMap.of(next.whole, all, next.keys);
  }

  union(other: ProvenanceMap): ProvenanceMap {
    if (other.isAuthored) return this;
    if (this.isAuthored) return other;
    const whole = new Set([...this.whole, ...other.whole]);
    const ranges = new Map<string, readonly DataRange[]>(this.ranges);
    for (const [key, value] of other.ranges) {
      ranges.set(key, mergeRanges([...(ranges.get(key) ?? []), ...value]));
    }
    return ProvenanceMap.of(
      whole,
      ranges,
      new Set([...this.keys, ...other.keys]),
    );
  }

  paths(): string[] {
    return [
      ...new Set([...this.whole, ...this.ranges.keys(), ...this.keys]),
    ];
  }

  mapPaths(rename: (path: string) => string): ProvenanceMap {
    const whole = new Set<string>();
    const ranges = new Map<string, readonly DataRange[]>();
    const keys = new Set<string>();
    for (const key of this.whole) whole.add(rename(key));
    for (const [key, value] of this.ranges) {
      const renamed = rename(key);
      ranges.set(
        renamed,
        mergeRanges([...(ranges.get(renamed) ?? []), ...value]),
      );
    }
    for (const key of this.keys) keys.add(rename(key));
    return ProvenanceMap.of(whole, ranges, keys);
  }

  /**
   * Serialisable form: paths and ranges only. `keys` is written only when
   * an object's keys are data, so a map written before the field existed
   * reads back as it was written.
   */
  toData(): ProvenanceMapData {
    return {
      whole: [...this.whole].sort(),
      ranges: Object.fromEntries(
        [...this.ranges].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map((
            [key, value],
          ) => [key, value.map(([s, e]) => [s, e] as [number, number])]),
      ),
      ...(this.keys.size > 0 ? { keys: [...this.keys].sort() } : {}),
    };
  }

  static fromData(data: unknown): ProvenanceMap {
    const parsed = ProvenanceMapDataSchema.parse(data);
    const ranges = new Map<string, readonly DataRange[]>();
    for (const [key, value] of Object.entries(parsed.ranges)) {
      ranges.set(key, mergeRanges(value.map(([s, e]) => [s, e] as const)));
    }
    return ProvenanceMap.of(
      new Set(parsed.whole),
      ranges,
      new Set(parsed.keys ?? []),
    );
  }

  private static of(
    wholeIn: ReadonlySet<string>,
    rangesIn: ReadonlyMap<string, readonly DataRange[]>,
    keysIn: ReadonlySet<string>,
  ): ProvenanceMap {
    const whole = new Set([...wholeIn].map(canonicalPath));
    const ranges = new Map<string, readonly DataRange[]>();
    for (const [key, value] of rangesIn) {
      const path = canonicalPath(key);
      ranges.set(
        path,
        ranges.has(path)
          ? mergeRanges([...ranges.get(path)!, ...value])
          : value,
      );
    }
    if (whole.has("")) return ProvenanceMap.#whole;
    const underWhole = (key: string) =>
      [...ancestorsOf(key)].some((a) => whole.has(a));
    const pruned = new Map<string, readonly DataRange[]>();
    for (const [key, value] of ranges) {
      if (value.length === 0) continue;
      if (underWhole(key)) continue;
      pruned.set(key, value);
    }
    const keys = new Set<string>();
    for (const key of keysIn) {
      const path = canonicalPath(key);
      if (!underWhole(path)) keys.add(path);
    }
    if (whole.size === 0 && pruned.size === 0 && keys.size === 0) {
      return ProvenanceMap.#empty;
    }
    return new ProvenanceMap(whole, pruned, keys);
  }
}

export interface DirectInputsProvenance {
  inputs: ProvenanceMap;
  globalArgs: ProvenanceMap;
}

/**
 * Where data sits in the routed global arguments: each key keeps the map of
 * the value it was routed from, and a key whose value coercion changed is
 * data in its entirety when any of it was data.
 */
export function routedGlobalProvenance(
  routedGlobals: Record<string, unknown>,
  sources: Record<string, unknown>,
  sourceMap: ProvenanceMap,
): ProvenanceMap {
  let map = ProvenanceMap.authored();
  for (const [key, value] of Object.entries(routedGlobals)) {
    const keyMap = sourceMap.subtree(keySegment(key));
    if (keyMap.isAuthored) continue;
    map = map.graft(
      keySegment(key),
      JSON.stringify(value) === JSON.stringify(sources[key])
        ? keyMap
        : ProvenanceMap.data(),
    );
  }
  return map;
}

export interface ProvenanceMapData {
  whole: string[];
  ranges: Record<string, [number, number][]>;
  keys?: string[];
}

const DataRangesSchema = z.array(
  z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .refine(([s, e]) => s <= e, { message: "range start after end" }),
);

export const ProvenanceMapDataSchema = z.object({
  whole: z.array(z.string()),
  keys: z.array(z.string()).optional(),
  // A path may itself be __proto__. Dropping it would turn data-origin
  // characters into authored text when persisted inputs are restored.
  ranges: InputRecordSchema.transform((record, ctx) => {
    const entries: [string, [number, number][]][] = [];
    for (const [path, ranges] of Object.entries(record)) {
      const parsed = DataRangesSchema.safeParse(ranges);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [path, ...issue.path] });
        }
        return z.NEVER;
      }
      entries.push([path, parsed.data]);
    }
    return Object.fromEntries(entries);
  }),
});

export function mergeRanges(ranges: readonly DataRange[]): DataRange[] {
  const sorted = ranges.filter(([s, e]) => e > s).map(([s, e]) =>
    [s, e] as [number, number]
  ).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * folds an unquoted .[ into [ so an extracted key like x.[0] and a prefixed
 * x[0] are one path; an index and such a key then share an entry, which can
 * only mark more as data
 */
export function canonicalPath(path: string): string {
  if (!path.includes(".[")) return path;
  // Only an unquoted `.[` is folded: a JSON-quoted key (`["a.[b"]`) is
  // already unambiguous, and folding inside it could merge two distinct keys.
  let out = "";
  let quoted = false;
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (quoted) {
      out += c;
      if (c === "\\") out += path[++i] ?? "";
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    if (c === "." && path[i + 1] === "[") continue;
    out += c;
  }
  return out;
}

/**
 * keys with . [ ] " or empty are JSON-quoted so they can never read as a nested
 * path or index; expression extraction and provenance share this rule
 */
export function keySegment(key: string): string {
  return key !== "" && !/[.[\]"]/.test(key) ? key : `[${JSON.stringify(key)}]`;
}

export function keyPath(parent: string, key: string): string {
  return prefix(parent, keySegment(key));
}

export function methodArgumentPath(method: string, key: string): string {
  return keyPath(keyPath(keyPath("", "methods"), method) + ".arguments", key);
}

export function indexPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

function segmentBoundaries(path: string): number[] {
  const boundaries: number[] = [];
  let quoted = false;
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if ((c === "." || c === "[") && i > 0) boundaries.push(i);
  }
  return boundaries;
}

export function* ancestorsOf(path: string): Generator<string> {
  yield path;
  if (!path.includes('"')) {
    for (let i = path.length - 1; i > 0; i--) {
      const c = path[i];
      if (c === "." || c === "[") yield path.slice(0, i);
    }
  } else {
    const boundaries = segmentBoundaries(path);
    for (let i = boundaries.length - 1; i >= 0; i--) {
      yield path.slice(0, boundaries[i]);
    }
  }
  if (path !== "") yield "";
}

export function isAtOrUnder(path: string, root: string): boolean {
  if (root === "") return true;
  return path === root || path.startsWith(root + ".") ||
    path.startsWith(root + "[");
}

function reroot(path: string, root: string): string {
  if (path === root) return "";
  const rest = path.slice(root.length);
  return rest.startsWith(".") ? rest.slice(1) : rest;
}

export function prefix(root: string, path: string): string {
  if (root === "") return path;
  if (path === "") return root;
  return path.startsWith("[") ? root + path : `${root}.${path}`;
}

export type SentinelResolver = (sentinel: string) => string | undefined;

/**
 * stands in a data entry for the value and a vault reference for identity,
 * reading no vault. Pass it for both copies, or a sentinel from an earlier pass
 * or its rehomed twin would make them differ.
 */
export function sentinelStandInOf(
  registry: SecretBagRegistry,
): SentinelResolver {
  const identity = sentinelIdentityOf(registry);
  return (sentinel) => {
    const entry = registry.entryOf(sentinel);
    if (entry === undefined) return undefined;
    return holdsValue(entry) ? entry.value : identity(sentinel);
  };
}

/**
 * Stands each sentinel `registry` issued in for what it references, without
 * reading its value: two sentinels for one entry, as a sentinel and its
 * rehomed copy in another bag, read alike, and the copies align wherever
 * both hold sentinels.
 */
export function sentinelIdentityOf(
  registry: SecretBagRegistry,
): SentinelResolver {
  return (sentinel) => {
    const entry = registry.issuedEntryOf(sentinel);
    if (!entry) return undefined;
    const { vaultName, key } = entry.reference;
    return `${vaultName}\u0000${key}\u0000${entry.encoding}\u0000${
      entry.dataOrigin ? "data" : "vault"
    }`;
  };
}

/**
 * maps each sentinel to the reference text the persisted form writes, so a
 * persisted copy and a sentinel copy resolve to one text and their ranges align
 * whatever the sentinel lengths
 */
export function sentinelReferenceTextOf(
  registry: SecretBagRegistry,
): SentinelResolver {
  return (sentinel) => {
    const entry = registry.issuedEntryOf(sentinel);
    return entry === undefined
      ? undefined
      : vaultReferenceText(entry.reference);
  };
}

const SENTINEL = new RegExp(VaultSecretBag.SENTINEL_PATTERN.source, "g");

interface Segment {
  start: number;
  end: number;
  rawStart: number;
  rawEnd: number;
  sentinel: boolean;
}

function resolveSegments(
  text: string,
  resolve: SentinelResolver | undefined,
): { segments: Segment[]; raw: string } {
  const segments: Segment[] = [];
  let raw = "";
  let last = 0;
  const literal = (end: number) => {
    if (end <= last) return;
    segments.push({
      start: last,
      end,
      rawStart: raw.length,
      rawEnd: raw.length + (end - last),
      sentinel: false,
    });
    raw += text.slice(last, end);
  };
  if (resolve) {
    for (const match of text.matchAll(SENTINEL)) {
      const value = resolve(match[0]);
      if (value === undefined) continue;
      literal(match.index!);
      segments.push({
        start: match.index!,
        end: match.index! + match[0].length,
        rawStart: raw.length,
        rawEnd: raw.length + value.length,
        sentinel: true,
      });
      raw += value;
      last = match.index! + match[0].length;
    }
  }
  literal(text.length);
  return { segments, raw };
}

function mapThroughSegments(
  ranges: readonly DataRange[],
  segments: readonly Segment[],
  toRaw: boolean,
): DataRange[] {
  const out: DataRange[] = [];
  for (const [s, e] of ranges) {
    for (const seg of segments) {
      const [from, to] = toRaw
        ? [seg.start, seg.end]
        : [seg.rawStart, seg.rawEnd];
      if (to <= s || from >= e) continue;
      if (seg.sentinel) {
        // A sentinel and the value it stands for are data together.
        out.push(toRaw ? [seg.rawStart, seg.rawEnd] : [seg.start, seg.end]);
        continue;
      }
      const offset = toRaw
        ? seg.rawStart - seg.start
        : seg.start - seg.rawStart;
      out.push([Math.max(s, from) + offset, Math.min(e, to) + offset]);
    }
  }
  return mergeRanges(out);
}

/**
 * Data ranges of `a` carried onto `b`, two copies of one string whose
 * sentinels resolve to the same raw text: each range is mapped to the raw
 * text and back, and a sentinel touching data is data in full. Without
 * resolvers, or when the copies do not resolve alike, the single differing
 * span is aligned instead (see {@link alignRanges}).
 */
export function alignStrings(
  ranges: readonly DataRange[],
  a: string,
  b: string,
  resolveA?: SentinelResolver,
  resolveB?: SentinelResolver,
): DataRange[] {
  if (resolveA || resolveB) {
    const left = resolveSegments(a, resolveA);
    const right = resolveSegments(b, resolveB);
    if (left.raw === right.raw) {
      return mapThroughSegments(
        mapThroughSegments(ranges, left.segments, true),
        right.segments,
        false,
      );
    }
  }
  return alignRanges(ranges, a, b);
}

/**
 * Data ranges of `a` carried onto `b`, two versions of one string that differ
 * only in one middle span (a sentinel or vault reference in place of a
 * spliced value). Ranges before the span keep their offsets, ranges after it
 * shift by the length change, and the differing span is data whenever it
 * touches data — so authored text elsewhere in the string keeps its standing.
 */
function alignRanges(
  ranges: readonly DataRange[],
  a: string,
  b: string,
): DataRange[] {
  let prefix = 0;
  const shortest = Math.min(a.length, b.length);
  while (prefix < shortest && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const aEnd = a.length - suffix;
  const bEnd = b.length - suffix;
  const delta = b.length - a.length;
  const out: DataRange[] = [];
  let middle = false;
  for (const [s, e] of ranges) {
    if (e <= prefix) out.push([s, e]);
    else if (s >= aEnd) out.push([s + delta, e + delta]);
    else {
      middle = true;
      if (s < prefix) out.push([s, prefix]);
      if (e > aEnd) out.push([bEnd, e + delta]);
    }
  }
  if (middle) out.push([prefix, bEnd]);
  return mergeRanges(out);
}

/**
 * a differing string keeps its ranges around the one differing span, which is
 * data when it touches data; any other differing value holding data is wholly
 * data, so nothing can misalign into authored
 */
export function alignProvenance(
  map: ProvenanceMap,
  raw: unknown,
  other: unknown,
  resolveRaw?: SentinelResolver,
  resolveOther?: SentinelResolver,
): ProvenanceMap {
  if (map.isAuthored) return map;
  const differing: [string, ProvenanceMap][] = [];
  const visit = (a: unknown, b: unknown, path: string) => {
    if (a === b || !map.hasDataAtOrBelow(path)) return;
    const bothObjects = a !== null && b !== null && typeof a === "object" &&
      typeof b === "object" && Array.isArray(a) === Array.isArray(b);
    if (!bothObjects) {
      differing.push([
        path,
        typeof a === "string" && typeof b === "string" &&
          !map.isWholeDataAt(path)
          ? ProvenanceMap.authored().withRanges(
            "",
            alignStrings(map.rangesAt(path), a, b, resolveRaw, resolveOther),
          )
          : ProvenanceMap.data(),
      ]);
      return;
    }
    const keys = new Set([
      ...Object.keys(a as object),
      ...Object.keys(b as object),
    ]);
    for (const key of keys) {
      const child = Array.isArray(a)
        ? indexPath(path, Number(key))
        : keyPath(path, key);
      visit(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        child,
      );
    }
  };
  visit(raw, other, "");
  return map.graftAll(differing);
}
