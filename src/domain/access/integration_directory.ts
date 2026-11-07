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
import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { UnreadableModelRecord } from "../data/repositories.ts";
import type { EventBus } from "../events/event_bus.ts";
import type { ModelCreated, ModelUpdated } from "../events/types.ts";
import {
  INTEGRATION_DATA_NAME,
  INTEGRATION_MODEL_TYPE,
  IntegrationSchema,
} from "../models/access/integration_model.ts";
import { ModelType } from "../models/model_type.ts";
import { Ceiling } from "./ceiling.ts";

const logger = getLogger([
  "swamp",
  "domain",
  "access",
  "integration-directory",
]);

export const INTEGRATION_RELOAD_RETRY_MS = 30_000;

export type IntegrationStanding =
  | { readonly kind: "active"; readonly ceiling: Ceiling }
  | { readonly kind: "revoked" }
  | { readonly kind: "unknown" };

export interface IntegrationLookup {
  standingOf(id: string): IntegrationStanding;
}

/** an integration lost rights, so sessions opened under the old ones must go */
export interface IntegrationNarrowed {
  readonly id: string;
  readonly reason: "revoked" | "narrowed";
}

type Listener = (changes: readonly IntegrationNarrowed[]) => void;

const UNKNOWN: IntegrationStanding = { kind: "unknown" };

const REVOKED: IntegrationStanding = { kind: "revoked" };

function combined(
  a: IntegrationStanding,
  b: IntegrationStanding,
): IntegrationStanding {
  if (a.kind === "revoked" || b.kind === "revoked") return REVOKED;
  if (
    a.kind === "active" && b.kind === "active" && a.ceiling.equals(b.ceiling)
  ) {
    return a;
  }
  // copies that disagree may be hiding a revoke
  return UNKNOWN;
}

/** fails closed: until a load has read every record, every integration is unknown */
export class IntegrationDirectory implements IntegrationLookup {
  readonly #dataRepo: UnifiedDataRepository;
  readonly #listeners = new Set<Listener>();
  readonly #unsubscribers: (() => void)[] = [];
  readonly #retryMs: number;
  #entries: ReadonlyMap<string, IntegrationStanding> = new Map();
  #whole = false;
  #lastGood: ReadonlyMap<string, IntegrationStanding> | undefined;
  #reloads: Promise<void> = Promise.resolve();
  #retry: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  #lastFailure: string | undefined;

  constructor(
    dataRepo: UnifiedDataRepository,
    options: { eventBus?: EventBus; retryMs?: number } = {},
  ) {
    this.#dataRepo = dataRepo;
    this.#retryMs = options.retryMs ?? INTEGRATION_RELOAD_RETRY_MS;
    const bus = options.eventBus;
    if (!bus) return;
    const onEvent = (event: ModelCreated | ModelUpdated) => {
      if (event.modelType === INTEGRATION_MODEL_TYPE.normalized) {
        this.#reloads = this.#reloads.then(() => this.#reload());
      }
    };
    // in both grant reload modes; a workflow step publishes no such event, so a
    // commit effect or the poller covers that
    this.#unsubscribers.push(
      bus.subscribe<ModelCreated>("ModelCreated", onEvent),
      bus.subscribe<ModelUpdated>("ModelUpdated", onEvent),
    );
  }

  get known(): boolean {
    return this.#whole;
  }

  standingOf(id: string): IntegrationStanding {
    if (!this.#whole) return UNKNOWN;
    return this.#entries.get(id) ?? UNKNOWN;
  }

  onNarrowed(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
    let entries: Map<string, IntegrationStanding>;
    try {
      entries = await this.#read();
    } catch (error) {
      this.#whole = false;
      this.#reportFailure(error);
      this.#retry = setTimeout(() => {
        this.#reloads = this.#reloads.then(() => this.#reload());
      }, this.#retryMs);
      return;
    }
    this.#lastFailure = undefined;
    const narrowed = this.#narrowedSince(entries);
    this.#entries = entries;
    this.#lastGood = entries;
    this.#whole = true;
    if (narrowed.length === 0) return;
    for (const listener of this.#listeners) {
      try {
        listener(narrowed);
      } catch (error) {
        logger.error`An integration change listener failed: ${error}`;
      }
    }
  }

  #reportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message === this.#lastFailure) return;
    this.#lastFailure = message;
    logger
      .error`Could not read every integration record, so every integration token is refused until one load succeeds: ${message}`;
  }

  #narrowedSince(
    entries: ReadonlyMap<string, IntegrationStanding>,
  ): IntegrationNarrowed[] {
    const previous = this.#lastGood;
    if (previous === undefined) return [];
    const narrowed: IntegrationNarrowed[] = [];
    for (const [id, was] of previous) {
      if (was.kind !== "active") continue;
      const now = entries.get(id) ?? UNKNOWN;
      if (now.kind === "revoked") {
        narrowed.push({ id, reason: "revoked" });
      } else if (now.kind !== "active") {
        narrowed.push({ id, reason: "narrowed" });
      } else if (!was.ceiling.isWithin(now.ceiling)) {
        // something the old ceiling allowed isn't allowed now
        narrowed.push({ id, reason: "narrowed" });
      }
    }
    return narrowed;
  }

  async #read(): Promise<Map<string, IntegrationStanding>> {
    const unreadable: UnreadableModelRecord[] = [];
    const type = INTEGRATION_MODEL_TYPE;
    const items = [
      ...await this.#dataRepo.findAllForType(type, { unreadable }),
      ...await this.#orphaned(unreadable),
    ];
    const failed = unreadable.filter((record) =>
      record.dataName === undefined ||
      record.dataName === INTEGRATION_DATA_NAME
    );
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} integration record(s) could not be read`,
      );
    }
    const entries = new Map<string, IntegrationStanding>();
    for (const { data, modelType, modelId } of items) {
      if (data.name !== INTEGRATION_DATA_NAME) continue;
      const content = await this.#dataRepo.getContent(
        modelType,
        modelId,
        data.name,
      );
      // its copy may be the revoke, so a record with no content fails the load
      if (!content) {
        throw new Error(`Integration record ${modelId} has no content`);
      }
      const { id, standing } = this.#parse(content, modelId);
      const seen = entries.get(id);
      entries.set(id, seen ? combined(seen, standing) : standing);
    }
    return entries;
  }

  async #orphaned(unreadable: UnreadableModelRecord[]) {
    try {
      return await this.#dataRepo.findAllForType(
        ModelType.create(`@${INTEGRATION_MODEL_TYPE.normalized}`),
        { unreadable },
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  }

  /** a record that names itself but can't be read refuses only that integration */
  #parse(
    content: Uint8Array,
    modelId: string,
  ): { id: string; standing: IntegrationStanding } {
    const attrs: unknown = JSON.parse(new TextDecoder().decode(content));
    const parsed = IntegrationSchema.safeParse(attrs);
    if (!parsed.success) {
      const claimed = (attrs as { id?: unknown } | null)?.id;
      if (typeof claimed !== "string") {
        throw new Error(`Integration record ${modelId} names no integration`);
      }
      logger
        .error`Integration record ${modelId} is invalid, so ${claimed} is refused`;
      return { id: claimed, standing: UNKNOWN };
    }
    if (parsed.data.state === "revoked") {
      return { id: parsed.data.id, standing: REVOKED };
    }
    try {
      return {
        id: parsed.data.id,
        standing: {
          kind: "active",
          ceiling: Ceiling.parse(parsed.data.ceiling),
        },
      };
    } catch (error) {
      logger
        .error`Integration ${parsed.data.id} has a ceiling this build can't read, so it is refused: ${error}`;
      return { id: parsed.data.id, standing: UNKNOWN };
    }
  }
}
