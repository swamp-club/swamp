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

import { runDetached } from "../infrastructure/tracing/mod.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { InstanceNotRegisteredError } from "./oauth_client.ts";

const logger = getSwampLogger(["serve", "club-heartbeat"]);

export const DEFAULT_CLUB_HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;
const CLUB_CALL_TIMEOUT_MS = 30_000;

export interface ClubHeartbeatDeps {
  readonly providerUrl: string;
  readonly oauthClientId: string;
  readonly instanceId: string;
  readonly intervalMs: number;

  getAccessToken(): Promise<string | null>;

  sendHeartbeat(
    providerUrl: string,
    accessToken: string,
    oauthClientId: string,
    instanceId: string,
    signal: AbortSignal,
  ): Promise<{ heartbeatCount: number }>;

  /** registers this process again, with the request it registered at boot */
  reregister(accessToken: string, signal: AbortSignal): Promise<unknown>;
}

export class ClubHeartbeatService {
  readonly #deps: ClubHeartbeatDeps;
  #timer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;
  readonly #inFlight = new Set<AbortController>();

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
    this.#timer = runDetached(() =>
      setInterval(() => {
        this.#beat().catch((err) => {
          if (this.#disposed) return;
          logger.warn("Club heartbeat failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.#deps.intervalMs)
    );
    Deno.unrefTimer(this.#timer);
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#disposed = true;
    for (const controller of this.#inFlight) controller.abort();
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
    if (this.#disposed) return;

    const controller = new AbortController();
    this.#inFlight.add(controller);
    const callSignal = () =>
      AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(CLUB_CALL_TIMEOUT_MS),
      ]);
    try {
      let result: { heartbeatCount: number };
      try {
        result = await this.#deps.sendHeartbeat(
          this.#deps.providerUrl,
          accessToken,
          this.#deps.oauthClientId,
          this.#deps.instanceId,
          callSignal(),
        );
      } catch (err) {
        if (!(err instanceof InstanceNotRegisteredError)) throw err;
        await this.#reregister(accessToken, callSignal());
        return;
      }
      logger.info(
        "Club heartbeat recorded (heartbeatCount: {count})",
        { count: result.heartbeatCount },
      );
    } finally {
      this.#inFlight.delete(controller);
    }
  }

  // one attempt per beat, so a registration swamp-club keeps refusing is
  // retried once an interval and never in a loop
  async #reregister(accessToken: string, signal: AbortSignal): Promise<void> {
    logger.info(
      "swamp-club has no registration for this serve instance, registering again (instanceId: {instanceId})",
      { instanceId: this.#deps.instanceId },
    );
    try {
      await this.#deps.reregister(accessToken, signal);
    } catch (err) {
      if (this.#disposed) return;
      logger.warn(
        "Re-registering serve instance with swamp-club failed, will retry at the next heartbeat: {error}",
        { error: err instanceof Error ? err.message : String(err) },
      );
      return;
    }
    logger.info(
      "Re-registered serve instance with swamp-club (instanceId: {instanceId})",
      { instanceId: this.#deps.instanceId },
    );
  }
}
