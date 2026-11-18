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

/** who a code was issued to, as the root knew them when it issued it */
export interface SignInGrant {
  /** `user:<id>`: only people sign in through the root */
  readonly principal: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly collectives: readonly string[];
  readonly groups: readonly string[];
  /** when the root token the code was issued under expires, as ISO 8601 */
  readonly expiresAt: string;
}

export type SignInCodeIssue =
  | { readonly ok: true; readonly code: string; readonly expiresAt: string }
  | { readonly ok: false; readonly reason: "principal_limit" | "store_full" };

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
 * the root's outstanding sign-in codes, held in this process alone: keyed by
 * hash so no plaintext is kept, and each one is gone after its first redeem
 * or its expiry, whichever comes first
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

  /** `workspace` is a name `parseWorkspaceName` already accepted */
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
      if (entry.grant.principal === grant.principal) held++;
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

  /** null for an unknown, used or expired code, or one another workspace's name was bound to */
  async redeem(code: string, workspace: string): Promise<SignInGrant | null> {
    const hash = await codeHash(code);
    // read and removed with no await between: of two redeems, one finds it
    const entry = this.#entries.get(hash);
    this.#entries.delete(hash);
    const now = this.#now();
    this.#sweep(now);
    if (entry === undefined || entry.expiresAtMs <= now) return null;
    if (entry.workspace !== workspace) return null;
    if (!(Date.parse(entry.grant.expiresAt) > now)) return null;
    return entry.grant;
  }

  get size(): number {
    return this.#entries.size;
  }

  #sweep(now: number): void {
    for (const [hash, entry] of this.#entries) {
      if (entry.expiresAtMs <= now) this.#entries.delete(hash);
    }
  }
}
