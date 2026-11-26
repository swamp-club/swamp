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

import type { Fingerprint } from "../../domain/serve/fingerprint.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { FederationHub } from "./federation_hub.ts";

const logger = getSwampLogger(["serve", "federation"]);

export interface HubSelfRecordOptions {
  readonly hub: Pick<FederationHub, "upsertSelf">;
  /** this serve's fingerprint, runtime fields included */
  readonly fingerprint: () => Promise<Fingerprint>;
}

/**
 * the hub's own member record; only the leading node writes it, since a node
 * that loses the lead shuts down and a follower's reload never refreshes it
 */
export class HubSelfRecord {
  readonly #hub: Pick<FederationHub, "upsertSelf">;
  readonly #fingerprint: () => Promise<Fingerprint>;
  #leading = false;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: HubSelfRecordOptions) {
    this.#hub = options.hub;
    this.#fingerprint = options.fingerprint;
  }

  start(startWhenLeading: (start: () => void) => void): void {
    startWhenLeading(() => {
      this.#leading = true;
      this.#pending = this.refresh();
    });
  }

  get leading(): boolean {
    return this.#leading;
  }

  /** never rejects: a failed write is logged and the next refresh tries again */
  refresh(): Promise<void> {
    if (!this.#leading) return Promise.resolve();
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

  settled(): Promise<void> {
    return this.#pending;
  }
}
