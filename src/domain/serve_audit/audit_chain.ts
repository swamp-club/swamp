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

import type { AuditEvent, ChainedAuditEvent } from "./audit_event.ts";

export const CHAIN_SEED_DIGEST =
  "0000000000000000000000000000000000000000000000000000000000000000";

const encoder = new TextEncoder();

function sortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

function canonicalize(event: AuditEvent): string {
  const { version: _, sequence: __, digest: ___, ...rest } = event;
  return JSON.stringify(sortKeys(rest));
}

async function computeDigest(
  previousDigest: string,
  eventJson: string,
): Promise<string> {
  const input = previousDigest + eventJson;
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class AuditChainState {
  #sequence: number;
  #previousDigest: string;

  constructor(sequence = 0, previousDigest = CHAIN_SEED_DIGEST) {
    this.#sequence = sequence;
    this.#previousDigest = previousDigest;
  }

  get sequence(): number {
    return this.#sequence;
  }

  get previousDigest(): string {
    return this.#previousDigest;
  }

  snapshot(): { sequence: number; previousDigest: string } {
    return { sequence: this.#sequence, previousDigest: this.#previousDigest };
  }

  restore(snapshot: { sequence: number; previousDigest: string }): void {
    this.#sequence = snapshot.sequence;
    this.#previousDigest = snapshot.previousDigest;
  }

  async chain(event: AuditEvent): Promise<ChainedAuditEvent> {
    this.#sequence++;
    const canonical = canonicalize(event);
    const digest = await computeDigest(this.#previousDigest, canonical);
    this.#previousDigest = digest;
    return {
      ...event,
      version: 1,
      sequence: this.#sequence,
      digest,
    };
  }
}

export async function verifyChain(
  events: readonly ChainedAuditEvent[],
  startDigest = CHAIN_SEED_DIGEST,
): Promise<{ valid: boolean; brokenAt?: number }> {
  let previousDigest = startDigest;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const canonical = canonicalize(event);
    const expected = await computeDigest(previousDigest, canonical);
    if (event.digest !== expected) {
      return { valid: false, brokenAt: event.sequence };
    }
    previousDigest = event.digest;
  }
  return { valid: true };
}
