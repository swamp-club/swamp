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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "club-heartbeat"]);

export const DEFAULT_CLUB_HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;

export interface ClubHeartbeatDeps {
  readonly providerUrl: string;
  readonly oauthClientId: string;
  readonly intervalMs: number;

  getAccessToken(): Promise<string | null>;

  sendHeartbeat(
    providerUrl: string,
    accessToken: string,
    oauthClientId: string,
    signal: AbortSignal,
  ): Promise<{ heartbeatCount: number }>;
}

export class ClubHeartbeatService {
  readonly #deps: ClubHeartbeatDeps;
  #timer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;

  constructor(deps: ClubHeartbeatDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#disposed || this.#timer !== null) return;
    logger.info(
      "Starting swamp-club heartbeat (interval: {interval}ms, clientId: {clientId})",
      {
        interval: this.#deps.intervalMs,
        clientId: this.#deps.oauthClientId,
      },
    );
    this.#timer = setInterval(() => {
      this.#beat().catch((err) => {
        logger.warn("Club heartbeat failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.#deps.intervalMs);
    Deno.unrefTimer(this.#timer);
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#disposed = true;
  }

  async #beat(): Promise<void> {
    if (this.#disposed) return;

    const accessToken = await this.#deps.getAccessToken();
    if (!accessToken) {
      logger.warn(
        "No access token available for club heartbeat — skipping",
      );
      return;
    }

    const signal = AbortSignal.timeout(30_000);
    const result = await this.#deps.sendHeartbeat(
      this.#deps.providerUrl,
      accessToken,
      this.#deps.oauthClientId,
      signal,
    );
    logger.info(
      "Club heartbeat recorded (heartbeatCount: {count})",
      { count: result.heartbeatCount },
    );
  }
}
