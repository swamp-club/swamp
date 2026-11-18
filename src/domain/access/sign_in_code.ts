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

import { generateOpaqueToken } from "../remote/session_credential.ts";

export const SIGN_IN_CODE_PREFIX = "swsc1";
export const SIGN_IN_CODE_TTL_MS = 60_000;
export const MAX_SIGN_IN_CODES = 10_000;
export const MAX_SIGN_IN_CODES_PER_PRINCIPAL = 20;

export interface SignInGrant {
  readonly principal: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly collectives: readonly string[];
  readonly groups: readonly string[];
  /** the root token's expiry, which a workspace token never outlives */
  readonly expiresAt: string;
}

export type SignInCodeIssue =
  | { readonly ok: true; readonly code: string; readonly expiresAt: string }
  | { readonly ok: false; readonly reason: "principal_limit" | "store_full" };

/** unknown: no such code; refused: a code issued here, but expired or bound to another workspace */
export type SignInCodeRedeem =
  | { readonly kind: "redeemed"; readonly grant: SignInGrant }
  | { readonly kind: "unknown" }
  | { readonly kind: "refused"; readonly grant: SignInGrant };

export interface SignInCodeStoreOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxCodes?: number;
  readonly maxPerPrincipal?: number;
}

interface Entry {
  readonly workspace: string;
  readonly grant: SignInGrant;
  readonly expiresAtMs: number;
}

async function codeHash(code: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code),
  );
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * held in this process alone and keyed by hash, so no plaintext is kept; a code
 * is gone after its first redeem or its expiry, whichever comes first
 */
export class SignInCodeStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxCodes: number;
  readonly #maxPerPrincipal: number;

  constructor(options: SignInCodeStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? SIGN_IN_CODE_TTL_MS;
    this.#maxCodes = options.maxCodes ?? MAX_SIGN_IN_CODES;
    this.#maxPerPrincipal = options.maxPerPrincipal ??
      MAX_SIGN_IN_CODES_PER_PRINCIPAL;
  }

  async issue(workspace: string, grant: SignInGrant): Promise<SignInCodeIssue> {
    const code = `${SIGN_IN_CODE_PREFIX}.${generateOpaqueToken()}`;
    const hash = await codeHash(code);
    const now = this.#now();
    this.#sweep(now);
    if (this.#entries.size >= this.#maxCodes) {
      return { ok: false, reason: "store_full" };
    }
    let held = 0;
    for (const entry of this.#entries.values()) {
      if (
        entry.grant.principal === grant.principal && entry.expiresAtMs > now
      ) {
        held++;
      }
    }
    if (held >= this.#maxPerPrincipal) {
      return { ok: false, reason: "principal_limit" };
    }
    const expiresAtMs = now + this.#ttlMs;
    this.#entries.set(hash, {
      workspace,
      grant: {
        ...grant,
        collectives: [...grant.collectives],
        groups: [...grant.groups],
      },
      expiresAtMs,
    });
    return { ok: true, code, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async redeem(code: string, workspace: string): Promise<SignInCodeRedeem> {
    const hash = await codeHash(code);
    // read and removed with no await between: of two redeems, one finds it
    const entry = this.#entries.get(hash);
    this.#entries.delete(hash);
    const now = this.#now();
    this.#sweep(now);
    if (entry === undefined) return { kind: "unknown" };
    if (
      entry.expiresAtMs <= now || entry.workspace !== workspace ||
      !(Date.parse(entry.grant.expiresAt) > now)
    ) {
      return { kind: "refused", grant: entry.grant };
    }
    return { kind: "redeemed", grant: entry.grant };
  }

  get size(): number {
    return this.#entries.size;
  }

  // entries expire in the order they were issued, so the sweep stops at the first live one
  #sweep(now: number): void {
    for (const [hash, entry] of this.#entries) {
      if (entry.expiresAtMs > now) return;
      this.#entries.delete(hash);
    }
  }
}
