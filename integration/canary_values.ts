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

// Canary secrets for the typed-secrets boundary tests (swamp-club#3511).
//
// Generates synthetic secrets in every class design/enablers/typed-secrets.md
// Section 12.2 names, fresh for each run, plus a vault type that serves them
// and counts every read. The prohibited-sink scans that use these classes run
// black-box against the compiled binary in swamp-uat; this repository only
// checks the boundaries where plaintext is allowed.

import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import { SENTINEL_EXACT } from "../src/domain/vaults/secret_bag_registry.ts";

/**
 * The shortest value the redactor masks: `SecretRedactor.addSecret` ignores
 * anything shorter, counted in UTF-16 code units.
 */
export const REDACTOR_MIN_LENGTH = 3;

/** Every canary class Section 12.2 requires. */
export const CANARY_CLASSES = [
  "empty",
  "one-char",
  "two-char",
  "astral-pair",
  "bmp-unicode",
  "astral-unicode",
  "quotes",
  "backslash",
  "newline-lf",
  "newline-crlf",
  "reference-shaped",
  "sentinel-shaped",
  "placeholder-shaped",
  "mask-collision",
] as const;

export type CanaryClass = typeof CANARY_CLASSES[number];

/** A synthetic secret. */
export interface Canary {
  readonly class: CanaryClass;
  readonly value: string;
  /**
   * Whether the value is unique to this run. Values below the redactor
   * minimum cannot be; they are checked by exact delivery and value kind,
   * never by searching text for them.
   */
  readonly unique: boolean;
}

/**
 * The payload each unique class carries between its two random halves, so a
 * truncated or split copy still holds a searchable half.
 */
const PAYLOADS: Partial<Record<CanaryClass, string>> = {
  "bmp-unicode": "Ωλ€ñ",
  "astral-unicode": "😀𝄞",
  "quotes": `'"\``,
  "backslash": "\\\\n\\",
  "newline-lf": "\n",
  "newline-crlf": "\r\n",
  "reference-shaped": "${{ vault.get('v', 'k') }}",
  "sentinel-shaped": `__SWAMP_VSEC_${"deadbeef".repeat(4)}_0__`,
  "placeholder-shaped": "sensitive-v.k",
  "mask-collision": "***",
};

function randomHex(length: number): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, length);
}

function randomLetters(length: number): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => letters[b % letters.length]).join("");
}

/** One canary of `canaryClass`, fresh for this call. */
export function generateCanary(canaryClass: CanaryClass): Canary {
  switch (canaryClass) {
    case "empty":
      return { class: canaryClass, value: "", unique: false };
    case "one-char":
      return { class: canaryClass, value: randomLetters(1), unique: false };
    case "two-char":
      return { class: canaryClass, value: randomLetters(2), unique: false };
    case "astral-pair":
      // One astral character is two UTF-16 code units: below the minimum.
      return { class: canaryClass, value: "𝄞", unique: false };
    default: {
      const payload = PAYLOADS[canaryClass]!;
      return {
        class: canaryClass,
        value: `cnr${randomHex(10)}${payload}${randomHex(10)}`,
        unique: true,
      };
    }
  }
}

/** One canary of every class, fresh for this call. */
export function generateCanaries(): Canary[] {
  return CANARY_CLASSES.map(generateCanary);
}

/** Whether the redactor would ignore `canary` as too short. */
export function belowRedactorMinimum(canary: Canary): boolean {
  return canary.value.length < REDACTOR_MIN_LENGTH;
}

/** What a boundary or sink received in place of a canary. */
export type ValueKind =
  | "plaintext"
  | "sentinel"
  | "reference"
  | "placeholder"
  | "mask"
  | "absent"
  | "other";

const VAULT_REFERENCE =
  /^\$\{\{\s*vault\.get\(\s*'[^']*'\s*,\s*'[^']*'\s*\)\s*\}\}$/;
const PLACEHOLDER = /^sensitive-[^.\s]+\.\S+$/;

/**
 * The engine-1 kind of `observed`, judged against the canary it stands in
 * for. Exact equality wins, so a canary shaped like a sentinel, reference or
 * mask that arrives intact is plaintext.
 */
export function classifyValue(observed: unknown, canary: Canary): ValueKind {
  if (observed === undefined || observed === null) return "absent";
  if (observed === canary.value) return "plaintext";
  if (typeof observed !== "string") return "other";
  if (SENTINEL_EXACT.test(observed)) return "sentinel";
  if (VAULT_REFERENCE.test(observed)) return "reference";
  if (PLACEHOLDER.test(observed)) return "placeholder";
  if (observed === "***") return "mask";
  return "other";
}

/** One read the counting vault served. */
export interface VaultRead {
  vault: string;
  key: string;
}

/** A per-run vault type that serves canaries and counts every read. */
export interface CountingVault {
  /** The registered vault type, unique to this run. */
  readonly type: string;
  /** Every `get` served, in order. */
  readonly reads: readonly VaultRead[];
  /** Reads of `key` so far. */
  readsOf(key: string): number;
  /** Removes the type from the process-global registry. */
  dispose(): void;
}

/**
 * Registers a vault type under a per-run name whose provider serves
 * `secrets` and records each `get`. Call `dispose` in a `finally`.
 */
export function registerCountingVault(
  secrets: Record<string, string>,
): CountingVault {
  const type = `@test/canary-vault-${crypto.randomUUID()}`;
  const stored = new Map(Object.entries(secrets));
  const reads: VaultRead[] = [];
  vaultTypeRegistry.register({
    type,
    name: "Canary vault",
    description: "Serves canary secrets and counts reads",
    isBuiltIn: false,
    createProvider: (name: string) => ({
      get: (key: string) => {
        reads.push({ vault: name, key });
        const value = stored.get(key);
        // The message names the key only, never a value.
        if (value === undefined) {
          return Promise.reject(new Error(`no canary for key ${key}`));
        }
        return Promise.resolve(value);
      },
      put: (key: string, value: string) => {
        stored.set(key, value);
        return Promise.resolve();
      },
      list: () => Promise.resolve([...stored.keys()]),
      getName: () => name,
    }),
  });
  return {
    type,
    reads,
    readsOf: (key) => reads.filter((r) => r.key === key).length,
    dispose: () => vaultTypeRegistry.invalidateType(type),
  };
}
