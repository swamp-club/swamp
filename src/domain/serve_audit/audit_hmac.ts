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

import type { AuditEvent } from "./audit_event.ts";

export interface HmacContext {
  readonly key: CryptoKey;
  readonly keyVersion: number;
}

export interface HmacKeyVersion {
  readonly version: number;
  readonly key: CryptoKey;
}

export class HmacKeyRegistry {
  readonly #versions: Map<number, CryptoKey> = new Map();
  #currentVersion: number;

  constructor(versions: HmacKeyVersion[]) {
    if (versions.length === 0) {
      throw new Error("HmacKeyRegistry requires at least one key version");
    }
    let maxVersion = 0;
    for (const v of versions) {
      this.#versions.set(v.version, v.key);
      if (v.version > maxVersion) maxVersion = v.version;
    }
    this.#currentVersion = maxVersion;
  }

  currentContext(): HmacContext {
    const key = this.#versions.get(this.#currentVersion);
    if (!key) {
      throw new Error(
        `Current key version ${this.#currentVersion} not found in registry`,
      );
    }
    return { key, keyVersion: this.#currentVersion };
  }

  contextForVersion(version: number): HmacContext | undefined {
    const key = this.#versions.get(version);
    if (!key) return undefined;
    return { key, keyVersion: version };
  }

  addVersion(version: number, key: CryptoKey): void {
    if (version <= this.#currentVersion) {
      throw new Error(
        `New key version ${version} must be greater than current version ${this.#currentVersion}`,
      );
    }
    this.#versions.set(version, key);
    this.#currentVersion = version;
  }

  get currentVersion(): number {
    return this.#currentVersion;
  }

  get versionCount(): number {
    return this.#versions.size;
  }

  versions(): number[] {
    return [...this.#versions.keys()].sort((a, b) => a - b);
  }
}

export interface HmacKeyProvider {
  getOrCreate(
    vaultName: string,
    keyName: string,
  ): Promise<{ key: Uint8Array; version: number }>;
}

const encoder = new TextEncoder();

export async function hmacField(
  key: CryptoKey,
  value: string,
): Promise<string> {
  const data = encoder.encode(value);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  const buf = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.importKey(
    "raw",
    buf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function applyHmac(
  ctx: HmacContext,
  event: AuditEvent,
): Promise<AuditEvent> {
  const resourceName = await hmacField(ctx.key, event.resourceName);
  const detail = event.detail !== undefined
    ? await hmacField(ctx.key, event.detail)
    : undefined;
  const methodName = event.methodName !== undefined
    ? await hmacField(ctx.key, event.methodName)
    : undefined;

  let decision = event.decision;
  if (decision) {
    const hashedResourceName = await hmacField(ctx.key, decision.resourceName);
    decision = { ...decision, resourceName: hashedResourceName };
  }

  return {
    ...event,
    resourceName,
    detail,
    methodName,
    decision,
    hmacKeyVersion: ctx.keyVersion,
  };
}

export async function generateHmacKeyBytes(): Promise<Uint8Array> {
  const key = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}
