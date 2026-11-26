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

import { runDetached } from "../../infrastructure/tracing/mod.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { CHECK_IN_INTERVAL_SECONDS } from "../../domain/serve/serve_member.ts";
import type { FederationHub, SweepReport } from "./federation_hub.ts";

const logger = getSwampLogger(["serve", "federation", "sweeper"]);

export interface MemberStatusSweeperOptions {
  readonly hub: Pick<FederationHub, "sweep">;
  readonly intervalMs?: number;
}

/** marks members stale and offline from their check-ins; started only on the leader */
export class MemberStatusSweeper {
  readonly #hub: Pick<FederationHub, "sweep">;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<SweepReport | undefined> | undefined;
  #stopped = false;

  constructor(options: MemberStatusSweeperOptions) {
    this.#hub = options.hub;
    this.#intervalMs = options.intervalMs ?? CHECK_IN_INTERVAL_SECONDS * 1000;
  }

  start(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    // armed detached so a pass never joins the trace that started serve
    const timer = runDetached(() =>
      setInterval(() => {
        this.tick().catch(() => {});
      }, this.#intervalMs)
    );
    Deno.unrefTimer(timer);
    this.#timer = timer;
  }

  /** one pass; a tick while one runs joins it rather than stacking another */
  tick(): Promise<SweepReport | undefined> {
    if (this.#stopped) return Promise.resolve(undefined);
    if (this.#inFlight !== undefined) return this.#inFlight;
    const pass = this.#hub.sweep().catch((error) => {
      logger.warn("The member status sweep failed: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }).finally(() => {
      this.#inFlight = undefined;
    });
    this.#inFlight = pass;
    return pass;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }
}
