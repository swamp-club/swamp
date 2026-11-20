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

import type { AppLaunchKey } from "../domain/apps/app_launch.ts";
import type { VaultProvider } from "../domain/vaults/vault_provider.ts";

export const APP_LAUNCH_KEY_SECRET = "serve-app-launch-key";

export const APP_LAUNCH_KEY_CACHE_MS = 10_000;

export const APP_LAUNCH_KEY_STALE_MS = 60_000;

const KEY_PATTERN = /^[0-9a-f]{64}$/;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    hex.match(/../g) ?? [],
    (pair) => parseInt(pair, 16),
  );
}

/** Every serve instance sharing the control plane signs with the same key. */
export class VaultAppLaunchKey implements AppLaunchKey {
  readonly #vault: VaultProvider;
  readonly #now: () => number;
  #cached: { key: string; at: number } | undefined;
  #lastRead:
    | { at: number; found: "key" | "none" | "failed"; read: number }
    | undefined;
  /** Reads started, so a slow read never overwrites a newer one's answer. */
  #reads = 0;
  #reading: { at: number; answer: Promise<string | undefined> } | undefined;

  constructor(vault: VaultProvider, now: () => number = Date.now) {
    this.#vault = vault;
    this.#now = now;
  }

  // made only when none is stored; the vault has no create-if-absent, so racing
  // instances can both put and a launch signed with the losing key is refused.
  // A failed read throws, so a passing vault error never replaces the key.
  async signing(): Promise<Uint8Array<ArrayBuffer>> {
    const existing = await this.#read();
    if (existing !== undefined) return hexToBytes(existing);
    await this.#vault.put(
      APP_LAUNCH_KEY_SECRET,
      Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
    );
    const made = await this.#read();
    if (made === undefined) {
      throw new Error("The app launch key could not be stored");
    }
    return hexToBytes(made);
  }

  // read at most every APP_LAUNCH_KEY_CACHE_MS; checks wait on a read in flight
  async verifying(): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const key = await this.#known();
    return key === undefined ? undefined : hexToBytes(key);
  }

  // a cached key survives failed reads for APP_LAUNCH_KEY_STALE_MS; no key refuses all
  async #known(): Promise<string | undefined> {
    const last = this.#lastRead;
    if (last !== undefined && this.#now() - last.at < APP_LAUNCH_KEY_CACHE_MS) {
      return last.found === "none" ? undefined : this.#usableCached();
    }
    const reading = this.#reading;
    if (
      reading !== undefined &&
      this.#now() - reading.at < APP_LAUNCH_KEY_CACHE_MS
    ) {
      return await reading.answer;
    }
    // a read that has not answered within the window is left to its waiters
    const answer = this.#refresh().finally(() => {
      if (this.#reading?.answer === answer) this.#reading = undefined;
    });
    this.#reading = { at: this.#now(), answer };
    return await answer;
  }

  async #refresh(): Promise<string | undefined> {
    try {
      return await this.#read();
    } catch {
      return this.#usableCached();
    }
  }

  #usableCached(): string | undefined {
    const cached = this.#cached;
    if (cached === undefined) return undefined;
    return this.#now() - cached.at <
        APP_LAUNCH_KEY_CACHE_MS + APP_LAUNCH_KEY_STALE_MS
      ? cached.key
      : undefined;
  }

  // a failure or non-key value throws, never reads as no key; a newer read wins
  async #read(): Promise<string | undefined> {
    const read = ++this.#reads;
    try {
      const key = await this.#readKey();
      this.#record(read, key === undefined ? "none" : "key", key);
      return key;
    } catch (error) {
      this.#record(read, "failed");
      throw error;
    }
  }

  #record(
    read: number,
    found: "key" | "none" | "failed",
    key?: string,
  ): void {
    const last = this.#lastRead;
    if (last !== undefined && last.read > read && last.found !== "failed") {
      return;
    }
    const at = this.#now();
    if (key !== undefined) this.#cached = { key, at };
    this.#lastRead = { at, found, read };
  }

  async #readKey(): Promise<string | undefined> {
    let value: string;
    try {
      value = await this.#vault.get(APP_LAUNCH_KEY_SECRET);
    } catch (error) {
      if ((await this.#vault.list()).includes(APP_LAUNCH_KEY_SECRET)) {
        throw error;
      }
      return undefined;
    }
    const key = value.trim();
    if (!KEY_PATTERN.test(key)) {
      throw new Error("The app launch key in the vault is not a valid key");
    }
    return key;
  }
}

/** the local dashboard's child is one process, and its launches die with it */
export class EphemeralAppLaunchKey implements AppLaunchKey {
  readonly #key: Uint8Array<ArrayBuffer> = crypto.getRandomValues(
    new Uint8Array(32),
  );

  signing(): Promise<Uint8Array<ArrayBuffer>> {
    return Promise.resolve(this.#key);
  }

  verifying(): Promise<Uint8Array<ArrayBuffer> | undefined> {
    return Promise.resolve(this.#key);
  }
}
