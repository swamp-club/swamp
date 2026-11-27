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
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import {
  HubLink,
  type HubLinkInstance,
  HubLinkInstanceSchema,
} from "../../domain/serve/hub_link.ts";
import { InstanceId } from "../../domain/serve/instance_id.ts";

// the link cannot sit at federation/link: a filesystem store keeps a key as a
// file, and federation/link/instances/ needs that name as a directory
export const HUB_LINK_KEY = "federation/link/record";
export const HUB_LINK_INSTANCES_PREFIX = "federation/link/instances/";
export const JOIN_CLAIM_KEY = "federation/member/join-claim";
export const JOIN_CLAIM_STALE_MS = 2 * 60 * 1000;
/** an instance record unseen this long is pruned */
export const HUB_LINK_INSTANCE_TTL_MS = 24 * 60 * 60 * 1000;

const JoinClaimSchema = z.object({
  instanceId: z.string(),
  claimedAt: z.string(),
}).strict();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

function instanceKey(instanceId: string): string {
  return `${HUB_LINK_INSTANCES_PREFIX}${InstanceId.create(instanceId).value}`;
}

/** a member's link records in its control-plane store; only a joining link holds its joinId */
export class HubLinkStore {
  readonly #store: ControlPlaneStore;
  readonly #now: () => number;

  constructor(store: ControlPlaneStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  /** unjoined when no link is stored; a record that does not parse rejects */
  async readLink(): Promise<HubLink> {
    const bytes = await this.#store.get(HUB_LINK_KEY);
    return bytes === null
      ? HubLink.unjoined()
      : HubLink.fromJSON(decode(bytes));
  }

  async writeLink(link: HubLink): Promise<void> {
    if (link.state === "unjoined") {
      await this.#store.delete(HUB_LINK_KEY);
      return;
    }
    await this.#store.put(HUB_LINK_KEY, encode(link.toJSON()));
  }

  async writeInstance(instance: HubLinkInstance): Promise<void> {
    const parsed = HubLinkInstanceSchema.parse(instance);
    await this.#store.put(instanceKey(parsed.instanceId), encode(parsed));
  }

  async readInstance(instanceId: string): Promise<HubLinkInstance | undefined> {
    const bytes = await this.#store.get(instanceKey(instanceId));
    if (bytes === null) return undefined;
    return parseInstance(bytes);
  }

  /** every readable instance record; one that does not parse is skipped */
  async listInstances(): Promise<HubLinkInstance[]> {
    const instances: HubLinkInstance[] = [];
    for (const key of await this.#store.list(HUB_LINK_INSTANCES_PREFIX)) {
      const bytes = await this.#store.get(key);
      if (bytes === null) continue;
      const instance = parseInstance(bytes);
      if (instance !== undefined) instances.push(instance);
    }
    return instances.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** removes stale or unreadable instance records, never the caller's own */
  async pruneInstances(ownInstanceId: string): Promise<number> {
    const now = this.#now();
    let pruned = 0;
    for (const key of await this.#store.list(HUB_LINK_INSTANCES_PREFIX)) {
      if (key === instanceKey(ownInstanceId)) continue;
      const bytes = await this.#store.get(key);
      if (bytes === null) continue;
      const instance = parseInstance(bytes);
      if (
        instance === undefined ||
        now - Date.parse(instance.aliveAt) > HUB_LINK_INSTANCE_TTL_MS
      ) {
        await this.#store.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * true when this instance holds the one join claim: taken when absent, or
   * over from one that is unreadable or older than two minutes
   */
  async claimJoin(instanceId: string): Promise<boolean> {
    const id = InstanceId.create(instanceId).value;
    const claim = encode({
      instanceId: id,
      claimedAt: new Date(this.#now()).toISOString(),
    });
    if (await this.#createIfAbsent(claim, id)) return true;
    const current = await this.#readClaim();
    if (current?.instanceId === id) return true;
    const stale = current === undefined ||
      this.#now() - Date.parse(current.claimedAt) > JOIN_CLAIM_STALE_MS;
    if (!stale) return false;
    await this.#store.delete(JOIN_CLAIM_KEY);
    if (!await this.#createIfAbsent(claim, id)) return false;
    // another node may have deleted and taken the claim between our steps
    return (await this.#readClaim())?.instanceId === id;
  }

  async releaseJoin(instanceId: string): Promise<void> {
    const current = await this.#readClaim();
    if (current?.instanceId === InstanceId.create(instanceId).value) {
      await this.#store.delete(JOIN_CLAIM_KEY);
    }
  }

  async clear(): Promise<void> {
    await this.#store.delete(HUB_LINK_KEY);
    for (const key of await this.#store.list(HUB_LINK_INSTANCES_PREFIX)) {
      await this.#store.delete(key);
    }
    await this.#store.delete(JOIN_CLAIM_KEY);
  }

  async #createIfAbsent(claim: Uint8Array, id: string): Promise<boolean> {
    if (this.#store.putIfAbsent !== undefined) {
      return await this.#store.putIfAbsent(JOIN_CLAIM_KEY, claim);
    }
    // a store without putIfAbsent: put and read back, as the vault key bootstrap does
    if (await this.#store.get(JOIN_CLAIM_KEY) !== null) return false;
    await this.#store.put(JOIN_CLAIM_KEY, claim);
    return (await this.#readClaim())?.instanceId === id;
  }

  async #readClaim(): Promise<z.infer<typeof JoinClaimSchema> | undefined> {
    const bytes = await this.#store.get(JOIN_CLAIM_KEY);
    if (bytes === null) return undefined;
    try {
      return JoinClaimSchema.parse(decode(bytes));
    } catch {
      return undefined;
    }
  }
}

/** what a member serve exposes to federation.link.get */
export interface FederationMemberLink {
  readonly links: HubLinkStore;
  readonly configuredHubUrl: string;
}

function parseInstance(bytes: Uint8Array): HubLinkInstance | undefined {
  try {
    return HubLinkInstanceSchema.parse(decode(bytes));
  } catch {
    return undefined;
  }
}
