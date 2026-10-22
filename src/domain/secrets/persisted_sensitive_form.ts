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
import {
  jsonEscaped,
  restoreScalar,
  SECRET_ENCODINGS,
  type SecretEncoding,
} from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  definedEntry,
  type RunSensitiveValues,
  type SecretSource,
  vaultReferenceText,
} from "./run_sensitive_values.ts";

/** A path into a persisted structure: object keys and array indexes. */
export type DataPath = readonly (string | number)[];

/**
 * One place where a persisted file holds a vault reference instead of the
 * sensitive value swamp wrote there. Rehydration uses only these entries, so
 * reference text that arrives as data elsewhere stays inert.
 */
export interface WrittenReference {
  path: (string | number)[];
  /** Which occurrence of the reference text in the string at `path`, from 0. */
  occurrence: number;
  vaultName: string;
  key: string;
  /**
   * How the value was written: `raw` text, `json` for its JSON-escaped form
   * inside JSON text, or a whole `number`/`boolean` leaf a coercion produced.
   */
  encoding: SecretEncoding;
  /** Whether the value reached the file through a data read. */
  dataOrigin: boolean;
}

/** Validates `writtenReferences` read back from a repo-local file. */
export const WrittenReferenceSchema = z.object({
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  occurrence: z.number().int().nonnegative(),
  vaultName: z.string().min(1),
  key: z.string().min(1),
  encoding: z.enum(SECRET_ENCODINGS),
  dataOrigin: z.boolean(),
});

/**
 * Version of the persisted sensitive-value format. A cache or run record
 * without it was written before sensitive values were kept off disk. Version
 * 1 wrote every sensitive value as its vault reference. Version 2 also writes
 * the mask where a sensitive argument held a value that came from no vault,
 * and records those positions in the evaluated definition's `maskedPaths`
 * (swamp-club#3681). A reader at version 1 would run the mask as the value,
 * so a reader refuses a format newer than its own; see
 * `isNewerSensitiveFormat`.
 */
export const SENSITIVE_FORMAT_VERSION = 2;

/** Data ready to persist, and where it holds references. */
export interface PersistedForm<T> {
  data: T;
  writtenReferences: WrittenReference[];
}

interface Segment {
  text: string;
  /** Never searched: written reference text or a sentinel kept as is. */
  locked?: boolean;
  /** Set when this segment is written reference text. */
  written?: Omit<WrittenReference, "path" | "occurrence"> & { ref: string };
}

/**
 * Builds the form of `data` to write to disk. Every sentinel the run issued
 * (`values.sentinels`) becomes the vault reference its entry names, with the
 * entry's encoding and data-origin flag, so no value is looked up for a
 * sentinel; sentinel-shaped text with a prefix the run never drew is data
 * and is written as it is. At the positions `applies` accepts, so does
 * every recorded sensitive value: whole or embedded in a string,
 * JSON-escaped, or a whole number or boolean leaf whose text equals one.
 * That value search exists for plaintext that legacy data reads still bring
 * into CEL; a typed run records no value and takes every entry from its
 * sentinels (typed-secrets 4.4), and 4.6 deletes the search.
 * Structural fields are never touched because `applies` never accepts
 * them. Text inside inserted references is never searched.
 */
export function toPersistedForm<T>(
  data: T,
  values: RunSensitiveValues,
  options: {
    applies: (path: DataPath) => boolean;
  },
): PersistedForm<T> {
  const writtenReferences: WrittenReference[] = [];
  const registry = values.sentinels;
  // A typed run records no value, so the search finds nothing; a value a
  // legacy path still records is written as its reference all the same, as
  // defence in depth, whatever the registry.
  const searchesValues = !values.isEmpty;
  if (values.isEmpty && registry.isEmpty) return { data, writtenReferences };
  const entries = values.list();

  const escapedSource = new Map<string, SecretSource>();
  for (const { value, source } of entries) {
    const escaped = jsonEscaped(value);
    if (escaped !== value) escapedSource.set(escaped, source);
  }

  /** The reference a sentinel is written as, from its entry. */
  const referenceOf = (sentinel: string): Segment["written"] => {
    const entry = registry.issuedEntryOf(sentinel);
    if (!entry) {
      throw new Error(
        registry.entryOf(sentinel)
          ? "A secret bag entry without a reference cannot be persisted"
          : "A vault secret sentinel of this run has no entry, so its reference cannot be written",
      );
    }
    return {
      ref: vaultReferenceText(entry.reference),
      vaultName: entry.reference.vaultName,
      key: entry.reference.key,
      encoding: entry.encoding,
      dataOrigin: entry.dataOrigin,
    };
  };

  /** The reference a recorded plaintext value is written as, by search. */
  const referenceFor = (secret: string): Segment["written"] | undefined => {
    const direct = values.sourceOf(secret);
    const source = direct ?? escapedSource.get(secret);
    if (!source) return undefined;
    return {
      ref: vaultReferenceText(source),
      vaultName: source.vaultName,
      key: source.key,
      encoding: direct ? "raw" : "json",
      dataOrigin: false,
    };
  };

  const persistString = (text: string, path: DataPath): string => {
    // Sentinels first: exact splice positions, each from its entry.
    let segments: Segment[] = [];
    let last = 0;
    for (const match of text.matchAll(VaultSecretBag.SENTINEL_PATTERN)) {
      const start = match.index ?? 0;
      if (start > last) segments.push({ text: text.slice(last, start) });
      const written = registry.drewPrefixOf(match[0])
        ? referenceOf(match[0])
        : undefined;
      segments.push(
        written
          ? { text: written.ref, written, locked: true }
          : { text: match[0], locked: true },
      );
      last = start + match[0].length;
    }
    if (last < text.length) segments.push({ text: text.slice(last) });

    if (searchesValues && options.applies(path)) {
      const forms: string[] = [];
      for (const { value } of entries) {
        forms.push(value);
        const escaped = jsonEscaped(value);
        if (escaped !== value) forms.push(escaped);
      }
      for (const form of forms) {
        const written = referenceFor(form);
        if (!written) continue;
        segments = segments.flatMap((segment) => {
          if (segment.locked) return [segment];
          if (!segment.text.includes(form)) return [segment];
          const out: Segment[] = [];
          segment.text.split(form).forEach((part, i) => {
            if (i > 0) out.push({ text: written.ref, written, locked: true });
            if (part) out.push({ text: part });
          });
          return out;
        });
      }
    }

    let out = "";
    for (const segment of segments) {
      if (segment.written) {
        const { ref, ...rest } = segment.written;
        writtenReferences.push({
          path: [...path],
          occurrence: countOccurrences(out, ref),
          ...rest,
        });
      }
      out += segment.text;
    }
    return out;
  };

  const walk = (value: unknown, path: DataPath): unknown => {
    if (typeof value === "string") return persistString(value, path);
    if (
      (typeof value === "number" || typeof value === "boolean") &&
      searchesValues && options.applies(path)
    ) {
      const source = values.sourceOf(String(value));
      if (source) {
        const ref = vaultReferenceText(source);
        writtenReferences.push({
          path: [...path],
          occurrence: 0,
          vaultName: source.vaultName,
          key: source.key,
          encoding: typeof value === "number" ? "number" : "boolean",
          dataOrigin: false,
        });
        return ref;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, [...path, index]));
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        definedEntry(result, key, walk(item, [...path, key]));
      }
      return result;
    }
    return value;
  };

  return { data: walk(data, []) as T, writtenReferences };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (
    let i = text.indexOf(needle);
    i !== -1;
    i = text.indexOf(needle, i + 1)
  ) {
    count++;
  }
  return count;
}

/** Resolves a vault key to its current value. */
export type VaultReader = (vaultName: string, key: string) => Promise<string>;

/** The vault reserved for swamp's own token secrets, never rehydrated. */
const RESERVED_VAULT = "_token-secrets";

/**
 * Restores the written references of an existing file as sentinels, reading
 * no vault (typed-secrets 4.4, design/enablers/typed-secrets.md Section
 * 8.1): each entry becomes a sentinel `bag` issues for its reference, with
 * the file's encoding and origin, spliced where the reference text sits, so
 * the run binds a reference where it held one and a delivery loads the
 * current value under current authorization. Only the listed entries are
 * touched: reference text anywhere else stays as it is, and a hand-edited
 * path through a prototype touches nothing. A reference to the reserved
 * token vault is refused before any sentinel is issued. `label` names the
 * record (a definition or workflow name, or a run id) in each entry's
 * location, for a failed load's error. The returned copy is the only copy:
 * a typed run has no raw and sanitized pair, because every position holds
 * the sentinel.
 */
export function rehydrateReferences<T>(
  data: T,
  writtenReferences: readonly WrittenReference[],
  bag: VaultSecretBag,
  label: string,
): T {
  if (writtenReferences.length === 0) return data;
  for (const entry of writtenReferences) {
    if (entry.vaultName === RESERVED_VAULT) {
      throw new Error(
        `Refusing to restore a reference to the reserved vault ${RESERVED_VAULT}`,
      );
    }
  }
  const restored = structuredClone(data) as T;
  // Highest occurrence first, so earlier indexes stay valid per string.
  const ordered = [...writtenReferences].sort((a, b) =>
    b.occurrence - a.occurrence
  );
  for (const entry of ordered) {
    const sentinel = bag.addWrittenReference(
      { vaultName: entry.vaultName, key: entry.key },
      entry.encoding,
      entry.dataOrigin,
      `${label}: ${spellPath(entry.path)}`,
    );
    replaceAt(restored, entry, vaultReferenceText(entry), sentinel);
  }
  return restored;
}

/**
 * The legacy branch of rehydration, for an untyped registry: restores the
 * values behind `writtenReferences` into two copies of `data`, reading each
 * from the vault. typed-secrets 4.6 (swamp-club#3735) deletes it with the
 * value search once every run is typed; a typed run restores through
 * {@link rehydrateReferences}.
 *
 * It restores the values into two copies of `data`:
 * `raw` with the real values, `sanitized` with data-origin sentinels issued
 * from `bag` at the paths `sanitizes` accepts (the positions a fresh run
 * sanitizes) and the real values elsewhere. Without a bag both copies hold
 * the real values. Each value is recorded
 * in `values` with its vault source. Only the listed entries are touched;
 * reference text anywhere else stays as it is.
 */
export async function rehydratePersistedForm<T>(
  data: T,
  writtenReferences: readonly WrittenReference[],
  read: VaultReader,
  values: RunSensitiveValues,
  bag?: VaultSecretBag,
  sanitizes: (path: DataPath) => boolean = () => true,
): Promise<{ raw: T; sanitized: T }> {
  if (writtenReferences.length === 0) return { raw: data, sanitized: data };
  const raw = structuredClone(data) as T;
  const sanitized = structuredClone(data) as T;

  // Highest occurrence first, so earlier indexes stay valid per string.
  const ordered = [...writtenReferences].sort((a, b) =>
    b.occurrence - a.occurrence
  );
  for (const entry of ordered) {
    if (entry.vaultName === RESERVED_VAULT) {
      throw new Error(
        `Refusing to restore a reference to the reserved vault ${RESERVED_VAULT}`,
      );
    }
    const value = await read(entry.vaultName, entry.key);
    values.addSecret(value, { vaultName: entry.vaultName, key: entry.key });
    const ref = vaultReferenceText(entry);
    const text = entry.encoding === "json" ? jsonEscaped(value) : value;
    const restore = (target: unknown, replacement: unknown) =>
      replaceAt(target, entry, ref, replacement);
    if (entry.encoding === "number" || entry.encoding === "boolean") {
      const leaf = restoreScalar(
        entry.encoding,
        value,
        entry,
        spellPath(entry.path),
      );
      restore(raw, leaf);
      restore(sanitized, leaf);
    } else {
      restore(raw, text);
      // Every restored reference becomes a data-origin sentinel. The flag
      // cannot choose the origin yet: an entry the value search wrote
      // carries `dataOrigin: false` for plaintext a data read brought into
      // CEL, and no vault.get sentinel reaches a persisted position (the
      // caches are written before the runtime pass, and the overlay holds
      // only data-origin entries).
      restore(
        sanitized,
        bag && sanitizes(entry.path)
          ? bag.addDataSecret(
            text,
            { vaultName: entry.vaultName, key: entry.key },
            entry.encoding,
          )
          : text,
      );
    }
  }
  return { raw, sanitized };
}

/** A written entry's path in dotted form, for a load's errors. */
function spellPath(path: DataPath): string {
  return path.map((segment) =>
    typeof segment === "number" ? `[${segment}]` : segment
  ).join(".").replaceAll(".[", "[");
}

function replaceAt(
  root: unknown,
  entry: WrittenReference,
  ref: string,
  replacement: unknown,
): void {
  if (entry.path.length === 0) return;
  let parent = root as Record<string | number, unknown>;
  for (const segment of entry.path.slice(0, -1)) {
    // Own properties only, so a path through a prototype touches nothing.
    if (parent === null || typeof parent !== "object") return;
    if (!Object.hasOwn(parent, segment)) return;
    const next = parent[segment];
    if (next === null || typeof next !== "object") return;
    parent = next as Record<string | number, unknown>;
  }
  const leafKey = entry.path[entry.path.length - 1];
  if (parent === null || typeof parent !== "object") return;
  if (!Object.hasOwn(parent, leafKey)) return;
  const current = parent[leafKey];
  if (typeof current !== "string") return;
  if (typeof replacement !== "string") {
    if (current === ref) parent[leafKey] = replacement;
    return;
  }
  let index = -1;
  for (let n = 0; n <= entry.occurrence; n++) {
    index = current.indexOf(ref, index + 1);
    if (index === -1) return;
  }
  parent[leafKey] = current.slice(0, index) + replacement +
    current.slice(index + ref.length);
}
