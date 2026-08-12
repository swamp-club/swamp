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

const logger = getSwampLogger(["serve", "token-gc"]);

export const DEFAULT_TOKEN_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_TOKEN_GC_GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

export interface TokenGcInfo {
  readonly name: string;
  readonly definitionId: string;
  readonly state: "active" | "expired" | "revoked";
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface ServerTokenGcDeps {
  readonly intervalMs: number;
  readonly gracePeriodMs: number;

  listTokens(): Promise<TokenGcInfo[]>;

  deleteTokenSecret(tokenName: string): Promise<void>;

  deleteOAuthAccessToken(tokenName: string): Promise<void>;

  deleteTokenData(definitionId: string, tokenName: string): Promise<void>;

  deleteDefinition(definitionId: string): Promise<void>;
}

export class ServerTokenGcService {
  readonly #deps: ServerTokenGcDeps;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #disposed = false;

  constructor(deps: ServerTokenGcDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#disposed) return;
    logger.info(
      "Starting server token GC service (interval: {interval}ms, grace period: {grace}ms)",
      {
        interval: this.#deps.intervalMs,
        grace: this.#deps.gracePeriodMs,
      },
    );
    this.#scheduleNext();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    while (this.#running) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async runOnce(): Promise<number> {
    return await this.#sweep();
  }

  #scheduleNext(): void {
    if (this.#disposed) return;
    this.#timer = setTimeout(() => {
      void this.#tick();
    }, this.#deps.intervalMs);
  }

  async #tick(): Promise<void> {
    if (this.#disposed) return;
    this.#running = true;
    try {
      await this.#sweep();
    } catch (err) {
      logger.error`Server token GC cycle failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      this.#running = false;
      this.#scheduleNext();
    }
  }

  async #sweep(): Promise<number> {
    const tokens = await this.#deps.listTokens();
    const now = Date.now();
    let gcCount = 0;

    for (const token of tokens) {
      if (this.#disposed) break;

      if (!this.#isGcEligible(token, now)) continue;

      try {
        await this.#gcToken(token);
        gcCount++;
      } catch (err) {
        logger.warn(
          "Failed to GC server token {name}, will retry next cycle: {error}",
          {
            name: token.name,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    if (gcCount > 0) {
      logger.info("GC'd {count} expired/revoked server token(s)", {
        count: gcCount,
      });
    }

    return gcCount;
  }

  #isGcEligible(token: TokenGcInfo, nowMs: number): boolean {
    if (token.state === "revoked") return true;

    const expiresAtMs = Date.parse(token.expiresAt);
    const effectivelyExpired = token.state === "expired" ||
      expiresAtMs <= nowMs;

    if (!effectivelyExpired) return false;

    return (nowMs - expiresAtMs) >= this.#deps.gracePeriodMs;
  }

  async #gcToken(token: TokenGcInfo): Promise<void> {
    try {
      await this.#deps.deleteTokenSecret(token.name);
    } catch (err) {
      logger.warn(
        "Failed to delete token secret for {name}: {error}",
        {
          name: token.name,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }

    try {
      await this.#deps.deleteOAuthAccessToken(token.name);
    } catch (err) {
      logger.warn(
        "Failed to delete OAuth access token for {name}: {error}",
        {
          name: token.name,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }

    await this.#deps.deleteTokenData(token.definitionId, token.name);
    await this.#deps.deleteDefinition(token.definitionId);
  }
}
