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

import type { ChainedAuditEvent } from "./audit_event.ts";
import type { AuditStore } from "./audit_store.ts";
import { CHAIN_SEED_DIGEST, verifyChain } from "./audit_chain.ts";
import type { HmacKeyRegistry } from "./audit_hmac.ts";

const MAX_QUERY_LIMIT = 1000;
const MAX_DATE_RANGE_DAYS = 90;
const MAX_LOADED_EVENTS = 50_000;
const HMAC_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface AuditQueryFilters {
  readonly since?: string;
  readonly until?: string;
  readonly principal?: string;
  readonly category?: string;
  readonly action?: string;
  readonly outcome?: string;
  readonly resource?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly export?: boolean;
}

export type AuditStreamFilters = Omit<
  AuditQueryFilters,
  "limit" | "cursor" | "export"
>;

export interface AuditQueryResult {
  readonly events: readonly ChainedAuditEvent[];
  readonly cursor?: string;
  readonly total?: number;
}

export interface AuditVerifyResult {
  readonly valid: boolean;
  readonly eventsChecked: number;
  readonly brokenAt?: number;
  readonly message: string;
}

function dateRange(since?: string, until?: string): string[] {
  const start = since
    ? new Date(since)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const end = until ? new Date(until) : new Date();
  if (isNaN(start.getTime())) {
    throw new Error(`Invalid 'since' date: "${since}"`);
  }
  if (isNaN(end.getTime())) {
    throw new Error(`Invalid 'until' date: "${until}"`);
  }
  const dates: string[] = [];
  const current = new Date(start);
  current.setUTCHours(0, 0, 0, 0);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

async function loadEvents(
  store: AuditStore,
  dates: string[],
  maxEvents = MAX_LOADED_EVENTS,
): Promise<ChainedAuditEvent[]> {
  const events: ChainedAuditEvent[] = [];
  for (const date of dates) {
    const keys = await store.list(`events/${date}/`);
    for (const key of keys) {
      const data = await store.get(key);
      if (!data) continue;
      const text = new TextDecoder().decode(data);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as ChainedAuditEvent);
          if (events.length >= maxEvents) return events;
        } catch {
          // skip malformed lines
        }
      }
    }
  }
  return events;
}

function matchesFilters(
  event: ChainedAuditEvent,
  filters: AuditQueryFilters,
): boolean {
  if (filters.since && event.timestamp < filters.since) return false;
  if (filters.until && event.timestamp > filters.until) return false;
  if (filters.principal && event.principalId !== filters.principal) {
    return false;
  }
  if (filters.category && event.category !== filters.category) return false;
  if (filters.action && event.action !== filters.action) return false;
  if (filters.outcome && event.outcome !== filters.outcome) return false;
  if (
    filters.resource &&
    `${event.resourceKind}:${event.resourceName}` !== filters.resource
  ) {
    return false;
  }
  return true;
}

export class AuditQueryService {
  readonly #store: AuditStore;
  readonly #hmacKeyRegistry: HmacKeyRegistry | undefined;

  constructor(store: AuditStore, hmacKeyRegistry?: HmacKeyRegistry) {
    this.#store = store;
    this.#hmacKeyRegistry = hmacKeyRegistry;
  }

  async query(filters: AuditQueryFilters): Promise<AuditQueryResult> {
    const dates = dateRange(filters.since, filters.until);
    if (dates.length > MAX_DATE_RANGE_DAYS) {
      throw new Error(
        `Date range too wide: ${dates.length} days exceeds maximum of ${MAX_DATE_RANGE_DAYS}`,
      );
    }
    const allEvents = await loadEvents(this.#store, dates);

    allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const filtered = allEvents.filter((e) => matchesFilters(e, filters));

    let cursorIndex = 0;
    if (filters.cursor) {
      const idx = filtered.findIndex((e) => e.id === filters.cursor);
      if (idx === -1) {
        return { events: [], cursor: undefined, total: filtered.length };
      }
      cursorIndex = idx + 1;
    }

    const maxLimit = filters.export ? MAX_LOADED_EVENTS : MAX_QUERY_LIMIT;
    const limit = Math.min(filters.limit ?? 100, maxLimit);
    const page = filtered.slice(cursorIndex, cursorIndex + limit);
    const nextCursor = cursorIndex + limit < filtered.length
      ? filtered[cursorIndex + limit - 1]?.id
      : undefined;

    return {
      events: page,
      cursor: nextCursor,
      total: filtered.length,
    };
  }

  async verify(
    since?: string,
    until?: string,
  ): Promise<AuditVerifyResult> {
    const dates = dateRange(since, until);
    if (dates.length > MAX_DATE_RANGE_DAYS) {
      throw new Error(
        `Date range too wide: ${dates.length} days exceeds maximum of ${MAX_DATE_RANGE_DAYS}`,
      );
    }
    const allEvents = await loadEvents(this.#store, dates);

    const chainedEvents = allEvents.filter(
      (e): e is ChainedAuditEvent =>
        e.version === 1 &&
        typeof e.sequence === "number" &&
        typeof e.digest === "string",
    );

    chainedEvents.sort((a, b) => a.sequence - b.sequence);

    if (chainedEvents.length === 0) {
      return {
        valid: true,
        eventsChecked: 0,
        message: "No chained events found in the specified time range",
      };
    }

    const isPartialRange = chainedEvents[0].sequence > 1;

    if (isPartialRange && chainedEvents.length === 1) {
      return {
        valid: true,
        eventsChecked: 0,
        message: `Single event in partial range (sequence ${
          chainedEvents[0].sequence
        }) — chain continuity cannot be verified without adjacent events`,
      };
    }

    const eventsToVerify = isPartialRange
      ? chainedEvents.slice(1)
      : chainedEvents;
    const verifyStartDigest = isPartialRange
      ? chainedEvents[0].digest
      : CHAIN_SEED_DIGEST;

    const result = await verifyChain(eventsToVerify, verifyStartDigest);

    if (result.valid) {
      return {
        valid: true,
        eventsChecked: eventsToVerify.length,
        message:
          `Chain integrity verified: ${eventsToVerify.length} events, sequences ${
            chainedEvents[0].sequence
          }-${chainedEvents[chainedEvents.length - 1].sequence}`,
      };
    }

    return {
      valid: false,
      eventsChecked: eventsToVerify.length,
      brokenAt: result.brokenAt,
      message: `Chain integrity broken at sequence ${result.brokenAt}`,
    };
  }

  // Structural HMAC verification: checks that each event's hmacKeyVersion
  // references a known key and that all hashed fields (resourceName, detail,
  // methodName, decision.resourceName) match the expected 64-char hex format.
  // Full cryptographic re-verification is not possible because the original
  // plaintext is not stored alongside the hash.
  verifyHmac(
    events: readonly ChainedAuditEvent[],
  ): { valid: boolean; checked: number; failed: number } {
    if (!this.#hmacKeyRegistry) {
      return { valid: true, checked: 0, failed: 0 };
    }
    let checked = 0;
    let failed = 0;
    for (const event of events) {
      if (event.hmacKeyVersion === undefined) continue;
      checked++;
      const ctx = this.#hmacKeyRegistry.contextForVersion(
        event.hmacKeyVersion,
      );
      if (!ctx) {
        failed++;
        continue;
      }
      let fieldValid = true;
      if (!HMAC_HEX_PATTERN.test(event.resourceName)) {
        fieldValid = false;
      }
      if (event.detail !== undefined && !HMAC_HEX_PATTERN.test(event.detail)) {
        fieldValid = false;
      }
      if (
        event.methodName !== undefined &&
        !HMAC_HEX_PATTERN.test(event.methodName)
      ) {
        fieldValid = false;
      }
      if (
        event.decision?.resourceName !== undefined &&
        !HMAC_HEX_PATTERN.test(event.decision.resourceName)
      ) {
        fieldValid = false;
      }
      if (!fieldValid) {
        failed++;
      }
    }
    return { valid: failed === 0, checked, failed };
  }

  async *queryStream(
    filters: AuditStreamFilters,
  ): AsyncGenerator<ChainedAuditEvent[]> {
    const dates = dateRange(filters.since, filters.until);
    if (dates.length > MAX_DATE_RANGE_DAYS) {
      throw new Error(
        `Date range too wide: ${dates.length} days exceeds maximum of ${MAX_DATE_RANGE_DAYS}`,
      );
    }

    for (const date of dates) {
      const keys = await this.#store.list(`events/${date}/`);
      for (const key of keys) {
        const data = await this.#store.get(key);
        if (!data) continue;
        const text = new TextDecoder().decode(data);
        const batch: ChainedAuditEvent[] = [];
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as ChainedAuditEvent;
            if (matchesFilters(event, filters)) {
              batch.push(event);
            }
          } catch {
            // skip malformed lines
          }
        }
        if (batch.length > 0) {
          yield batch;
        }
      }
    }
  }
}
