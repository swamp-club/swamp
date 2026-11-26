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

import type {
  Fingerprint,
  FingerprintRuntime,
} from "../../domain/serve/fingerprint.ts";
import type { InstanceId } from "../../domain/serve/instance_id.ts";
import { CHECK_IN_INTERVAL_SECONDS } from "../../domain/serve/serve_member.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { runDetached } from "../../infrastructure/tracing/mod.ts";
import type { FederationHub } from "./federation_hub.ts";

const logger = getSwampLogger(["serve", "federation"]);

export interface HubSelfSeenOptions {
  readonly instanceId: InstanceId;
  /** read each beat, so a team change shows without collecting a fingerprint */
  readonly runtime: () => Promise<FingerprintRuntime>;
  readonly intervalMs?: number;
}

export interface HubSelfRecordOptions {
  readonly hub: Pick<FederationHub, "upsertSelf" | "recordSelfSeen">;
  /** this serve's fingerprint, runtime fields included */
  readonly fingerprint: () => Promise<Fingerprint>;
  /** the leader's own check-in; without it the hub has no last-seen time */
  readonly seen?: HubSelfSeenOptions;
}

/** the hub's own record and check-in; only the leader writes them, since losing the lead shuts a node down */
export class HubSelfRecord {
  readonly #hub: Pick<FederationHub, "upsertSelf" | "recordSelfSeen">;
  readonly #fingerprint: () => Promise<Fingerprint>;
  readonly #seen: HubSelfSeenOptions | undefined;
  #leading = false;
  #stopped = false;
  #pending: Promise<void> = Promise.resolve();
  #beat: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: HubSelfRecordOptions) {
    this.#hub = options.hub;
    this.#fingerprint = options.fingerprint;
    this.#seen = options.seen;
  }

  start(startWhenLeading: (start: () => void) => void): void {
    startWhenLeading(() => {
      if (this.#stopped) return;
      this.#leading = true;
      this.#pending = this.refresh();
      if (this.#seen === undefined) return;
      // queued behind the first record write, so the first beat finds the record
      this.beat().catch(() => {});
      const intervalMs = this.#seen.intervalMs ??
        CHECK_IN_INTERVAL_SECONDS * 1000;
      // armed detached so a beat never joins the trace that started serve
      const timer = runDetached(() =>
        setInterval(() => {
          this.beat().catch(() => {});
        }, intervalMs)
      );
      Deno.unrefTimer(timer);
      this.#timer = timer;
    });
  }

  get leading(): boolean {
    return this.#leading;
  }

  /** never rejects: a failed write is logged and the next refresh tries again */
  refresh(): Promise<void> {
    if (!this.#leading || this.#stopped) return Promise.resolve();
    const next = this.#pending.then(async () => {
      try {
        await this.#hub.upsertSelf(await this.#fingerprint());
      } catch (error) {
        logger.warn("Could not write the hub's own member record: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.#pending = next;
    return next;
  }

  /** one check-in of the leader; a beat while one is queued joins it */
  beat(): Promise<void> {
    const seen = this.#seen;
    if (!this.#leading || this.#stopped || seen === undefined) {
      return Promise.resolve();
    }
    if (this.#beat !== undefined) return this.#beat;
    const next = this.#pending.then(async () => {
      if (this.#stopped) return;
      try {
        await this.#hub.recordSelfSeen(seen.instanceId, await seen.runtime());
      } catch (error) {
        logger.warn("Could not record the hub's own check-in: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }).finally(() => {
      if (this.#beat === next) this.#beat = undefined;
    });
    this.#beat = next;
    this.#pending = next;
    return next;
  }

  /** queues no new write and drops a queued beat; a write in flight is awaited */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending;
  }

  settled(): Promise<void> {
    return this.#pending;
  }
}
