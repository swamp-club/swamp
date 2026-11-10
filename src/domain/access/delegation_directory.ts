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

import { getLogger } from "@logtape/logtape";
import type {
  UnifiedDataRepository,
  UnreadableModelRecord,
} from "../data/repositories.ts";
import type { EventBus } from "../events/event_bus.ts";
import type { ModelCreated, ModelUpdated } from "../events/types.ts";
import {
  DELEGATION_DATA_NAME,
  DELEGATION_MODEL_TYPE,
  type DelegationRecord,
  DelegationSchema,
} from "../models/access/delegation_model.ts";
import { ModelType } from "../models/model_type.ts";
import {
  type DelegationStanding,
  delegationStanding,
  supersessionOf,
} from "./delegation.ts";

const logger = getLogger(["swamp", "domain", "access", "delegation-directory"]);

export const DELEGATION_RELOAD_RETRY_MS = 30_000;

export interface DelegationLookup {
  standingOf(id: string, nowMs?: number): DelegationStanding;
  recordOf(id: string): DelegationRecord | undefined;
}

export interface DelegationEnded {
  readonly id: string;
  readonly integrationId: string;
}

type Listener = (ended: readonly DelegationEnded[]) => void;
type PersonListener = (changed: readonly string[]) => void;

const PHASE_RANK: Record<DelegationRecord["phase"], number> = {
  awaiting_consent: 0,
  reporting: 1,
  consented: 2,
  issued: 3,
  suspended: 3,
  refused: 4,
  ended: 4,
};

/**
 * an ended or refused copy wins, so a stale copy can never hide an end; between
 * live copies the later phase, then the later write
 */
function combined(a: DelegationRecord, b: DelegationRecord): DelegationRecord {
  const rank = PHASE_RANK[b.phase] - PHASE_RANK[a.phase];
  if (rank !== 0) return rank > 0 ? b : a;
  return b.updatedAt > a.updatedAt ? b : a;
}

/** fails closed: until a load has read every record, every delegation is unknown */
export class DelegationDirectory implements DelegationLookup {
  readonly #dataRepo: UnifiedDataRepository;
  readonly #listeners = new Set<Listener>();
  readonly #personListeners = new Set<PersonListener>();
  readonly #unsubscribers: (() => void)[] = [];
  readonly #retryMs: number;
  readonly #now: () => number;
  #records: ReadonlyMap<string, DelegationRecord> = new Map();
  #unreadable: ReadonlySet<string> = new Set();
  #superseded: ReadonlyMap<string, string> = new Map();
  #whole = false;
  #reloads: Promise<void> = Promise.resolve();
  #retry: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  #lastFailure: string | undefined;

  constructor(
    dataRepo: UnifiedDataRepository,
    options: { eventBus?: EventBus; retryMs?: number; now?: () => number } = {},
  ) {
    this.#dataRepo = dataRepo;
    this.#retryMs = options.retryMs ?? DELEGATION_RELOAD_RETRY_MS;
    this.#now = options.now ?? Date.now;
    const bus = options.eventBus;
    if (!bus) return;
    const onEvent = (event: ModelCreated | ModelUpdated) => {
      if (event.modelType === DELEGATION_MODEL_TYPE.normalized) {
        this.#reloads = this.#reloads.then(() => this.#reload());
      }
    };
    this.#unsubscribers.push(
      bus.subscribe<ModelCreated>("ModelCreated", onEvent),
      bus.subscribe<ModelUpdated>("ModelUpdated", onEvent),
    );
  }

  get known(): boolean {
    return this.#whole;
  }

  standingOf(id: string, nowMs: number = this.#now()): DelegationStanding {
    if (!this.#whole) return { kind: "unknown" };
    if (this.#unreadable.has(id)) return { kind: "unreadable" };
    return delegationStanding(
      this.#records.get(id),
      nowMs,
      this.#superseded.get(id),
    );
  }

  recordOf(id: string): DelegationRecord | undefined {
    return this.#whole ? this.#records.get(id) : undefined;
  }

  supersededBy(id: string): string | undefined {
    return this.#superseded.get(id);
  }

  /** every record read, for the link service and operator commands */
  all(): readonly DelegationRecord[] {
    return [...this.#records.values()];
  }

  onEnded(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** standing delegations whose person snapshot changed, for admission to check again */
  onPersonChanged(listener: PersonListener): () => void {
    this.#personListeners.add(listener);
    return () => this.#personListeners.delete(listener);
  }

  /** resolves once a load started after this call has finished; never rejects */
  reload(): Promise<void> {
    this.#reloads = this.#reloads.then(() => this.#reload());
    return this.#reloads;
  }

  /** read as a poller's target; it retries its own failures */
  get unreadable(): readonly never[] {
    return [];
  }

  async load(): Promise<void> {
    await this.reload();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    clearTimeout(this.#retry);
    await this.#reloads;
    clearTimeout(this.#retry);
  }

  async #reload(): Promise<void> {
    if (this.#disposed) return;
    clearTimeout(this.#retry);
    this.#retry = undefined;
    let read: {
      records: Map<string, DelegationRecord>;
      unreadable: Set<string>;
    };
    try {
      read = await this.#read();
    } catch (error) {
      this.#whole = false;
      this.#reportFailure(error);
      this.#retry = setTimeout(() => {
        this.#reloads = this.#reloads.then(() => this.#reload());
      }, this.#retryMs);
      return;
    }
    this.#lastFailure = undefined;
    const nowMs = this.#now();
    const before = this.#whole
      ? [...this.#records.keys()].filter((id) =>
        this.standingOf(id, nowMs).kind === "standing"
      )
      : [];
    const persons = new Map(
      before.map((id) => [id, JSON.stringify(this.#records.get(id)?.person)]),
    );
    this.#records = read.records;
    this.#unreadable = read.unreadable;
    this.#superseded = supersessionOf([...read.records.values()]);
    this.#whole = true;
    const ended = before
      .filter((id) => this.standingOf(id, nowMs).kind !== "standing")
      .map((id) => ({
        id,
        integrationId: this.#records.get(id)?.integrationId ?? "",
      }));
    const changed = before.filter((id) =>
      this.standingOf(id, nowMs).kind === "standing" &&
      JSON.stringify(this.#records.get(id)?.person) !== persons.get(id)
    );
    if (ended.length > 0) {
      for (const listener of this.#listeners) {
        try {
          listener(ended);
        } catch (error) {
          logger.error`A delegation change listener failed: ${error}`;
        }
      }
    }
    if (changed.length > 0) {
      for (const listener of this.#personListeners) {
        try {
          listener(changed);
        } catch (error) {
          logger.error`A delegation person listener failed: ${error}`;
        }
      }
    }
  }

  #reportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message === this.#lastFailure) return;
    this.#lastFailure = message;
    logger
      .error`Could not read every delegation record, so every delegated token is refused until one load succeeds: ${message}`;
  }

  async #read(): Promise<
    { records: Map<string, DelegationRecord>; unreadable: Set<string> }
  > {
    const unreadableRecords: UnreadableModelRecord[] = [];
    const items = [
      ...await this.#dataRepo.findAllForType(DELEGATION_MODEL_TYPE, {
        unreadable: unreadableRecords,
      }),
      ...await this.#orphaned(unreadableRecords),
    ];
    const failed = unreadableRecords.filter((record) =>
      record.dataName === undefined || record.dataName === DELEGATION_DATA_NAME
    );
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} delegation record(s) could not be read`,
      );
    }
    const records = new Map<string, DelegationRecord>();
    const unreadable = new Set<string>();
    for (const { data, modelType, modelId } of items) {
      if (data.name !== DELEGATION_DATA_NAME) continue;
      const content = await this.#dataRepo.getContent(
        modelType,
        modelId,
        data.name,
      );
      // its copy may be the end, so a record with no content fails the load
      if (!content) {
        throw new Error(`Delegation record ${modelId} has no content`);
      }
      const attrs: unknown = JSON.parse(new TextDecoder().decode(content));
      const parsed = DelegationSchema.safeParse(attrs);
      if (!parsed.success) {
        const claimed = (attrs as { id?: unknown } | null)?.id;
        if (typeof claimed !== "string") {
          throw new Error(`Delegation record ${modelId} names no delegation`);
        }
        logger
          .error`Delegation record ${modelId} is invalid, so ${claimed} is refused`;
        unreadable.add(claimed);
        continue;
      }
      const seen = records.get(parsed.data.id);
      records.set(
        parsed.data.id,
        seen ? combined(seen, parsed.data) : parsed.data,
      );
    }
    return { records, unreadable };
  }

  async #orphaned(unreadable: UnreadableModelRecord[]) {
    try {
      return await this.#dataRepo.findAllForType(
        ModelType.create(`@${DELEGATION_MODEL_TYPE.normalized}`),
        { unreadable },
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  }
}
